'use strict';

// 批量 ZIP 导出流式化 · 端到端 HTTP + 流水线行为自测（npm test）：
//   A. streamZip 流水线（直接调用 exporter.streamZip + 模拟响应）：
//      1) 按选中顺序逐份渲染：任意时刻至多一份渲染在途；上一份条目写入 ZIP 流后
//         才开始渲染下一份（PNG 缓存逐份产生、逐份释放，峰值不随报告份数增长）；
//      2) 传输中渲染失败 → 销毁连接中止下载，不交付成功外观的残缺 ZIP；
//      3) 首份渲染即失败（尚未写出任何字节）→ 500 JSON 错误；
//      4) 客户端取消（连接提前关闭）→ 停止后续渲染并清理资源，Promise 正常结束；
//   B. HTTP 端到端（临时目录起服务）：
//      1) ZIP 条目名称/内容/顺序与单份 PNG、测量 CSV、汇总 CSV 完全兼容
//         （含同名标题 _1 去重、重复选择），数据来自发布时冻结快照；
//      2) 下载开始前明确拒绝：选择为空 / 超过 50 份上限 / 格式无效 / 报告不存在 /
//         非法 id → 400，不静默漏掉报告；
//      3) 恰好 50 份可正常导出（101 个条目、名称唯一、顺序与选中一致）；
//      4) 传输中快照缺失 → 下载被中止；首份快照缺失 → 500 JSON；
//      5) 浏览器取消下载后服务保持可用；csv/png 导出行为不变。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { Writable } = require('stream');
const sharp = require('sharp');
const Database = require('better-sqlite3');
const { streamZip } = require('./server/exporter');

const PORT = 8258;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-exportzip-'));
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
const post = (body) => fetch(`${base}/api/reports/export`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

// 解析完整 ZIP（按中央目录）：[{name, data}]，顺序即条目写入顺序
function parseZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是完整的 ZIP（缺少结尾目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26);
    const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = buf.slice(start, start + csize);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

async function waitFor(fn, ms = 1000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((s) => setImmediate(s));
  }
  return true;
}

// ---------- A. streamZip 流水线行为（模拟响应） ----------

// 模拟 http.ServerResponse：Writable 收集字节，首字节写出即视为 headersSent
function mockRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      if (!res.headersSent) res.headersSent = true;
      chunks.push(Buffer.from(chunk));
      cb();
    }
  });
  res.headersSent = false;
  res.statusCode = 200;
  res.setHeader = () => res;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.jsonBody = body; res.end(); return res; };
  res.on('error', () => {}); // 清理阶段的写错误不影响断言
  res.bodyBuffer = () => Buffer.concat(chunks);
  return res;
}

function whenFinish(res) {
  return new Promise((resolve) => {
    if (res.writableFinished || res.destroyed) return resolve();
    res.on('finish', resolve);
    res.on('close', resolve);
  });
}

const fakeReports = [
  { id: 'r1', title: '甲', filename: 'a.png', width: 10, height: 10, calib: null, cells: [], createdAt: '2026-01-01', draftVersion: 1 },
  { id: 'r2', title: '乙', filename: 'a.png', width: 10, height: 10, calib: null, cells: [], createdAt: '2026-01-01', draftVersion: 1 },
  { id: 'r3', title: '丙', filename: 'a.png', width: 10, height: 10, calib: null, cells: [], createdAt: '2026-01-01', draftVersion: 1 }
];

