// test-finance.mjs —— Z-5 回归断言（纯 Node，不碰应用）
// 镜像 app.js renderOrderContribution 的分类公式（2026-11-21 版，含 C-3 returnEvents）。
// 改公式后必须回跑本脚本。
import fs from 'node:fs';

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' :: ' + (e && e.message)]); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

// —— 与 app.js 订单分类循环逐行同构 ——
function aggregate(rows) {
  const g = {
    orders: 0, qty: 0, costQty: 0, lossQty: 0, revenue: 0,
    totalQty: 0, totalOrders: 0,
    refundedOrders: 0, pendingReturn: 0, cancelledCount: 0, excludedOrders: 0,
    returnCount: 0, onlyRefundCount: 0, exchangeCount: 0, refundAmount: 0, returnEvents: 0,
  };
  for (const { status, typeName, quantity, amount } of rows) {
    const asType = String(typeName || '');
    const statusText = String(status || '');
    const refunded = /退款成功/.test(statusText);
    const cancelled = /已取消/.test(statusText);
    const isExchange = /换货/.test(asType);
    const isOnly = /仅退款/.test(asType);
    const isReturn = /退货/.test(asType);
    const excluded = refunded || cancelled || isReturn || isOnly;

    g.orders += 1;
    if (isOnly) g.onlyRefundCount += 1;
    else if (isReturn) g.returnCount += 1;
    if (refunded) g.refundedOrders += 1;
    if (cancelled) g.cancelledCount += 1;
    if (isReturn && !refunded) g.pendingReturn += 1;
    if (refunded || isReturn || isOnly) g.returnEvents += 1;
    if (!cancelled) {
      g.totalQty += Number(quantity) || 0;
      g.totalOrders += 1;
    }
    if (excluded) {
      g.excludedOrders += 1;
      g.refundAmount += Number(amount) || 0;
    } else {
      g.qty += Number(quantity) || 0;
      g.revenue += Number(amount) || 0;
    }
    if (!excluded) g.costQty += Number(quantity) || 0;
    else if (isOnly) { g.costQty += Number(quantity) || 0; g.lossQty += Number(quantity) || 0; }
  }
  return g;
}
const rate = (g) => (g.totalOrders > 0 ? g.returnEvents / g.totalOrders : null);

// ① 16 退款 + 5 在途 + 0 仅退 + 2 取消 + 5 正常 → 21/26 = 80.8%
check('① 退货率 21/26 = 80.8%', () => {
  const rows = [];
  for (let i = 0; i < 16; i++) rows.push({ status: '退款成功', typeName: '退货退款', quantity: 1, amount: 1000 });
  for (let i = 0; i < 5; i++) rows.push({ status: '已发货', typeName: '退货退款', quantity: 1, amount: 1000 });
  for (let i = 0; i < 2; i++) rows.push({ status: '已取消', typeName: '', quantity: 1, amount: 1000 });
  for (let i = 0; i < 5; i++) rows.push({ status: '已发货', typeName: '', quantity: 1, amount: 1000 });
  const g = aggregate(rows);
  ok(g.returnEvents === 21, 'returnEvents=' + g.returnEvents);
  ok(g.totalOrders === 26, 'totalOrders=' + g.totalOrders);
  const r = rate(g);
  ok(r !== null && Math.abs(r - 21 / 26) < 1e-9, 'rate=' + r);
  ok((r * 100).toFixed(1) === '80.8', 'display=' + (r * 100).toFixed(1));
});

// ② C-3 回归点：一单同时命中 refunded + 仅退款 → returnEvents 只 +1
check('② 退款成功+仅退款 一单只算一次', () => {
  const g = aggregate([{ status: '退款成功', typeName: '仅退款', quantity: 1, amount: 1000 }]);
  ok(g.returnEvents === 1, 'returnEvents=' + g.returnEvents);
  ok(g.refundedOrders === 1 && g.onlyRefundCount === 1, '计数器各自=1');
});

// ③ totalOrders=0 → null，不抛错不 NaN
check('③ totalOrders=0 返回 null', () => {
  const g = aggregate([{ status: '已取消', typeName: '', quantity: 1, amount: 1000 }]);
  const r = rate(g);
  ok(r === null, 'rate=' + r);
  ok(g.totalOrders === 0, 'totalOrders=' + g.totalOrders);
});

// ④ 取消单不进 totalQty、不进 qty
check('④ 取消单不进销量', () => {
  const g = aggregate([
    { status: '已取消', typeName: '', quantity: 3, amount: 900 },
    { status: '已发货', typeName: '', quantity: 2, amount: 600 },
  ]);
  ok(g.totalQty === 2, 'totalQty=' + g.totalQty);
  ok(g.qty === 2, 'qty=' + g.qty);
  ok(g.totalOrders === 1, 'totalOrders=' + g.totalOrders);
});

// ⑤ 仅退款计入 costQty（货损），退货退款不计
check('⑤ 仅退款计货损 / 退货退款不计', () => {
  const g1 = aggregate([{ status: '退款成功', typeName: '仅退款', quantity: 2, amount: 800 }]);
  ok(g1.costQty === 2 && g1.lossQty === 2, '仅退款 costQty=' + g1.costQty + ' lossQty=' + g1.lossQty);
  const g2 = aggregate([{ status: '退款成功', typeName: '退货退款', quantity: 2, amount: 800 }]);
  ok(g2.costQty === 0 && g2.lossQty === 0, '退货退款 costQty=' + g2.costQty);
});

// —— 源码级断言：shipped 公式与镜像一致的关键标记存在 ——
const SRC = fs.readFileSync(new URL('../app/renderer/app.js', import.meta.url), 'utf8');
check('⑥ app.js 使用 returnEvents（C-3 修复在位）', () => {
  // 源码形态在 2026-11-22 改过一次：分类谓词抽到 classifyOrder()，
  // 累加行从 refunded/isReturn/isOnly 变成 f.refunded/f.isReturn/f.isOnly。
  // 两种写法都要认，判据是「三个标记用 OR、一单只 +1」。
  ok(/if \((?:f\.)?refunded \|\| (?:f\.)?isReturn \|\| (?:f\.)?isOnly\) g\.returnEvents \+= 1;/.test(SRC), 'returnEvents 累加行未找到');
});
check('⑦ rate 分母为 0 时返回 null（守卫在位）', () => {
  ok(/totalOrders > 0 \? returnOrders \/ g\.totalOrders : null/.test(SRC), '守卫行未找到');
});

let pass = 0;
for (const [st, name] of results) {
  console.log(st, name);
  if (st === 'PASS') pass++;
}
console.log(`PASS ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
