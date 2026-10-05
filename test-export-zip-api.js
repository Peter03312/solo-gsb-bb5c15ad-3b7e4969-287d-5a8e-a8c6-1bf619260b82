'use strict';

// 已发布报告批量 ZIP 导出的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 上启动真实服务，
// 覆盖本轮流式导出行为：
//   1) 选择为空 / 超 50 份上限 / 格式无效 / id 类型非法 / 报告不存在 → 下载开始前 400/4xx JSON 拒绝；
//   2) ZIP 文件名、条目名称、顺序、PNG/CSV 内容与既有格式兼容（数据来自发布冻结快照）；
//   3) 按所选顺序逐份生成：标注 PNG 渲染顺序 == 选择顺序，且同时驻留内存的 PNG ≤ 1
//      （峰值 PNG 缓存不随报告份数线性增长）；
//   4) 传输中 PNG 生成失败 → 响应被中止（连接错误），不交付成功外观的残缺 ZIP；
//   5) 浏览器取消下载 → 停止后续 PNG 生成并清理资源，服务仍可正常服务下一次请求。
// 校验/构造类测试直接使用真实 server/exporter.js 的 streamZip（无需再起服务）。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { PassThrough } = require('stream');
const sharp = require('sharp');
const { streamZip, buildReportCsv, buildCombinedCsv } = require('./server/exporter');

const PORT = 8261;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-export-'));

const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}

function jsend(method, p, body, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + p, {
      method,
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON（如 ZIP） */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (rawBody !== undefined) req.write(rawBody);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// 读取导出响应，但在 onError 时以流错误结束（用于「传输中失败必须中止」用例）
function jsendStreamAbortable(p, body, { destroyAfterFirstChunk = false } = {}) {
  return new Promise((resolve) => {
    const req = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (destroyAfterFirstChunk) { req.destroy(); req.socket && req.socket.destroy(); }
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), aborted: false }));
      res.on('error', (err) => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), aborted: true, error: err.message }));
    });
    req.on('error', (err) => resolve({ aborted: true, error: err.message, raw: Buffer.concat([]) }));
    req.write(JSON.stringify(body));
    req.end();
  });
}

