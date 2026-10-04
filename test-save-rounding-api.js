'use strict';

// 轮廓/视野保存「以实际写入坐标为准」修复 · 端到端 HTTP 自测（npm test）：
//   1) 轮廓保存：原始坐标合法但三位小数取整后非法（相邻顶点重合/自交/孔洞贴边/
//      孔洞互触）→ 400，指出具体细胞/孔洞并注明取整后的写入坐标；整批不写入、
//      版本不变、不留修订；混合批次同样整批拒绝；
//   2) 原始坐标即非法的输入仍按原契约报错（错误信息不带取整说明）；
//   3) 合法图形仍按三位小数保存：落盘坐标精确等于取整值，测量值与视野统计
//      按写入坐标计算（而非原始坐标），修订快照同为写入坐标；
//   4) 视野保存：同样的取整校验与统计口径；版本冲突 409 契约不变；
//   5) 修复前的遗留数据（直接改库模拟）：草稿/历史修订/已发布报告原样保留、
//      不被静默改写；后续正常保存与发布不受影响，旧报告始终冻结。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const geo = require('./server/geometry');

const PORT = 8257;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-writtencoord-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function jget(p) {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}

const pt = (x, y) => ({ x, y });
const r3 = (ring) => ring.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
const revCount = (db, imgId) =>
  db.prepare('SELECT COUNT(*) n FROM draft_revisions WHERE image_id = ?').get(imgId).n;

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  // 独立连接改库（模拟修复上线前的遗留数据；服务端 WAL 允许并发夹具写入）
  const db = new Database(path.join(DATA_DIR, 'app.db'));

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: pt(0, 0), p2: pt(100, 0), distanceUm: 100
    });
    check('定标 1px=1μm', r.status === 200 && r.body.version === 2, r.body);
    check('基线+定标共 2 条修订', revCount(db, imgId) === 2, { n: revCount(db, imgId) });

    // ---------- 1) 轮廓：取整后非法 → 400，整批不写入 ----------
    const badCells = [
      ['相邻顶点取整重合',
        { name: '重合', outer: [pt(1, 1), pt(1.0004, 1), pt(5, 5)], holes: [] },
        /细胞「重合」：外轮廓第 1 个点与下一点重复（顶点坐标按三位小数保存/],
      ['取整后自交（尖刺贴边）',
        { name: '自交', outer: [pt(0, 0), pt(10, 0), pt(10, 10), pt(5, 0.0004), pt(0, 10)], holes: [] },
        /细胞「自交」：外轮廓第 \d、\d 条边.*自交（顶点坐标按三位小数保存/],
      ['孔洞取整后贴上外轮廓',
        { name: '贴边', outer: [pt(0, 0), pt(50, 0), pt(50, 50), pt(0, 50)],
          holes: [[pt(10, 0.0004), pt(20, 0.0004), pt(15, 10)]] },
        /细胞「贴边」 的孔洞 1：必须严格位于所属外轮廓内部.*（顶点坐标按三位小数保存/],
      ['两孔洞取整后互触',
        { name: '互触', outer: [pt(0, 0), pt(50, 0), pt(50, 50), pt(0, 50)],
          holes: [
            [pt(10, 10), pt(15, 10), pt(15, 15), pt(10, 15)],
            [pt(15.0004, 10), pt(20, 10), pt(20, 15), pt(15.0004, 15)]
          ] },
        /细胞「互触」：孔洞 1 与孔洞 2 相互接触或重叠.*（顶点坐标按三位小数保存/]
    ];
    for (const [label, cell, pattern] of badCells) {
      r = await jsend('PUT', `/api/images/${imgId}/contours`, { version: 2, cells: [cell] });
      check(`轮廓 ${label} → 400 并指出对象与写入坐标`,
        r.status === 400 && pattern.test(r.body && r.body.error), r.body && r.body.error);
    }
    // 混合批次：一个好细胞 + 一个取整后非法细胞 → 整批拒绝
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2,
      cells: [
        { name: '好', outer: [pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10)], holes: [] },
        { name: '重合', outer: [pt(1, 1), pt(1.0004, 1), pt(5, 5)], holes: [] }
      ]
    });
    check('混合批次取整后非法 → 400 指出出错细胞', r.status === 400 && /细胞「重合」/.test(r.body.error), r.body);
    let g = await jget(`/api/images/${imgId}`);
    check('全部 400 后草稿未被写入（版本 2、无细胞）',
      g.body.version === 2 && g.body.cells.length === 0, { version: g.body.version, cells: g.body.cells.length });
    check('全部 400 不留修订（仍为 2 条）', revCount(db, imgId) === 2, { n: revCount(db, imgId) });

    // ---------- 2) 原始坐标即非法：原契约报错（不带取整说明） ----------
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2, cells: [{ name: '原始重复', outer: [pt(1, 1), pt(1, 1), pt(5, 5)], holes: [] }]
    });
    check('原始坐标相邻顶点重复 → 400 原契约（无取整说明）',
      r.status === 400 && /重复/.test(r.body.error) && !/三位小数保存/.test(r.body.error), r.body);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2, cells: [{ name: '原始越界', outer: [pt(0, 0), pt(300.0004, 0), pt(10, 10)], holes: [] }]
    });
    check('原始坐标越界（取整后恰在界内）→ 仍按原契约 400',
      r.status === 400 && /越出图片范围/.test(r.body.error) && !/三位小数保存/.test(r.body.error), r.body);
    g = await jget(`/api/images/${imgId}`);
    check('原契约 400 同样不写入、版本不变', g.body.version === 2 && g.body.cells.length === 0);

    // ---------- 3) 合法图形：按三位小数保存，测量值按写入坐标计算 ----------
    // 非对称扰动：原始坐标与取整坐标的测量值明显不同（差 ~0.03，远超浮点噪声）
    const rawOuter = [pt(10.0004, 10.0004), pt(50.0009, 10.0004), pt(50.0009, 50.0009), pt(10.0004, 50.0009)];
    const rawHole = [pt(20.0004, 20.0004), pt(30.0009, 20.0004), pt(30.0009, 30.0009), pt(20.0004, 30.0009)];
    const writtenOuter = r3(rawOuter);
    const writtenHole = r3(rawHole);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 2, cells: [{ id: 'cellA', name: '甲', outer: rawOuter, holes: [rawHole] }]
    });
    check('合法四位小数图形 → 200', r.status === 200, r.body);
    check('落盘坐标精确等于三位小数取整值',
      JSON.stringify(r.body.cells[0].outer) === JSON.stringify(writtenOuter) &&
      JSON.stringify(r.body.cells[0].holes) === JSON.stringify([writtenHole]),
      r.body.cells && r.body.cells[0]);
    const expectM = geo.measureCell(writtenOuter, [writtenHole], 1);
    const rawM = geo.measureCell(rawOuter, [rawHole], 1);
    check('测量值按写入坐标计算（与取整后几何的测量完全一致）',
      r.body.cells[0].areaUm2 === expectM.areaUm2 && r.body.cells[0].perimeterUm === expectM.perimeterUm,
      { got: [r.body.cells[0].areaUm2, r.body.cells[0].perimeterUm], want: [expectM.areaUm2, expectM.perimeterUm] });
    check('测量值并非按原始坐标计算（两者确实不同）',
      Math.abs(expectM.areaUm2 - rawM.areaUm2) > 1e-9 && r.body.cells[0].areaUm2 !== rawM.areaUm2,
      { written: expectM.areaUm2, raw: rawM.areaUm2 });
    check('保存成功推进版本并追加 1 条修订（版本 3、共 3 条）',
      r.body.version === 3 && revCount(db, imgId) === 3, { version: r.body.version, n: revCount(db, imgId) });
    const revList1 = await jget(`/api/images/${imgId}/revisions`);
    const revView1 = await jget(`/api/images/${imgId}/revisions/${revList1.body.revisions[0].id}`);
    check('修订快照同为写入坐标（取整值）',
      revView1.body.type === 'contours' &&
      JSON.stringify(revView1.body.cells[0].outer) === JSON.stringify(writtenOuter),
      revView1.body.cells && revView1.body.cells[0]);

    // ---------- 4) 视野：取整后非法 → 400；合法保存的统计按写入坐标 ----------
    const badFields = [
      ['相邻顶点取整重合',
        { name: '视野重合', outer: [pt(0, 0), pt(100, 0), pt(100.0004, 100), pt(100, 100), pt(0, 100)], holes: [] },
        /视野「视野重合」：外轮廓第 3 个点与下一点重复（顶点坐标按三位小数保存/],
      ['取整后自交（尖刺贴边）',
        { name: '视野自交', outer: [pt(0, 0), pt(100, 0), pt(100, 100), pt(50, 0.0004), pt(0, 100)], holes: [] },
        /视野「视野自交」：外轮廓第 \d、\d 条边.*自交（顶点坐标按三位小数保存/],
      ['孔洞取整后贴上外环',
        { name: '视野贴边', outer: [pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)],
          holes: [[pt(10, 0.0004), pt(20, 0.0004), pt(15, 10)]] },
        /视野「视野贴边」 的孔洞 1：必须严格位于所属外轮廓内部.*（顶点坐标按三位小数保存/]
    ];
    for (const [label, field, pattern] of badFields) {
      r = await jsend('PUT', `/api/images/${imgId}/fields`, { version: 3, fields: [field] });
      check(`视野 ${label} → 400 并指出对象与写入坐标`,
        r.status === 400 && pattern.test(r.body && r.body.error), r.body && r.body.error);
    }
    g = await jget(`/api/images/${imgId}`);
    check('视野 400 后草稿未被写入（版本 3、无视野）、不留修订',
      g.body.version === 3 && g.body.fields.length === 0 && revCount(db, imgId) === 3,
      { version: g.body.version, fields: g.body.fields.length, n: revCount(db, imgId) });

    const rawFieldOuter = [pt(0.0004, 0.0004), pt(100.0004, 0.0006), pt(100.0006, 100.0004), pt(0.0006, 100.0006)];
    const writtenFieldOuter = r3(rawFieldOuter);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 3, fields: [{ id: 'f1', name: '精确视野', outer: rawFieldOuter, holes: [] }]
    });
    check('合法四位小数视野 → 200', r.status === 200, r.body);
    check('视野落盘坐标精确等于三位小数取整值',
      JSON.stringify(r.body.fields[0].outer) === JSON.stringify(writtenFieldOuter), r.body.fields);
    const expectAreaPx = geo.shoelaceArea(writtenFieldOuter);
    const stat0 = r.body.fieldStats[0];
    check('视野统计按写入坐标计算（净面积 px²/mm² 与取整后几何一致）',
      stat0.areaPx === expectAreaPx && stat0.areaMm2 === expectAreaPx / 1e6 &&
      stat0.cellCount === 1 && stat0.countedCellKeys.includes('cellA'),
      { stat0, expectAreaPx });
    check('视野保存推进版本并追加 1 条修订（版本 4、共 4 条）',
      r.body.version === 4 && revCount(db, imgId) === 4, { version: r.body.version, n: revCount(db, imgId) });

    // ---------- 5) 版本冲突契约不变 ----------
    const stale = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: 3, cells: [{ name: 'x', outer: [pt(0, 0), pt(9, 0), pt(9, 9), pt(0, 9)], holes: [] }]
    });
    check('轮廓保存版本过期 → 409 且不写入',
      stale.status === 409 && stale.body.currentVersion === 4, stale.body);
    const staleF = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: 3, fields: [{ name: 'y', outer: [pt(0, 0), pt(9, 0), pt(9, 9), pt(0, 9)], holes: [] }]
    });
    check('视野保存版本过期 → 409 且不写入',
      staleF.status === 409 && staleF.body.currentVersion === 4, staleF.body);
    check('409 后版本与修订不变', revCount(db, imgId) === 4);

    // ---------- 6) 遗留数据（修复前落盘的无效几何）不静默改写 ----------
    const legacyCells = [{ id: 'legacyBad', name: '遗留', outer: [pt(1, 1), pt(1, 1), pt(5, 5)], holes: [], areaUm2: 0, perimeterUm: 0 }];
    const imgRow = db.prepare('SELECT * FROM images WHERE id = ?').get(imgId);
    db.prepare('UPDATE images SET cells = ? WHERE id = ?').run(JSON.stringify(legacyCells), imgId);
    const legacyRevId = crypto.randomUUID();
    db.prepare(`INSERT INTO draft_revisions
                (id, image_id, seq, rev_type, note, draft_version, width, height,
                 calib, cells, fields, calibrated, cell_count, field_count)
                VALUES (?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM draft_revisions WHERE image_id = ?),
                        'contours', ?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`)
      .run(legacyRevId, imgId, imgId, '历史遗留：取整前校验通过的无效几何（夹具）',
        imgRow.version, imgRow.width, imgRow.height, imgRow.calib,
        JSON.stringify(legacyCells), imgRow.fields);
    const legacyReportId = crypto.randomUUID();
    fs.copyFileSync(path.join(DATA_DIR, 'images', imgRow.stored_name),
      path.join(DATA_DIR, 'snapshots', `${legacyReportId}.png`));
    db.prepare(`INSERT INTO reports
                (id, image_id, draft_version, title, filename, snapshot_name,
                 width, height, calib, cells, fields)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(legacyReportId, imgId, imgRow.version, '遗留无效几何报告', imgRow.filename,
        `${legacyReportId}.png`, imgRow.width, imgRow.height, imgRow.calib,
        JSON.stringify(legacyCells), imgRow.fields);

    g = await jget(`/api/images/${imgId}`);
    check('遗留草稿：GET 原样返回无效几何（不静默改写、不报错）',
      g.status === 200 && JSON.stringify(g.body.cells) === JSON.stringify(legacyCells), g.body.cells);
    const legacyRevView = await jget(`/api/images/${imgId}/revisions/${legacyRevId}`);
    check('遗留修订：预览原样返回无效几何（只读、不改写）',
      legacyRevView.status === 200 &&
      JSON.stringify(legacyRevView.body.cells) === JSON.stringify(legacyCells), legacyRevView.body);
    const legacyReport1 = await jget(`/api/reports/${legacyReportId}`);
    check('遗留报告：GET 原样返回冻结的无效几何',
      legacyReport1.status === 200 &&
      JSON.stringify(legacyReport1.body.cells) === JSON.stringify(legacyCells), legacyReport1.body);

    // 后续正常保存：整批替换掉遗留细胞，版本/修订机制不受影响
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: g.body.version,
      cells: [{ id: 'cellB', name: '乙', outer: [pt(5, 5), pt(15, 5), pt(15, 15), pt(5, 15)], holes: [] }]
    });
    check('遗留草稿上再次正常保存 → 200 并推进版本',
      r.status === 200 && r.body.version === g.body.version + 1 && r.body.cells.length === 1 &&
      r.body.cells[0].id === 'cellB', r.body);
    // 修订构成：基线/定标/轮廓/视野(4) + 遗留夹具(1) + 本次轮廓保存(1) = 6
    check('正常保存追加修订（失败请求依旧不留记录）',
      revCount(db, imgId) === 6, { n: revCount(db, imgId) });
    const legacyRevRow = db.prepare('SELECT cells FROM draft_revisions WHERE id = ?').get(legacyRevId);
    check('遗留修订行在全部操作后字节不变（未被改写）',
      legacyRevRow && legacyRevRow.cells === JSON.stringify(legacyCells));
    const legacyReport2 = await jget(`/api/reports/${legacyReportId}`);
    check('遗留报告在后续保存后仍冻结（内容与首次读取一致）',
      JSON.stringify(legacyReport2.body) === JSON.stringify(legacyReport1.body));
  } finally {
    db.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部「按写入坐标校验」HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
