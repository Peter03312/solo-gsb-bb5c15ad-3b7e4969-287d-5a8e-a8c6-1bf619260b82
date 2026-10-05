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

// 多份报告的 ZIP：按所选顺序逐份生成标注 PNG、写入压缩流后立即释放该份 PNG 缓存，
// 任何时刻内存中至多保留当前一份 PNG（压缩由 archiver 的 1MB 内部缓冲背压），
// 峰值 PNG 缓存不随报告份数增长。renderPng(report) 由调用方提供，数据取报告发布时
// 的冻结快照。所有请求合法性（空选择/超上限/格式/报告不存在）必须在调用前校验完毕。
//
// 传输期失败语义：PNG 生成或压缩出错 → abort 归档并 destroy 响应，不产出残缺 ZIP；
// 浏览器取消下载（res 'close'）→ 中止后续生成并释放资源。
// onArchive 为可选观测钩子（传入创建好的 archive），供调用方挂进度/日志监听。
async function streamZip(reports, renderPng, res, onArchive = null) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  if (typeof onArchive === 'function') onArchive(archive);
  const names = new Set();
  const uniq = (n) => {
    let name = n; let k = 1;
    while (names.has(name)) name = n.replace(/(\.[^.]*)?$/, `_${k}$1`), k++;
    names.add(name);
    return name;
  };

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="reports.zip"');

  let stopped = false;
  let stopReason = null;
  const activeEntryListeners = new Set();
  const stop = (reason) => {
    if (stopped) return;
    stopped = true;
    stopReason = reason || null;
    archive.abort();
    // 解除所有等待 'entry' 的 gate（abort 后队列中条目不再产生 'entry'）
    for (const fn of activeEntryListeners) {
      archive.removeListener('entry', fn);
      fn();
    }
    activeEntryListeners.clear();
    if (!res.destroyed) res.destroy(reason instanceof Error ? reason : undefined);
  };
  // 压缩期错误（含 PNG 已入队后的压缩错误）：中止响应，不能交付残缺 ZIP
  archive.on('error', (err) => stop(err));
  // 浏览器取消下载：关闭且未正常写完即中止（destroy() 会先置位 destroyed 再触发 close）
  res.on('close', () => { if (!res.writableEnded) stop(); });
  archive.pipe(res);

  // 等当前条目（PNG/CSV）被压缩消费后再生成下一份 PNG，保证同时只有一份 PNG 驻留内存。
  // 必须在 archive.append 前挂监听，避免条目在同一事件循环内被消费时错过事件；
  // stop()（压缩错误/客户端取消）也会解除等待，由调用方检查 stopped 收尾。
  const entryGate = () => new Promise((resolve) => {
    const onEntry = () => {
      activeEntryListeners.delete(onEntry);
      archive.removeListener('entry', onEntry);
      resolve();
    };
    activeEntryListeners.add(onEntry);
    archive.on('entry', onEntry);
  });

  try {
    for (const r of reports) {
      const base = uniq(`${r.title || r.id}`.replace(/[\\/:*?"<>|]+/g, '_'));
      const pngName = `${base}_标注.png`;
      const csvName = `${base}_测量.csv`;

      // 1) 仅生成当前这一份标注 PNG（冻结快照）
      let png;
      try {
        png = await renderPng(r);
      } catch (err) {
        stop(err); // 图片生成失败：中止响应，不写出本份条目
        return { aborted: true, reason: err };
      }
      if (stopped) return { aborted: true, reason: stopReason };

      // 2) 把 PNG 交给压缩流；条目被压缩消费（'entry'）前不生成下一份
      let gate = entryGate();
      archive.append(png, { name: pngName });
      await gate;
      png = null; // 立即释放本份 PNG 缓存
      if (stopped) return { aborted: true, reason: stopReason };

      // 3) 同一份的测量 CSV（体积小，与原顺序一致：PNG 后紧跟 CSV）
      gate = entryGate();
      archive.append(buildReportCsv(r), { name: csvName });
      await gate;
      if (stopped) return { aborted: true, reason: stopReason };
    }

    // 4) 汇总 CSV 恒在最后（内容与原实现一致：按所选顺序汇总全部报告）
    const finalGate = entryGate();
    archive.append(buildCombinedCsv(reports), { name: '汇总_测量.csv' });
    await finalGate;
    if (stopped) return { aborted: true, reason: stopReason };
    await archive.finalize();
    return { aborted: false };
  } catch (err) {
    stop(err);
    return { aborted: true, reason: err };
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
