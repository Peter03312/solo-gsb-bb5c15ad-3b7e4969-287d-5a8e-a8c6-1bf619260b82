'use strict';

const archiver = require('archiver');

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function round(v, n = 4) {
  const f = 10 ** n;
  return Math.round(v * f) / f;
}

// 单份报告的测量 CSV（UTF-8 BOM，便于 Excel 直接打开）
function buildReportCsv(report) {
  const calib = report.calib;
  const header = [
    '报告ID', '报告标题', '图片文件名', '图片宽(px)', '图片高(px)',
    '定标点1 X(px)', '定标点1 Y(px)', '定标点2 X(px)', '定标点2 Y(px)',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ];
  const rows = [header];
  const c = calib || {};
  const base = [
    report.id, report.title, report.filename, report.width, report.height,
    c.p1 ? round(c.p1.x, 2) : '', c.p1 ? round(c.p1.y, 2) : '',
    c.p2 ? round(c.p2.x, 2) : '', c.p2 ? round(c.p2.y, 2) : '',
    c.distanceUm ?? '', c.scale ? round(c.scale, 6) : ''
  ];
  for (const cell of report.cells) {
    rows.push([
      ...base,
      cell.name || '',
      (cell.holes || []).length,
      round(cell.areaUm2),
      round(cell.perimeterUm)
    ]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 多份报告汇总 CSV
function buildCombinedCsv(reports) {
  const rows = [[
    '报告ID', '报告标题', '发布时间', '草稿版本', '图片文件名',
    '标定距离(μm)', '每像素微米(μm/px)',
    '细胞名称', '孔洞数', '面积(μm²)', '含孔洞边界总周长(μm)'
  ]];
  for (const report of reports) {
    const c = report.calib || {};
    for (const cell of report.cells) {
      rows.push([
        report.id, report.title, report.createdAt, report.draftVersion, report.filename,
        c.distanceUm ?? '', c.scale ? round(c.scale, 6) : '',
        cell.name || '', (cell.holes || []).length,
        round(cell.areaUm2), round(cell.perimeterUm)
      ]);
    }
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 多份报告 ZIP 导出（流式）：按选中顺序逐份渲染标注 PNG、立即写入 ZIP 流，
// 等该份条目被压缩消费后再渲染下一份——任意时刻内存中至多约一份 PNG 缓存，
// 峰值不随报告份数增长。条目名称/内容/顺序、ZIP 文件名、汇总 CSV 与 zlib 级别
// 均与原有实现一致；数据仍来自各报告发布时的冻结快照。
// renderPng：async (report) => Buffer，渲染单份报告的标注 PNG。
async function streamZip(reports, renderPng, res) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const names = new Set();
  const uniq = (n) => {
    let name = n; let k = 1;
    while (names.has(name)) name = n.replace(/(\.[^.]*)?$/, `_${k}$1`), k++;
    names.add(name);
    return name;
  };

  let clientGone = false; // 浏览器取消下载：连接在响应正常结束前被关闭
  let failed = false;     // 渲染/压缩失败：已中止响应
  let entriesDone = 0;    // 已被压缩模块消费的条目数（archiver entry 事件计数）
  let waiter = null;
  const wake = () => { const w = waiter; waiter = null; if (w) w(); };
  const stopArchive = () => {
    try { archive.unpipe(res); } catch { /* 清理阶段的异常忽略 */ }
    try { archive.abort(); } catch { /* 清理阶段的异常忽略 */ }
  };

  // 客户端断开（取消下载）：停止后续生成并释放压缩资源
  res.on('close', () => {
    if (!res.writableFinished) {
      clientGone = true;
      stopArchive();
      wake();
    }
  });

  const fail = (err) => {
    if (failed || clientGone || res.writableFinished) return;
    failed = true;
    stopArchive();
    // 已开始传输：销毁连接中止下载，绝不交付「状态成功但内容残缺」的 ZIP；
    // 尚未写出任何字节（首份渲染即失败）时才能回 JSON 错误
    if (res.headersSent) res.destroy();
    else res.status(500).json({ error: `导出失败：${err.message}` });
    wake();
  };
  archive.on('error', fail);
  archive.on('entry', () => { entriesDone += 1; wake(); });

  // 等第 target 个条目被压缩消费后再继续：PNG 缓存随渲染逐份产生、逐份释放
  const waitEntries = (target) => new Promise((resolve) => {
    const check = () => {
      if (entriesDone >= target || clientGone || failed) resolve();
      else waiter = check;
    };
    check();
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="reports.zip"');
  archive.pipe(res);

  try {
    const combined = [];
    for (const r of reports) {
      if (clientGone || failed) return;
      let png;
      try {
        png = await renderPng(r); // 一次只渲染一份报告的标注 PNG
      } catch (e) {
        fail(new Error(`报告《${r.title || r.id}》标注图片生成失败：${e.message}`));
        return;
      }
      if (clientGone || failed) return;
      const base = uniq(`${r.title || r.id}`.replace(/[\\/:*?"<>|]+/g, '_'));
      const target = entriesDone + 2;
      archive.append(png, { name: `${base}_标注.png` });
      archive.append(buildReportCsv(r), { name: `${base}_测量.csv` });
      png = null; // 本份 PNG 缓存交予压缩流；条目被消费后即可回收
      combined.push(r);
      await waitEntries(target);
    }
    if (clientGone || failed) return;
    archive.append(buildCombinedCsv(combined), { name: '汇总_测量.csv' });
    await archive.finalize();
  } catch (e) {
    fail(e);
  }
}

// 比较记录 CSV：与页面结构一致——两侧定标信息、配对细胞（两侧数值/带符号差值/相对基线变化率）、
// 基线未配对、复测未配对。基线值为 0 时变化率列写「不可计算」。
function buildComparisonCsv(view) {
  const rows = [];
  const push = (r) => rows.push(r);

  push(['比较记录ID', view.id, '比较记录标题', view.title, '比较记录版本', `v${view.version}`]);
  push(['创建时间', view.createdAt, '最后修改时间', view.updatedAt, '', '']);
  push([]);

  push(['侧别', '报告ID', '报告标题', '图片文件名', '图片宽(px)', '图片高(px)',
        '发布时草稿版本', '发布时间', '标定距离(μm)', '每像素微米(μm/px)', '细胞数']);
  for (const s of [view.baseline, view.retest]) {
    const c = s.calib || {};
    push([
      s.side === 'baseline' ? '基线' : '复测',
      s.reportId, s.title, s.filename, s.width, s.height,
      `v${s.draftVersion}`, s.createdAt,
      c.distanceUm ?? '', s.scaleText, s.cellCount
    ]);
  }
  push([]);

  push(['配对细胞']);
  push(['序号', '基线细胞', '基线孔洞数', '复测细胞', '复测孔洞数',
        '基线净面积(μm²)', '复测净面积(μm²)', '净面积差值(μm²)', '净面积相对基线变化率',
        '基线总周长(μm)', '复测总周长(μm)', '总周长差值(μm)', '总周长相对基线变化率']);
  if (!view.paired.length) {
    push(['（无配对细胞）']);
  }
  view.paired.forEach((p, i) => {
    push([
      i + 1,
      p.baselineName, p.holesBaseline, p.retestName, p.holesRetest,
      p.metrics.area.baselineText, p.metrics.area.retestText,
      p.metrics.area.deltaText, p.metrics.area.rateText,
      p.metrics.perimeter.baselineText, p.metrics.perimeter.retestText,
      p.metrics.perimeter.deltaText, p.metrics.perimeter.rateText
    ]);
  });
  push([]);

  push(['基线侧未配对细胞']);
  push(['细胞', '孔洞数', '净面积(μm²)', '总周长(μm)']);
  if (!view.unpairedBaseline.length) push(['（无）']);
  view.unpairedBaseline.forEach((c) => push([c.name, c.holes, c.areaText, c.perimeterText]));
  push([]);

  push(['复测侧未配对细胞']);
  push(['细胞', '孔洞数', '净面积(μm²)', '总周长(μm)']);
  if (!view.unpairedRetest.length) push(['（无）']);
  view.unpairedRetest.forEach((c) => push([c.name, c.holes, c.areaText, c.perimeterText]));

  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// 取样视野统计 CSV：与报告页表格同一冻结结果（同一组展示文本）。
// 旧报告缺少视野时 fieldStats 为空列表，仅输出表头。
function buildFieldStatsCsv(report) {
  const c = report.calib || {};
  const rows = [[
    '报告ID', '报告标题', '图片文件名', '发布时间', '发布时草稿版本',
    '标定距离(μm)', '每像素微米(μm/px)'
  ], [
    report.id, report.title, report.filename, report.createdAt, `v${report.draftVersion}`,
    c.distanceUm ?? '', c.scale ? round(c.scale, 6) : ''
  ], []];

  rows.push(['视野名称', '孔洞数', '净面积(mm²)', '细胞数', '细胞密度(个/mm²)', '计入细胞净面积总和(mm²)']);
  const stats = Array.isArray(report.fieldStats) ? report.fieldStats : [];
  if (!stats.length) rows.push(['（无取样视野）']);
  for (const s of stats) {
    rows.push([s.name, s.holes, s.areaText, s.cellCount, s.densityText, s.countedCellAreaText]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

module.exports = { buildReportCsv, buildCombinedCsv, buildComparisonCsv, buildFieldStatsCsv, streamZip };