async function testPipeline() {
  // A1：逐份生成、写入并释放；条目名称/内容/顺序兼容
  {
    const res = mockRes();
    const renders = [];
    let inFlight = 0; let maxInFlight = 0;
    const renderPng = async (r) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      // 上一份的条目必须已经写入 ZIP 流，才轮到本份渲染（逐份产生、逐份释放）
      const sawPrev = renders.length === 0 ? true
        : await waitFor(() => res.bodyBuffer().toString('utf8')
            .includes(`${fakeReports[renders.length - 1].title}_标注.png`));
      renders.push({ id: r.id, sawPrev });
      await new Promise((s) => setImmediate(s));
      inFlight -= 1;
      return Buffer.from(`PNG-${r.id}`);
    };
    await streamZip(fakeReports, renderPng, res);
    await whenFinish(res);
    check('A1 三份全部渲染', renders.length === 3);
    check('A1 任意时刻至多一份渲染在途（逐份生成）', maxInFlight === 1, { maxInFlight });
    check('A1 上一份条目写入流后才渲染下一份（逐份写入并释放）',
      renders.every((x) => x.sawPrev), renders);
    const entries = parseZip(res.bodyBuffer());
    check('A1 ZIP 条目名称与顺序兼容', JSON.stringify(entries.map((e) => e.name)) ===
      JSON.stringify(['甲_标注.png', '甲_测量.csv', '乙_标注.png', '乙_测量.csv',
        '丙_标注.png', '丙_测量.csv', '汇总_测量.csv']), entries.map((e) => e.name));
    check('A1 条目内容正确（PNG 逐份对应、汇总 CSV 在末尾）',
      entries[0].data.toString() === 'PNG-r1' &&
      entries[2].data.toString() === 'PNG-r2' &&
      entries[4].data.toString() === 'PNG-r3' &&
      entries[6].data.toString('utf8').includes('报告ID'));
  }

  // A2：传输中渲染失败 → 销毁连接中止，不交付成功外观的残缺 ZIP
  {
    const res = mockRes();
    const renderPng = async (r) => {
      if (r.id === 'r2') {
        await waitFor(() => res.headersSent); // 等第 1 份字节实际写出（传输已开始）
        throw new Error('磁盘读取失败');
      }
      return Buffer.from(`PNG-${r.id}`);
    };
    await streamZip(fakeReports, renderPng, res);
    check('A2 传输中渲染失败：连接被销毁中止', res.destroyed === true);
    check('A2 不交付成功外观的完整 ZIP（无结尾目录、无 JSON 错误页）',
      !res.bodyBuffer().includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])) &&
      res.jsonBody === undefined && res.statusCode === 200);
  }

  // A3：首份渲染即失败（尚未写出任何字节）→ 500 JSON
  {
    const res = mockRes();
    const renderPng = async () => { throw new Error('快照丢失'); };
    await streamZip(fakeReports, renderPng, res);
    check('A3 首份渲染失败 → 500 JSON 并指明报告',
      res.statusCode === 500 && /报告《甲》标注图片生成失败/.test((res.jsonBody && res.jsonBody.error) || ''),
      res.jsonBody);
    check('A3 未写出任何 ZIP 字节', res.bodyBuffer().length === 0);
  }

  // A4：客户端取消（连接提前关闭）→ 停止后续渲染并清理资源
  {
    const res = mockRes();
    const renderCalls = [];
    const renderPng = async (r) => {
      renderCalls.push(r.id);
      if (r.id === 'r2') {
        res.destroy(); // 浏览器取消下载：连接在响应正常结束前关闭
        await new Promise((s) => setImmediate(s));
      }
      return Buffer.from(`PNG-${r.id}`);
    };
    await Promise.race([
      streamZip(fakeReports, renderPng, res),
      new Promise((_, rej) => setTimeout(() => rej(new Error('streamZip 未在客户端取消后结束')), 3000))
    ]);
    check('A4 客户端取消后停止后续生成（第 3 份不再渲染）',
      renderCalls.length === 2, { renderCalls });
  }
}

// ---------- B. HTTP 端到端 ----------

