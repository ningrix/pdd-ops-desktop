'use strict';
/**
 * B 线 · 自测
 * 用法：node app/lib/aftersale/selftest.js
 * 零依赖，不联网，不碰平台。全部断言通过才 exit 0。
 */

const { model, triage, appeal, reconcile } = require('./index');

const NOW = Date.UTC(2026, 10, 17, 4, 0, 0); // 2026-11-17 12:00 北京时间
const rawOrders = require('./fixtures/orders.json');
const bills = require('./fixtures/bills.json');

let pass = 0;
let fail = 0;
const fails = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('  ok    ' + name);
  } catch (e) {
    fail += 1;
    fails.push(name + ' → ' + e.message);
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}

function eq(actual, expect, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expect);
  if (a !== b) throw new Error((msg || '') + ' 期望 ' + b + '，实得 ' + a);
}

function ok(v, msg) {
  if (!v) throw new Error(msg || '期望为真');
}

function has(s, sub) {
  if (String(s).indexOf(sub) < 0) throw new Error('文本缺少片段：' + sub);
}

const orders = model.normalizeAll(rawOrders, NOW);
const byAsn = (a) => orders.find((o) => o.asn === a);

console.log('\n=== 1. 归一化 ===');

t('五条样例全部保留', () => eq(orders.length, 5));

t('A：款已退、货未回、金额单位为分', () => {
  const o = byAsn('AS20261115001');
  eq(o.refunded, true, 'refunded');
  eq(o.returnShip.received, false, 'received');
  eq(o.amount, 12800, 'amount');
  eq(o.type, 'refund_only', 'type');
});

t('D：倒计时 6 小时且未超时', () => {
  const o = byAsn('AS20261117004');
  eq(o.overdue, false, 'overdue');
  eq(o.deadlineLeft, 6 * 3600 * 1000, 'deadlineLeft');
});

t('未知保持 null，不落成 false', () => {
  const o = model.normalize({ asn: 'X1', orderSn: 'O1' }, NOW);
  eq(o.refunded, null, 'refunded');
  eq(o.serviceFeeRefunded, null, 'serviceFeeRefunded');
  eq(o.amount, null, 'amount');
});

t('金额解析：元与分不混淆', () => {
  eq(model.toFen('12.80'), 1280, "'12.80'");
  eq(model.toFen(1280), 1280, '1280');
  eq(model.toFen('¥0.77'), 77, "'¥0.77'");
  eq(model.toFen(null), null, 'null');
});

console.log('\n=== 2. 分诊 ===');

const rows = triage.triage(orders);

t('排序：超时 → 钱货两空 → 在途 → 已闭环/安全', () => {
  eq(rows.map((r) => r.order.asn), [
    'AS20261116005', // E 已超时
    'AS20261115001', // A 钱货两空
    'AS20261117004', // D 在途
    'AS20261110002', // B 已闭环（截止时间更早）
    'AS20261115003', // C 安全
  ]);
});

t('判定封面没有错配', () => {
  eq(byAsnRisk('AS20261115001'), 'money_goods_lost');
  eq(byAsnRisk('AS20261110002'), 'closed');
  eq(byAsnRisk('AS20261115003'), 'safe');
  eq(byAsnRisk('AS20261117004'), 'in_transit');
  eq(byAsnRisk('AS20261116005'), 'money_goods_lost');
});

function byAsnRisk(asn) {
  const r = rows.find((x) => x.order.asn === asn);
  return r ? r.risk : null;
}

t('动作建议：钱货两空 → 申诉；已超时 → 立即处理', () => {
  eq(rows.find((r) => r.order.asn === 'AS20261115001').action.code, 'appeal');
  eq(rows.find((r) => r.order.asn === 'AS20261116005').action.code, 'respond');
  eq(rows.find((r) => r.order.asn === 'AS20261110002').action.code, 'reconcile');
});

const sum = triage.summarize(rows);

t('汇总：敞口金额与分档计数', () => {
  eq(sum.total, 5);
  eq(sum.byRisk.money_goods_lost, 2);
  eq(sum.byRisk.in_transit, 1);
  eq(sum.byRisk.safe, 1);
  eq(sum.byRisk.closed, 1);
  eq(sum.atRiskAmount, 21600, 'A 12800 + E 8800');
  eq(sum.overdue, 1);
  eq(sum.pendingReturn, 1);
  eq(sum.lowConfidence, 0);
});

console.log('\n=== 3. 申诉举证 ===');

const appealA = appeal.build(byAsn('AS20261115001'));