function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = http.request(base + '/api/images', {
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

// 极简 ZIP 中央目录解析：只取每条目的文件名（无需第三方依赖）
function zipEntryNames(buf) {
  // End of Central Directory: 0x06054b50；从尾部向前找
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非 ZIP：找不到 EOCD');
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  while (buf.readUInt32LE(off) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.slice(off + 46, off + 46 + nameLen).toString('utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ---- 不依赖服务的 streamZip 行为测试：顺序、单份驻留、失败/取消 ----

async function unitTests() {
  function fakeRes() {
    const res = new PassThrough();
    res.setHeader = () => {};
    res.on('error', () => {}); // destroy(err) 会触发 error；测试只关心 destroy/中止状态
    return res;
  }

  const mkReport = (id) => ({
    id, title: id, filename: 'a.png', width: 10, height: 10,
    calib: null, cells: [], createdAt: 't', draftVersion: 1
  });

  // 1) 渲染顺序 == 选择顺序；峰值 PNG 缓存份数恒 ≤ 1（不随报告份数线性增长）。
  //    旧实现先渲染全部 N 份（live=N）再打包；新实现渲染 r(i+1) 前 r(i) 的 PNG 条目
  //    必须已被归档消费（archive 'entry'），任意时刻 live∈{0,1}。
  {
    const reports = Array.from({ length: 6 }, (_, i) => mkReport(`r${i}`));
    const renderOrder = [];
    let inflight = 0, maxInflight = 0;
    // live：已 render 完成、但对应 PNG entry 尚未被归档消费的缓存份数
    let live = 0, maxLive = 0;
    let archiveRef = null;
    const res = fakeRes();
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    const result = await streamZip(reports, async (r) => {
      renderOrder.push(r.id);
      inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      if (live > 1) throw new Error('渲染提前：存在多份未释放 PNG（' + live + '）');
      await new Promise((s) => setImmediate(s)); // 模拟 sharp 异步渲染，暴露提前并发生成
      inflight -= 1;
      live += 1; maxLive = Math.max(maxLive, live);
      return Buffer.from(`PNG_OF_${r.id}_` + 'x'.repeat(2000));
    }, res, (archive) => {
      archiveRef = archive;
      // 用条目名识别 PNG 条目；每个 PNG entry 被消费时，其缓存即视为已释放
      archive.on('entry', (data) => {
        if (data && data.name && data.name.endsWith('_标注.png')) {
          if (live > 0) live -= 1;
        }
      });
    });
    check('单元：正常导出未中止', result.aborted === false, result);
    check('单元：PNG 严格按所选顺序生成', renderOrder.join(',') === reports.map((r) => r.id).join(','), renderOrder);
    check('单元：同时在生成的 PNG ≤ 1（不预渲染/不并发累积）', maxInflight === 1, { maxInflight });
    check('单元：峰值 PNG 缓存份数 ≤ 1（旧实现为 N=6 份）', maxLive <= 1, { maxLive });
    check('单元：结束时所有 PNG 缓存均已释放', live === 0, { live });
    check('单元：观测钩子拿到 archive', !!archiveRef);
    // 通过归档内容确认 6 张 PNG + 6 CSV + 1 汇总
    const zipBuf = Buffer.concat(chunks);
    const names = zipEntryNames(zipBuf);
    check('单元：条目数 = 2N+1', names.length === 13, names);
    check('单元：每份 PNG 内容仅出现一次且各归其位',
      reports.every((r, i) => names[i * 2] === `${r.id}_标注.png` && names[i * 2 + 1] === `${r.id}_测量.csv`) &&
      names[12] === '汇总_测量.csv', names);
  }

  // 1b) 慢消费者：压缩字节被延迟写出，各份渲染区间仍不得重叠（渲染被消费节奏串行化）
  {
    const reports = Array.from({ length: 4 }, (_, i) => mkReport(`s${i}`));
    const events = [];
    const slow = fakeRes();
    const origWrite = slow._write.bind(slow);
    slow._write = (chunk, enc, cb) => setTimeout(() => origWrite(chunk, enc, cb), 5);
    slow.resume();
    const result = await streamZip(reports, async (r) => {
      events.push(['start', r.id]);
      await new Promise((s) => setImmediate(s));
      events.push(['end', r.id]);
      return Buffer.from(`PNG_OF_${r.id}_` + 'y'.repeat(3000));
    }, slow);
    check('单元（慢消费）：导出正常完成', result.aborted === false, result);
    let overlap = false;
    for (let i = 0; i < reports.length; i++) {
      for (let j = i + 1; j < reports.length; j++) {
        const si = events.findIndex((e) => e[0] === 'start' && e[1] === reports[i].id);
        const ei = events.findIndex((e) => e[0] === 'end' && e[1] === reports[i].id);
        const sj = events.findIndex((e) => e[0] === 'start' && e[1] === reports[j].id);
        if (sj < ei || sj < si) overlap = true; // j 不得在 i 渲染结束前开始，且顺序不得倒置
      }
    }
    check('单元（慢消费）：渲染区间互不重叠且顺序正确（背压下不预生成）',
      !overlap && events.map((e) => e[1]).join(',') === reports.flatMap((r) => [r.id, r.id]).join(','),
      events);
  }

  // 2) 第 3 份渲染失败 → 中止；前两份条目已在流中，但不会写出汇总 CSV，响应被 destroy
  {
    const reports = Array.from({ length: 5 }, (_, i) => mkReport(`f${i}`));
    const rendered = [];
    const res = fakeRes();
    res.resume();
    const result = await streamZip(reports, async (r) => {
      rendered.push(r.id);
      if (r.id === 'f2') throw new Error('sharp boom');
      return Buffer.from(`PNG_${r.id}`);
    }, res);
    check('单元：渲染失败 → aborted', result.aborted === true && /sharp boom/.test(result.reason.message), result);
    check('单元：失败后不再生成后续报告 PNG', rendered.join(',') === 'f0,f1,f2', rendered);
    check('单元：响应已 destroy（不交付完整 ZIP）', res.destroyed === true);
  }

  // 3) 客户端在传输中途取消（res close 且未写完）→ 停止后续生成。
  //    用不可压缩的大块（每份 256KB）+ 阻塞下游，使队列在发出若干份后被背压卡住。
  {
    const N = 30;
    const reports = Array.from({ length: N }, (_, i) => mkReport(`q${i}`));
    const rendered = [];
    let inflight = 0, maxInflight = 0;
    const res = fakeRes();
    let permits = 1;
    res._write = (chunk, enc, cb) => { if (permits-- > 0) cb(); }; // 首次写入后不再 drain
    const resultP = streamZip(reports, async (r) => {
      rendered.push(r.id);
      inflight += 1; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((s) => setImmediate(s));
      inflight -= 1;
      return require('crypto').randomBytes(256 * 1024);
    }, res);
    await new Promise((r) => setTimeout(r, 150)); // 等背压把队列卡住
    res.destroy(); // 模拟浏览器关闭连接：writableEnded=false、触发 'close'
    const result = await resultP;
    check('单元：客户端取消 → aborted', result.aborted === true, result);
    check('单元：取消后停止后续 PNG 生成（未渲染满 30 份）', rendered.length < N, { rendered: rendered.length });
    check('单元：取消用例下渲染仍严格串行（同时在生成 ≤1）', maxInflight === 1, { maxInflight });
  }
}

async function main() {
  await unitTests();

  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#ffffff' } })
      .png().toBuffer();

    // 上传 3 张图片并各发布 2 份报告（共 6 份），标题各异
    const reportIds = [];
    for (let k = 0; k < 3; k++) {
      const up = await upload(png);
      check(`上传图片 ${k} 成功`, up.status === 200 || up.status === 201, up);
      const imgId = up.body.id;
      let r = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100 });
        const req = http.request(base + `/api/images/${imgId}/calibration`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d)})); });
        req.on('error', reject); req.write(body); req.end();
      });
      check(`定标 ${k} 200`, r.status === 200, r.body && r.body.error);

      for (let v = 0; v < 2; v++) {
        // 每次发布都会推进草稿版本，因此轮廓保存版本随迭代推进
        const contoursVersion = 2 + v * 2;
        const rr = await new Promise((resolve, reject) => {
          const body = JSON.stringify({
            version: contoursVersion,
            cells: [{ id: `c${v}`, name: `切片${k}细胞${v}`,
              outer: [{ x: 10 + v * 30, y: 10 }, { x: 50 + v * 30, y: 10 },
                      { x: 50 + v * 30, y: 50 }, { x: 10 + v * 30, y: 50 }], holes: [] }]
          });
          const req = http.request(base + `/api/images/${imgId}/contours`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d)})); });
          req.on('error', reject); req.write(body); req.end();
        });
        check(`保存轮廓 ${k}.${v} 200`, rr.status === 200, rr.body && rr.body.error);

        const publishVersion = contoursVersion + 1;
        const pub = await new Promise((resolve, reject) => {
          const body = JSON.stringify({ version: publishVersion, title: `切片${k}报告${v}` });
          const req = http.request(base + `/api/images/${imgId}/publish`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(d)})); });
          req.on('error', reject); req.write(body); req.end();
        });
        check(`发布 ${k}.${v} 201`, pub.status === 201, pub.body && pub.body.error);
        reportIds.push(pub.body.report.id);
      }
    }

    // ---------- 下载开始前明确拒绝 ----------
    let r = await jsend('POST', '/api/reports/export', { ids: [], format: 'zip' });
    check('空选择 → 400 JSON', r.status === 400 && /至少选择/.test(r.body.error), r);

    r = await jsend('POST', '/api/reports/export', { ids: Array(51).fill(reportIds[0]), format: 'zip' });
    check('超过 50 份 → 400（不再静默截断）', r.status === 400 && /最多选择 50/.test(r.body.error), r);

    r = await jsend('POST', '/api/reports/export', { ids: Array(50).fill(reportIds[0]), format: 'zip' });
    check('恰好 50 份 → 不因上限被拒', r.status === 200, { status: r.status, error: r.body && r.body.error });

    r = await jsend('POST', '/api/reports/export', { ids: reportIds, format: 'tar' });
    check('格式无效 → 400', r.status === 400 && /format/.test(r.body.error), r);

    r = await jsend('POST', '/api/reports/export', { ids: ['  ', 'x'], format: 'zip' });
    check('id 非字符串/空白 → 400', r.status === 400 && /ids/.test(r.body.error), r);

    r = await jsend('POST', '/api/reports/export', { ids: [123, 456], format: 'zip' });
    check('id 类型非法（数字）→ 400', r.status === 400 && /ids/.test(r.body.error), r);

    r = await jsend('POST', '/api/reports/export', { ids: [reportIds[0], 'does-not-exist', reportIds[1]], format: 'zip' });
    check('有报告不存在 → 400 且指出标识', r.status === 400 && /does-not-exist/.test(r.body.error), r);

    // ids 不是数组
    r = await jsend('POST', '/api/reports/export', { ids: reportIds[0], format: 'zip' });
    check('ids 非数组 → 400', r.status === 400, r);

    // 单份 png 仍支持、多份 png 拒绝（兼容性）
    r = await jsend('POST', '/api/reports/export', { ids: [reportIds[0]], format: 'png' });
    check('单份 PNG 导出 200', r.status === 200 && r.headers['content-type'] === 'image/png' &&
      r.raw.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { status: r.status });

    // ---------- 正常 ZIP：名称/顺序/内容兼容，且按选择顺序 ----------
    // 取报告标题用于拼名
    const reportsMeta = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/reports', (res) => {
        let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
      });
      req.on('error', reject);
    });
    const titleById = new Map(reportsMeta.map((x) => [x.id, x.title]));

    // 故意打乱选择顺序（与发布顺序不同）
    const order = [reportIds[5], reportIds[0], reportIds[3], reportIds[2]];
    r = await jsend('POST', '/api/reports/export', { ids: order, format: 'zip' });
    check('ZIP 200 + 文件名 reports.zip',
      r.status === 200 && r.headers['content-type'] === 'application/zip' &&
      /filename="reports\.zip"/.test(r.headers['content-disposition'] || ''), r.headers);
    const names = zipEntryNames(r.raw);
    const expected = [];
    for (const id of order) {
      expected.push(`${titleById.get(id)}_标注.png`, `${titleById.get(id)}_测量.csv`);
    }
    expected.push('汇总_测量.csv');
    check('ZIP 条目名称与顺序按选择顺序、汇总在最后', JSON.stringify(names) === JSON.stringify(expected), names);

    // CSV 名称兼容：直接比较服务端单份 CSV 与 ZIP 中该份测量 CSV 的字节内容
    const singleCsv = await jsend('POST', '/api/reports/export', { ids: [order[1]], format: 'csv' });
    // ZIP 使用 deflate，无法直接在原始字节中搜索；解压校验
    const zlib = require('zlib');
    function extractEntry(buf, wantedName) {
      // 从中央目录拿到 local header offset
      let eocd = -1;
      for (let i = buf.length - 22; i >= 0; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      }
      let off = buf.readUInt32LE(eocd + 16);
      while (buf.readUInt32LE(off) === 0x02014b50) {
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
        if (name === wantedName) {
          const ln = buf.readUInt16LE(localOff + 26);
          const le = buf.readUInt16LE(localOff + 28);
          const dataStart = localOff + 30 + ln + le;
          const raw = buf.slice(dataStart, dataStart + compSize);
          return method === 0 ? raw : zlib.inflateRawSync(raw);
        }
        off += 46 + nameLen + extraLen + commentLen;
      }
      return null;
    }
    const zippedCsv = extractEntry(r.raw, `${titleById.get(order[1])}_测量.csv`);
    check('ZIP 内测量 CSV 与单份 CSV 导出字节一致（兼容）',
      !!zippedCsv && zippedCsv.equals(singleCsv.raw), { single: singleCsv.raw.length, zip: zippedCsv && zippedCsv.length });

    // 汇总 CSV 与多份 csv 导出一致
    const combined = await jsend('POST', '/api/reports/export', { ids: order, format: 'csv' });
    const zippedCombined = extractEntry(r.raw, '汇总_测量.csv');
    check('ZIP 内汇总 CSV 与合并 CSV 导出字节一致（兼容）',
      !!zippedCombined && zippedCombined.equals(combined.raw), { a: combined.raw.length, b: zippedCombined && zippedCombined.length });

    // 每张 PNG 可被 sharp 解码
    let decodeOk = true;
    for (const id of order) {
      const data = extractEntry(r.raw, `${titleById.get(id)}_标注.png`);
      const meta = await sharp(data).metadata().catch(() => null);
      if (!meta || meta.format !== 'png' || meta.width !== 300 || meta.height !== 300) decodeOk = false;
    }
    check('ZIP 内全部标注 PNG 可解码且尺寸为冻结快照尺寸', decodeOk);

    // ---------- 传输中 PNG 生成失败 → 中止，不交付完整 ZIP ----------
    // 移走其中一份的发布快照（第 4 份选择 → 前 3 份条目可能已发出）
    const victimId = order[3];
    const snapDir = path.join(DATA_DIR, 'snapshots');
    const snapFiles = fs.readdirSync(snapDir);
    const snapName = snapFiles.find((f) => f.startsWith(victimId));
    check('找到待移走的冻结快照', !!snapName, snapFiles);
    const movedTo = path.join(os.tmpdir(), snapName + '.moved');
    fs.renameSync(path.join(snapDir, snapName), movedTo);
    try {
      const failRes = await jsendStreamAbortable('/api/reports/export', { ids: order, format: 'zip' });
      check('传输中失败：响应被中止（连接错误/截断）', failRes.aborted === true, failRes.error);
      // 即使前半段字节已收到，也不含完整 ZIP 结构（缺 EOCD 或条目不全）
      let partialLooksComplete = false;
      try { partialLooksComplete = zipEntryNames(failRes.raw).length === expected.length; } catch { partialLooksComplete = false; }
      check('失败响应不具备成功外观（不是完整 ZIP）', partialLooksComplete === false);
    } finally {
      fs.renameSync(movedTo, path.join(snapDir, snapName));
    }

    // ---------- 浏览器取消下载：停止后续生成，服务存活 ----------
    const cancelRes = await jsendStreamAbortable('/api/reports/export',
      { ids: reportIds, format: 'zip' }, { destroyAfterFirstChunk: true });
    check('客户端取消后请求以中断结束（无完整 ZIP 落盘）',
      cancelRes.aborted === true || (cancelRes.status === 200 && cancelRes.raw.length < 50),
      { aborted: cancelRes.aborted, status: cancelRes.status, len: cancelRes.raw.length });
    const alive = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/reports', (res) => resolve(res.statusCode));
      req.on('error', reject);
    });
    check('取消后服务仍正常服务', alive === 200);

    // 取消后再发起一次完整导出，结果完好（资源已清理、无串扰）
    const retry = await jsend('POST', '/api/reports/export', { ids: order, format: 'zip' });
    check('取消后再次导出仍完整一致', retry.status === 200 &&
      JSON.stringify(zipEntryNames(retry.raw)) === JSON.stringify(expected));

    // 冻结性：发布后再改草稿不影响导出的 PNG/CSV（数据来自冻结快照）
    // 取第一张图片，改轮廓后重新查询其已发布报告 CSV 内容保持
    const firstList = await new Promise((resolve, reject) => {
      const req = http.get(base + '/api/images', (res) => {
        let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
      });
      req.on('error', reject);
    });
    const imageId = firstList[0].id;
    const beforeZip = (await jsend('POST', '/api/reports/export', { ids: [reportIds[0]], format: 'csv' })).raw;
    const imgDetail = await new Promise((resolve, reject) => {
      const req = http.get(base + `/api/images/${imageId}`, (res) => {
        let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
      });
      req.on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const body = JSON.stringify({ version: imgDetail.version, cells: [] });
      const req = http.request(base + `/api/images/${imageId}/contours`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end',()=>resolve({status:res.statusCode})); });
      req.on('error', reject); req.write(body); req.end();
    });
    const afterZip = (await jsend('POST', '/api/reports/export', { ids: [reportIds[0]], format: 'csv' })).raw;
    check('草稿后续改动不影响已发布报告的导出内容（冻结快照）', beforeZip.equals(afterZip));

  } finally {
    srv.kill();
    await new Promise((r) => setTimeout(r, 200));
  }

  if (failures) { console.error(`\n${failures} 项失败 ✖`); process.exit(1); }
  console.log('\n批量 ZIP 流式导出端到端自测全部通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
