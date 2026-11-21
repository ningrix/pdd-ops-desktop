'use strict';
/**
 * B 线 · 拼多多账单对账
 *
 * 核心事实（AGENTS.md §3 / §6）：
 *   1. 基础技术服务费 = (实付 + 平台优惠) × 0.6%；先用后付同为 0.6%
 *   2. 2024-09-24 起支付的订单发生退款，基础技术服务费自动退回
 *   3. 推广费在平台账单里是「日汇总」，物理上无法追溯到单笔订单
 *
 * 因此对账只能分三层：
 *   订单级 —— 7 项可精确核对，逐单差额
 *   日级   —— 推广费按天摊，不下沉到单
 *   汇总级 —— 平台账单 vs 自算，差额定位到哪一天哪一类
 *
 * 金额约定：一律「分」为整数；账单条目 amount **带符号**，正数为收入/退回，负数为扣费。
 */

const { toFen, toMs } = require('./model');

/** 基础技术服务费率。来源：拼多多 2024 公告（媒体转述），AGENTS.md §3 已登记 */
const TECH_FEE_RATE = 0.006;

/** 先用后付费率。2024-09-12 起由 1% 下调为 0.6% */
const TECH_FEE_RATE_PAY_LATER = 0.006;

/** 技术服务费可退的起点：2024-09-24 00:00:00（北京时间） */
const FEE_REFUND_FROM = Date.UTC(2024, 8, 23, 16, 0, 0);

/** 未确认：黑标技术服务费按类目差异化，官方费率表未见完整版本，不内置具体数值 */
const BLACK_LABEL_RATE = Object.freeze({
  // 例：apparel 2.2%（来源为第三方问答，未在官方文档核实）→ 默认不启用
});

const CAT = Object.freeze({
  BASE_TECH_FEE: 'base_tech_fee',
  BLACK_LABEL_FEE: 'black_label_fee',
  FREIGHT_INSURANCE: 'freight_insurance',
  REFUND: 'refund',
  COUPON_SELLER: 'coupon_seller',
  SUBSIDY: 'subsidy',
  AD_SPEND: 'ad_spend',
});

/** 能精确追溯到订单的类目 */
const ORDER_LEVEL_CATS = [
  CAT.BASE_TECH_FEE, CAT.BLACK_LABEL_FEE, CAT.FREIGHT_INSURANCE,
  CAT.REFUND, CAT.COUPON_SELLER, CAT.SUBSIDY,
];

/** 只能按日汇总的类目 */
const DAY_LEVEL_CATS = [CAT.AD_SPEND];

/**
 * 计算单笔订单的基础技术服务费
 * @param {number} paidFen            消费者实付（分）
 * @param {number} platformDiscountFen 平台优惠金额（分，可为 0）
 * @param {string} [payType]          'pay_later' 表示先用后付
 * @returns {number} 应扣技术服务费（分，正数）
 */
function techFeeOf(paidFen, platformDiscountFen, payType) {
  const paid = Number(paidFen) || 0;
  const disc = Number(platformDiscountFen) || 0;
  const rate = payType === 'pay_later' ? TECH_FEE_RATE_PAY_LATER : TECH_FEE_RATE;
  return Math.round((paid + disc) * rate);
}

/** 该单是否在「退款可退技术服务费」的时间范围内 */
function feeRefundEligible(order) {
  if (!order || order.refunded !== true) return { eligible: false, basis: 'not_refunded' };
  const t = toMs(order.paidAt) || toMs(order.createdAt) || toMs(order.refundedAt);
  if (t === null) return { eligible: false, basis: 'no_date' };
  return {
    eligible: t >= FEE_REFUND_FROM,
    basis: order.paidAt ? 'paidAt' : (order.createdAt ? 'createdAt(近似)' : 'refundedAt(近似)'),
  };
}

/** 把账单按订单号索引 */
function indexBills(bills) {
  const map = new Map();
  for (const b of Array.isArray(bills) ? bills : []) {
    const key = b && (b.orderSn || b.order_sn);
    if (!key) continue;
    const k = String(key);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push({
      date: b.date || null,
      orderSn: k,
      category: b.category || null,
      amount: Number(b.amount) || 0,
      traceable: b.traceable !== false,
    });
  }
  return map;
}

function splitFee(entries) {
  let charged = 0;
  let refunded = 0;
  for (const e of entries) {
    if (e.category !== CAT.BASE_TECH_FEE) continue;
    const a = e.amount;
    if (a < 0) charged += -a;
    else if (a > 0) refunded += a;
  }
  return { charged, refunded };
}

function sumCat(entries, cat) {
  let s = 0;
  for (const e of entries) if (e.category === cat) s += e.amount;
  return s;
}

/**
 * 单笔已退款订单的对账核销 —— 这是「已退款待对账清单」的一行
 * @returns {object}
 */
