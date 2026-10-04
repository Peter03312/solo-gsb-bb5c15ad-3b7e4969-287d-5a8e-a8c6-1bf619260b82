'use strict';

// 几何校验/测量快速自测（node test-geometry.js）
const assert = require('assert');
const { validateCell, validateField, validateWrittenCell, validateWrittenField, measureCell } = require('./server/geometry');

const W = 100, H = 100;
// 与保存接口一致的落盘精度：三位小数
const r3 = (ring) => ring.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));

// 1. 正常矩形细胞 + 内部孔洞
{
  const outer = [{x:10,y:10},{x:90,y:10},{x:90,y:90},{x:10,y:90}];
  const hole = [{x:40,y:40},{x:60,y:40},{x:60,y:60},{x:40,y:60}];
  const r = validateCell({ outer, holes: [hole] }, W, H);
  assert.strictEqual(r.outer.length, 4);
  const m = measureCell(r.outer, r.holes, 0.5); // 1px = 0.5um
  // area: (6400-400)*0.25 = 1500 ; perimeter: (320+80)*0.5 = 200
  assert.ok(Math.abs(m.areaUm2 - 1500) < 1e-9, m.areaUm2);
  assert.ok(Math.abs(m.perimeterUm - 200) < 1e-9, m.perimeterUm);
  console.log('ok 1 正常矩形+孔洞测量');
}

// 2. 自交轮廓（蝴蝶结）必须拒绝
{
  const bow = [{x:10,y:10},{x:90,y:90},{x:90,y:10},{x:10,y:90}];
  assert.throws(() => validateCell({ _seq: 1, outer: bow }, W, H), /自交/);
  console.log('ok 2 拒绝自交轮廓');
}

// 3. 越界顶点
{
  const o = [{x:0,y:0},{x:120,y:0},{x:120,y:50},{x:0,y:50}];
  assert.throws(() => validateCell({ _seq: 1, outer: o }, W, H), /越出图片/);
  console.log('ok 3 拒绝越界');
}

// 4. 孔洞贴外轮廓边 -> 必须拒绝
{
  const outer = [{x:10,y:10},{x:90,y:10},{x:90,y:90},{x:10,y:90}];
  const hole = [{x:10,y:40},{x:30,y:40},{x:30,y:60},{x:10,y:60}];
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [hole] }, W, H), /严格位于/);
  console.log('ok 4 孔洞接触外轮廓被拒绝');
}

// 5. 孔洞在外部
{
  const outer = [{x:10,y:10},{x:40,y:10},{x:40,y:40},{x:10,y:40}];
  const hole = [{x:60,y:60},{x:80,y:60},{x:80,y:80},{x:60,y:80}];
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [hole] }, W, H), /严格位于/);
  console.log('ok 5 孔洞在外部被拒绝');
}

// 6. 两个孔洞彼此接触
{
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const h1 = [{x:10,y:10},{x:30,y:10},{x:30,y:30},{x:10,y:30}];
  const h2 = [{x:30,y:10},{x:50,y:10},{x:50,y:30},{x:30,y:30}]; // 与 h1 共边
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [h1, h2] }, W, H), /孔洞 1 与孔洞 2/);
  console.log('ok 6 孔洞互相接触被拒绝');
}

// 7. 孔洞嵌套包含（一个整体落入另一个内）
{
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const big = [{x:10,y:10},{x:80,y:10},{x:80,y:80},{x:10,y:80}];
  const small = [{x:20,y:20},{x:30,y:20},{x:30,y:30},{x:20,y:30}];
  assert.throws(() => validateCell({ _seq: 1, outer, holes: [big, small] }, W, H), /孔洞 1 与孔洞 2/);
  console.log('ok 7 孔洞嵌套被拒绝');
}

// 8. 重复点
{
  const o = [{x:10,y:10},{x:10,y:10},{x:90,y:90},{x:10,y:90}];
  assert.throws(() => validateCell({ _seq: 1, outer: o }, W, H), /重复/);
  console.log('ok 8 重复点被拒绝');
}

// 9. 少于 3 点
{
  assert.throws(() => validateCell({ _seq: 2, outer: [{x:1,y:1},{x:2,y:2}] }, W, H), /至少/);
  console.log('ok 9 顶点不足被拒绝');
}