async function main() {
  await testPipeline();

  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  // 独立连接读库（定位报告快照文件，模拟传输中快照缺失）
  const db = new Database(path.join(DATA_DIR, 'app.db'));

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;

    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: pt(0, 0), p2: pt(100, 0), distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [
        { id: 'cellA', name: '甲', outer: [pt(10, 10), pt(100, 10), pt(100, 100), pt(10, 100)], holes: [] },
        { id: 'cellB', name: '乙', outer: [pt(150, 150), pt(250, 150), pt(250, 250), pt(150, 250)],
          holes: [[pt(170, 170), pt(200, 170), pt(200, 200), pt(170, 200)]] }
      ]
    });
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [{ id: 'f1', name: '中心视野',
        outer: [pt(0, 0), pt(290, 0), pt(290, 290), pt(0, 290)], holes: [] }]
    });

    // 发布三份报告：A「切片甲」、B「切片乙」、C「切片甲」（同名验证 _1 去重）
    const publish = async (title) => {
      const v = (await jget(`/api/images/${imgId}`)).body.version;
      const p = await jsend('POST', `/api/images/${imgId}/publish`, { version: v, title });
      return p.body.report.id;
    };
    const A = await publish('切片甲');
    const B = await publish('切片乙');
    const C = await publish('切片甲');

    // ---------- B1：ZIP 条目名称/内容/顺序与既有导出完全兼容 ----------
    let res = await post({ ids: [A, B, C], format: 'zip' });
    check('B1 ZIP 导出 200', res.status === 200);
    check('B1 ZIP 文件名保持 reports.zip',
      res.headers.get('content-disposition') === 'attachment; filename="reports.zip"',
      res.headers.get('content-disposition'));
    check('B1 Content-Type 为 application/zip',
      (res.headers.get('content-type') || '').includes('application/zip'));
    const zipBuf = Buffer.from(await res.arrayBuffer());
    const entries = parseZip(zipBuf);
    check('B1 条目名称与顺序（选中顺序 + 同名 _1 去重 + 汇总末尾）',
      JSON.stringify(entries.map((e) => e.name)) === JSON.stringify([
        '切片甲_标注.png', '切片甲_测量.csv',
        '切片乙_标注.png', '切片乙_测量.csv',
        '切片甲_1_标注.png', '切片甲_1_测量.csv',
        '汇总_测量.csv'
      ]), entries.map((e) => e.name));

    const singlePng = async (id) =>
      Buffer.from(await (await fetch(`${base}/api/reports/${id}/png`)).arrayBuffer());
    // 按原始字节比较（fetch .text() 会剥离 BOM，与 ZIP 条目不具可比性）
    const singleCsvBuf = async (id) =>
      Buffer.from(await (await fetch(`${base}/api/reports/${id}/csv`)).arrayBuffer());
    const [pngA, pngB, pngC] = [await singlePng(A), await singlePng(B), await singlePng(C)];
    check('B1 标注 PNG 与单份导出逐字节一致（同一冻结快照渲染）',
      entries[0].data.equals(pngA) && entries[2].data.equals(pngB) && entries[4].data.equals(pngC));
    check('B1 测量 CSV 与单份导出逐字节一致',
      entries[1].data.equals(await singleCsvBuf(A)) &&
      entries[3].data.equals(await singleCsvBuf(B)) &&
      entries[5].data.equals(await singleCsvBuf(C)));
    const combinedRes = await post({ ids: [A, B, C], format: 'csv' });
    check('B1 汇总 CSV 与多份合并 CSV 导出逐字节一致',
      entries[6].data.equals(Buffer.from(await combinedRes.arrayBuffer())));

    // 重复选择同一报告：保持既有行为（渲染两次、名称 _1 去重）
    res = await post({ ids: [A, A], format: 'zip' });
    const dupEntries = parseZip(Buffer.from(await res.arrayBuffer()));
    check('B1 重复选择同一报告仍各出一份（名称 _1 去重）',
      JSON.stringify(dupEntries.map((e) => e.name)) === JSON.stringify([
        '切片甲_标注.png', '切片甲_测量.csv', '切片甲_1_标注.png', '切片甲_1_测量.csv', '汇总_测量.csv'
      ]), dupEntries.map((e) => e.name));

    // ---------- B2：下载开始前明确拒绝（400，不静默漏掉报告） ----------
    res = await post({ ids: [], format: 'zip' });
    check('B2 空选择 → 400', res.status === 400 && /至少选择一份报告/.test((await res.json()).error || ''));
    res = await post({ format: 'zip' });
    check('B2 缺少 ids → 400', res.status === 400);
    res = await post({ ids: [A], format: 'zipz' });
    check('B2 格式无效 → 400', res.status === 400 && /format/.test((await res.json()).error || ''));
    res = await post({ ids: [A, 'no-such-report'], format: 'zip' });
    check('B2 报告不存在 → 400 并指明 id',
      res.status === 400 && /no-such-report/.test((await res.json()).error || ''));
    res = await post({ ids: [A, 123], format: 'zip' });
    check('B2 非法 id 类型 → 400', res.status === 400);
    res = await post({ ids: Array.from({ length: 51 }, (_, i) => `fake-${i}`), format: 'zip' });
    check('B2 超过 50 份 → 400 明确拒绝（不再静默截断）',
      res.status === 400 && /50/.test((await res.json()).error || ''));

    // csv / png 导出行为不变
    res = await post({ ids: [A], format: 'csv' });
    check('B2 单份测量 CSV 导出不变',
      res.status === 200 &&
      Buffer.from(await res.arrayBuffer()).equals(await singleCsvBuf(A)));
    res = await post({ ids: [A], format: 'png' });
    check('B2 单份 PNG 导出不变',
      res.status === 200 && Buffer.from(await res.arrayBuffer()).equals(pngA));
    res = await post({ ids: [A, B], format: 'png' });
    check('B2 多份 PNG → 400（仍仅支持单份）', res.status === 400);

    // ---------- B3：恰好 50 份正常导出 ----------
    const ids50 = [A, B, C];
    for (let i = 4; i <= 50; i++) ids50.push(await publish(`批量${String(i).padStart(2, '0')}`));
    res = await post({ ids: ids50, format: 'zip' });
    check('B3 恰好 50 份 → 200', res.status === 200);
    const entries50 = parseZip(Buffer.from(await res.arrayBuffer()));
    check('B3 50 份共 101 个条目（50 PNG + 50 CSV + 汇总）', entries50.length === 101,
      { n: entries50.length });
    check('B3 条目名全部唯一', new Set(entries50.map((e) => e.name)).size === 101);
    check('B3 条目顺序与选中顺序一致',
      entries50[0].name === '切片甲_标注.png' &&
      entries50[2].name === '切片乙_标注.png' &&
      entries50[98].name === '批量50_标注.png' &&
      entries50[100].name === '汇总_测量.csv',
      [entries50[0].name, entries50[98].name, entries50[100].name]);
    res = await post({ ids: ids50.concat(['extra-one']), format: 'zip' });
    check('B3 51 份 → 400 明确拒绝', res.status === 400 && /50/.test((await res.json()).error || ''));

    // ---------- B4：浏览器取消下载后服务保持可用 ----------
    {
      const ctrl = new AbortController();
      try {
        const cancelRes = await fetch(`${base}/api/reports/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: ids50, format: 'zip' }),
          signal: ctrl.signal
        });
        const reader = cancelRes.body.getReader();
        await reader.read(); // 收到第一块数据后立即取消
        ctrl.abort();
        try { await reader.read(); } catch { /* 中止即预期 */ }
      } catch { /* 中止即预期 */ }
      await new Promise((s) => setTimeout(s, 500));
      const alive = await jget('/api/reports');
      check('B4 客户端取消下载后服务保持可用', alive.status === 200 && Array.isArray(alive.body));
    }

    // ---------- B5：传输中渲染失败 → 中止下载，不交付残缺 ZIP ----------
    const snapB = db.prepare('SELECT snapshot_name FROM reports WHERE id = ?').get(B).snapshot_name;
    fs.rmSync(path.join(DATA_DIR, 'snapshots', snapB));
    let aborted = false;
    try {
      const failRes = await post({ ids: [A, B], format: 'zip' });
      await failRes.arrayBuffer(); // 传输中连接被销毁 → 读取应抛错
    } catch {
      aborted = true;
    }
    check('B5 传输中渲染失败 → 下载被中止（fetch 抛错，不交付残缺 ZIP）', aborted);

    // ---------- B6：首份渲染即失败 → 500 JSON ----------
    const snapC = db.prepare('SELECT snapshot_name FROM reports WHERE id = ?').get(C).snapshot_name;
    fs.rmSync(path.join(DATA_DIR, 'snapshots', snapC));
    res = await post({ ids: [C], format: 'zip' });
    check('B6 首份渲染即失败 → 500 JSON（未写出任何字节）',
      res.status === 500 && /标注图片生成失败/.test((await res.json()).error || ''));
  } finally {
    db.close();
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部「批量 ZIP 导出流式化」HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