function checkRefundedOrder(order, entries) {
  const list = entries || [];
  const { charged, refunded: feeBack } = splitFee(list);
  const elig = feeRefundEligible(order);

  const expectedFeeBack = elig.eligible ? charged : 0;
  const feeDiff = expectedFeeBack - feeBack;

  // 退款金额：账单里的 refund 是负数，取绝对值比对
  const billRefund = -sumCat(list, CAT.REFUND);
  const amountDiff = order.amount === null ? 0 : billRefund - order.amount;

  const notes = [];
  if (!elig.eligible && elig.basis === 'not_refunded') notes.push('该单未退款，不需核销');
  if (elig.eligible && charged === 0) notes.push('账单里没有这笔的技术服务费扣费记录');
  if (feeDiff > 0) notes.push(`技术服务费应退 ${fen(feeDiff)} 未退`);
  if (feeDiff < 0) notes.push(`技术服务费多退 ${fen(-feeDiff)}`);
  if (order.amount === null) notes.push('售后单缺退款金额，无法核对');
  else if (amountDiff !== 0) notes.push(`退款金额差 ${fen(amountDiff)}`);
  if (list.length === 0) notes.push('账单里找不到这个订单');

  let status = 'ok';
  if (list.length === 0 || order.amount === null) status = 'unknown';
  else if (feeDiff !== 0 || amountDiff !== 0) status = 'diff';

  return {
    orderSn: order.orderSn,
    asn: order.asn,
    amount: order.amount,
    refundedAt: order.refundedAt,
    feeCharged: charged,
    feeExpectedRefund: expectedFeeBack,
    feeActualRefund: feeBack,
    feeDiff,
    billRefund,
    amountDiff,
    insurance: -sumCat(list, CAT.FREIGHT_INSURANCE),
    couponSeller: -sumCat(list, CAT.COUPON_SELLER),
    subsidy: sumCat(list, CAT.SUBSIDY),
    eligibleBasis: elig.basis,
    status,
    notes,
  };
}

/** 广告费按日汇总（唯一不可追溯的类目） */
function bucketAdSpend(bills) {
  const map = new Map();
  for (const b of Array.isArray(bills) ? bills : []) {
    if (!b || b.category !== CAT.AD_SPEND) continue;
    const d = String(b.date || '').slice(0, 10) || 'unknown';
    map.set(d, (map.get(d) || 0) + (Number(b.amount) || 0));
  }
  return [...map.entries()]
    .map(([date, amount]) => ({ date, amount: Math.abs(amount), traceable: false }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 全量对账
 * @param {AftersaleOrder[]} orders 已退款（或全部）售后单
 * @param {object[]} bills          账单条目
 */
function summarize(orders, bills) {
  const idx = indexBills(bills);
  const rows = [];
  const seen = new Set();

  for (const o of Array.isArray(orders) ? orders : []) {
    if (!o || !o.orderSn) continue;
    if (o.refunded !== true) continue;
    seen.add(o.orderSn);
    rows.push(checkRefundedOrder(o, idx.get(o.orderSn) || []));
  }

  const orderLevel = {};
  for (const c of ORDER_LEVEL_CATS) orderLevel[c] = 0;
  for (const b of Array.isArray(bills) ? bills : []) {
    if (b && orderLevel[b.category] !== undefined) orderLevel[b.category] += Number(b.amount) || 0;
  }

  const adDaily = bucketAdSpend(bills);
  const adTotal = adDaily.reduce((a, x) => a + x.amount, 0);

  const diffs = rows.filter((r) => r.status === 'diff');
  const unknown = rows.filter((r) => r.status === 'unknown');

  const unmatched = [];
  for (const [orderSn, entries] of idx.entries()) {
    if (!seen.has(orderSn)) {
      const total = entries.reduce((a, e) => a + e.amount, 0);
      unmatched.push({ orderSn, entries: entries.length, net: total });
    }
  }

  return {
    orderRows: rows,
    stats: {
      checked: rows.length,
      ok: rows.length - diffs.length - unknown.length,
      diff: diffs.length,
      unknown: unknown.length,
      feeDiffTotal: rows.reduce((a, r) => a + Math.max(0, r.feeDiff), 0),
      amountDiffTotal: rows.reduce((a, r) => a + r.amountDiff, 0),
    },
    orderLevel,
    dayLevel: {
      adSpend: adTotal,
      days: adDaily,
      note: '推广费在平台账单里是日汇总，无法追溯到单笔订单；任何声称能精确到单的实现都是错的',
    },
    unmatchedBills: unmatched,
  };
}

function fen(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  return '¥' + (n / 100).toFixed(2);
}

module.exports = {
  CAT, TECH_FEE_RATE, TECH_FEE_RATE_PAY_LATER, FEE_REFUND_FROM,
  ORDER_LEVEL_CATS, DAY_LEVEL_CATS, BLACK_LABEL_RATE,
  techFeeOf, feeRefundEligible, indexBills,
  checkRefundedOrder, bucketAdSpend, summarize, fen,
};