// 10. 非轴对称多边形（三角形）面积与周长
{
  const tri = [{x:0,y:0},{x:10,y:0},{x:0,y:10}];
  const m = measureCell(tri, [], 2);
  assert.ok(Math.abs(m.areaUm2 - 50 * 4) < 1e-9, m.areaUm2);
  assert.ok(Math.abs(m.perimeterUm - (20 + 10 * Math.SQRT2) * 2) < 1e-9);
  console.log('ok 10 三角形测量');
}

// 11. 两个孔洞留有间隙：通过
{
  const outer = [{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}];
  const h1 = [{x:10.5,y:10},{x:30,y:10},{x:30,y:30},{x:10.5,y:30}];
  const h2 = [{x:31,y:10},{x:50,y:10},{x:50,y:30},{x:31,y:30}];
  assert.doesNotThrow(() => validateCell({ _seq: 1, outer, holes: [h1, h2] }, W, H));
  console.log('ok 11 分离孔洞通过');
}

// 12. 写入坐标校验：原始坐标合法、三位小数取整后相邻顶点重合 → 拒绝并注明写入坐标
{
  const outer = [{x:1,y:1},{x:1.0004,y:1},{x:5,y:5}];
  assert.doesNotThrow(() => validateCell({ _seq: 1, outer }, W, H)); // 原始坐标合法
  assert.throws(() => validateWrittenCell({ _seq: 1, outer: r3(outer) }, W, H),
    /重复（顶点坐标按三位小数保存/);
  console.log('ok 12 写入坐标校验：取整后相邻顶点重合被拒绝并注明');
}

// 13. 写入坐标校验：取整后孔洞贴上外轮廓 → 拒绝；合法图形原样通过
{
  const outer = [{x:0,y:0},{x:50,y:0},{x:50,y:50},{x:0,y:50}];
  const hole = [{x:10,y:0.0004},{x:20,y:0.0004},{x:15,y:10}];
  assert.doesNotThrow(() => validateCell({ _seq: 1, outer, holes: [hole] }, W, H)); // 原始坐标合法
  assert.throws(
    () => validateWrittenCell({ _seq: 1, outer: r3(outer), holes: [r3(hole)] }, W, H),
    /严格位于所属外轮廓内部.*（顶点坐标按三位小数保存/);
  // 合法图形：写入坐标校验通过且返回标准化几何（精度不变）
  const okOuter = r3([{x:10.0006,y:10.0004},{x:50.0004,y:10.0006},{x:50.0006,y:50.0004},{x:10.0004,y:50.0006}]);
  const r = validateWrittenCell({ _seq: 1, outer: okOuter, holes: [] }, W, H);
  assert.strictEqual(r.outer.length, 4);
  assert.deepStrictEqual(r.outer, okOuter);
  console.log('ok 13 写入坐标校验：取整后孔洞贴边被拒绝，合法图形通过');
}

// 14. 视野写入坐标校验：取整后孔洞互触 → 拒绝并注明；视野净面积规则同样按写入坐标
{
  const outer = [{x:0,y:0},{x:50,y:0},{x:50,y:50},{x:0,y:50}];
  const h1 = [{x:10,y:10},{x:15,y:10},{x:15,y:15},{x:10,y:15}];
  const h2 = [{x:15.0004,y:10},{x:20,y:10},{x:20,y:15},{x:15.0004,y:15}];
  assert.doesNotThrow(() => validateField({ outer, holes: [h1, h2] }, W, H, 1)); // 原始坐标合法
  assert.throws(
    () => validateWrittenField({ outer: r3(outer), holes: [r3(h1), r3(h2)] }, W, H, 1),
    /孔洞 1 与孔洞 2 相互接触或重叠.*（顶点坐标按三位小数保存/);
  // 合法视野：写入坐标校验通过
  assert.doesNotThrow(() => validateWrittenField({ outer: r3(outer), holes: [r3(h1)] }, W, H, 1));
  console.log('ok 14 视野写入坐标校验：取整后孔洞互触被拒绝，合法视野通过');
}

console.log('\n全部几何自测通过 ✔');