t('A：命中「仅退款·已签收」场景', () => {
  eq(appealA.scene, 'refund_only_signed');
});

t('A：自动填入发货单号与签收记录', () => {
  const keys = appealA.evidence.map((e) => e.key);
  ok(keys.indexOf('shipTracking') >= 0, '缺 shipTracking');
  ok(keys.indexOf('shipSigned') >= 0, '缺 shipSigned');
});

t('A：缺的举证被点名，且不允许直接提交', () => {
  const missing = appealA.missing.map((m) => m.key);
  ok(missing.indexOf('preShipPhoto') >= 0, '应缺发货前实拍');
  ok(missing.indexOf('chatLog') >= 0, '应缺客服记录');
  eq(appealA.ready, false);
  eq(appealA.submitPolicy, 'manual_only');
});

t('A：文案含事实经过与明确请求', () => {
  has(appealA.text, '【事实经过】');
  has(appealA.text, '【请求】');
  has(appealA.text, '不想要了');
  has(appealA.text, 'SF1234567890');
});

t('B：款货两清，不该提供申诉', () => {
  const b = appeal.build(byAsn('AS20261110002'));
  eq(b.scene, 'not_needed');
  eq(b.ready, true);
  has(b.text, '无需申诉');
});

t('E：缺发货单号时如实暴露', () => {
  const e = appeal.build(byAsn('AS20261116005'));
  eq(e.scene, 'refund_only_signed');
  ok(e.missing.map((m) => m.key).indexOf('shipTracking') >= 0, '应缺 shipTracking');
});

console.log('\n=== 4. 对账 ===');

const rec = reconcile.summarize(orders, bills);
const rowOf = (sn) => rec.orderRows.find((r) => r.orderSn === sn);

t('单笔费率：12800 × 0.6% = 77 分', () => {
  eq(reconcile.techFeeOf(12800, 0), 77);
  eq(reconcile.techFeeOf(12800, 0, 'pay_later'), 77);
});

t('A：技术服务费应退未退，判为差额', () => {
  const r = rowOf('261110-0001');
  eq(r.feeCharged, 77);
  eq(r.feeExpectedRefund, 77);
  eq(r.feeActualRefund, 0);
  eq(r.feeDiff, 77);
  eq(r.status, 'diff');
});

t('B：扣退相等，核销正常', () => {
  const r = rowOf('261108-0002');
  eq(r.feeDiff, 0);
  eq(r.amountDiff, 0);
  eq(r.status, 'ok');
});

t('E：账单里没有该单 → 状态未知，不冒判为 ok', () => {
  const r = rowOf('261113-0005');
  eq(r.status, 'unknown');
  ok(r.notes.indexOf('账单里找不到这个订单') >= 0, '应提示找不到');
});

t('统计：1 差额 / 1 正常 / 1 未知，应退合计 77', () => {
  eq(rec.stats.checked, 3);
  eq(rec.stats.diff, 1);
  eq(rec.stats.ok, 1);
  eq(rec.stats.unknown, 1);
  eq(rec.stats.feeDiffTotal, 77);
});

t('推广费只到日级，且标记不可追溯', () => {
  eq(rec.dayLevel.adSpend, 80000);
  eq(rec.dayLevel.days.length, 2);
  eq(rec.dayLevel.days[0].traceable, false);
  eq(rec.dayLevel.days[0].date, '2026-11-15');
});

t('账单里有、售后单里没有的单被单独列出', () => {
  eq(rec.unmatchedBills.length, 1);
  eq(rec.unmatchedBills[0].orderSn, '261109-9999');
  eq(rec.unmatchedBills[0].entries, 2);
});

t('2024-09-24 之前支付的订单不享受技术服务费退回', () => {
  const old = model.normalize({
    asn: 'Y1', orderSn: 'O-OLD', refundedAt: '2024-12-01T10:00:00+08:00',
    paidAt: '2024-09-01T10:00:00+08:00', amount: 10000,
  }, NOW);
  const r = reconcile.checkRefundedOrder(old, [
    { orderSn: 'O-OLD', category: 'base_tech_fee', amount: -60 },
    { orderSn: 'O-OLD', category: 'refund', amount: -10000 },
  ]);
  eq(r.feeExpectedRefund, 0, '不该退');
  eq(r.status, 'ok');
});

console.log('\n=== 结果 ===');
console.log('  通过 ' + pass + ' / 失败 ' + fail);
if (fail) {
  console.log('\n失败明细：');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('  全部通过\n');
