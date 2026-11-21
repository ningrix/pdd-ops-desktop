'use strict';
/**
 * B 线 · 售后单归一化
 *
 * 纯逻辑，零依赖，不做 IO，不碰 IPC / 平台接口。
 * 输入是「从页面或账单里读到的原始行」，输出是 AGENTS.md §6 约定的 AftersaleOrder。
 *
 * 两条铁律（AGENTS.md §1.3.6 / §6）：
 *   1. 金额一律用「分」为单位的整数
 *   2. 表示「未知」用 null，不用 false —— 把「没发生」和「还不知道」混成一个值，对账必然算错
 */

const TYPE = Object.freeze({
  REFUND_ONLY: 'refund_only',
  RETURN_REFUND: 'return_refund',
  EXCHANGE: 'exchange',
});

const INTERCEPT = Object.freeze({
  NONE: 'none',
  REQUESTED: 'requested',
  SUCCESS: 'success',
  FAILED: 'failed',
  UNSUPPORTED: 'unsupported',
});

const STATUS = Object.freeze({
  PENDING_MERCHANT: 'pending_merchant',
  PENDING_BUYER_SHIP: 'pending_buyer_ship',
  PENDING_RECEIVE: 'pending_receive',
  REFUNDED: 'refunded',
  CLOSED: 'closed',
  APPEALING: 'appealing',
});

const RISK = Object.freeze({
  MONEY_GOODS_LOST: 'money_goods_lost',
  IN_TRANSIT: 'in_transit',
  SAFE: 'safe',
  CLOSED: 'closed',
});

const DAY_MS = 86400000;

/** 取第一个非 undefined / 非 null 的键；全空返回 null */
function pick(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/** 任意时间表示 → 毫秒时间戳；认不出来返回 null（不是 0） */
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v); // 秒级时间戳兜底
  }
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return toMs(Number(s));
  const t = Date.parse(s.replace(/\//g, '-'));
  return Number.isFinite(t) ? t : null;
}

/** 金额：分。支持 '12.80' / 12.8 / '1280分' 这类脏输入 */
function toFen(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // 带小数点的一律按「元」理解
  return s.includes('.') ? Math.round(n * 100) : Math.round(n);
}

/** 只保留白名单里的值，其余归一成 null */
function oneOf(v, allowed) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return allowed.indexOf(s) >= 0 ? s : null;
}

/** 猜售后类型：先看显式字段，再看文案 */
function guessType(raw) {
  const explicit = oneOf(pick(raw, 'type', 'afterSaleType', 'asType'), Object.values(TYPE));
  if (explicit) return explicit;
  const hay = String(pick(raw, 'typeText', 'statusText', 'reason') || '');
  if (/换货/.test(hay)) return TYPE.EXCHANGE;
  if (/退货退款|退货/.test(hay)) return TYPE.RETURN_REFUND;
  if (/仅退款|退款/.test(hay)) return TYPE.REFUND_ONLY;
  return null;
}

/** 猜处理状态：状态字段优先，没有就用时间线推断 */
function guessStatus(raw, refundedAt, shippedAt) {
  const explicit = oneOf(pick(raw, 'status', 'asStatus'), Object.values(STATUS));
  if (explicit) return explicit;
  const hay = String(pick(raw, 'statusText', 'statusName') || '');
  if (/申诉/.test(hay)) return STATUS.APPEALING;
  if (/已关闭|已撤销|已取消/.test(hay)) return STATUS.CLOSED;
  if (/退款成功|已退款/.test(hay)) return STATUS.REFUNDED;
  if (/待商家收货|待收货/.test(hay)) return STATUS.PENDING_RECEIVE;
  if (/待买家寄回|待寄回/.test(hay)) return STATUS.PENDING_BUYER_SHIP;
  if (/待商家处理|待处理/.test(hay)) return STATUS.PENDING_MERCHANT;
  if (refundedAt) return STATUS.REFUNDED;
  if (shippedAt) return STATUS.PENDING_RECEIVE;
  return null;
}

/**
 * 归一化
 * @param {object} raw   原始行（字段名不固定，尽量兼容）
 * @param {number} [now] 当前时间毫秒，便于测试注入
 * @returns {object} AftersaleOrder
 */
function normalize(raw, now) {
  const t = now === undefined ? Date.now() : now;

  const asn = pick(raw, 'asn', 'afterSaleSn', 'after_sale_sn', 'sn');
  const orderSn = pick(raw, 'orderSn', 'order_sn', 'orderNo');

  const refundedAt = toMs(pick(raw, 'refundedAt', 'refundTime', 'refund_time'));
  const createdAt = toMs(pick(raw, 'createdAt', 'createTime', 'create_time', 'applyTime'));
  const deadlineAt = toMs(pick(raw, 'deadlineAt', 'deadline', 'autoConfirmAt', 'expireTime'));
  const paidAt = toMs(pick(raw, 'paidAt', 'payTime', 'pay_time'));
  // 发货包裹的签收时间（买家是否已收货），与「退货签收」是两件事
  const shipSignedAt = toMs(pick(raw, 'shipSignedAt', 'confirmTime', 'confirm_time', 'receiveTime'));

  const ship = raw && (raw.returnShip || raw.ship || {}) || {};
  // 退货包裹的签收时间（货是否回到手上）
  const returnSignedAt = toMs(pick(ship, 'signedAt', 'signTime'));
  const shipShippedAt = toMs(pick(ship, 'shippedAt', 'shipTime'));
  const receivedRaw = pick(ship, 'received', 'isReceived');

  // 收货：显式布尔优先；未知保持 null
  let received = null;
  if (receivedRaw === true || receivedRaw === 1) received = true;
  else if (receivedRaw === false || receivedRaw === 0) received = false;

  const itc = raw && (raw.intercept || {}) || {};
  const interceptState = oneOf(
    pick(itc, 'state', 'status'),
    Object.values(INTERCEPT)
  );

  const status = guessStatus(raw, refundedAt, shipShippedAt);

  // 是否已退款：明确的时间戳最可靠
  let refunded = null;
  if (refundedAt) refunded = true;
  else if (status === STATUS.REFUNDED) refunded = true;
  else if (status === STATUS.PENDING_MERCHANT
        || status === STATUS.PENDING_BUYER_SHIP
        || status === STATUS.PENDING_RECEIVE) refunded = false;

  const order = {
    asn: asn === null ? null : String(asn),
    orderSn: orderSn === null ? null : String(orderSn),
    mallId: pick(raw, 'mallId', 'mall_id'),
    goodsId: pick(raw, 'goodsId', 'goods_id'),
    goodsName: pick(raw, 'goodsName', 'goods_name', 'title') || null,
    skuSpec: pick(raw, 'skuSpec', 'sku_spec', 'spec') || null,

    type: guessType(raw),
    reason: pick(raw, 'reason', 'refundReason', 'refund_reason') || null,
    amount: toFen(pick(raw, 'amount', 'refundAmount', 'refund_amount')),

    createdAt,
    paidAt,
    shipSignedAt,
    deadlineAt,
    status,
    remark: pick(raw, 'remark', 'note', 'memo') || null,

    refundedAt,
    refunded,
    // 技术服务费是否已退回：null = 未知。不要默认 false
    serviceFeeRefunded: (function () {
      const v = pick(raw, 'serviceFeeRefunded', 'feeRefunded');
      if (v === true || v === 1) return true;
      if (v === false || v === 0) return false;
      return null;
    })(),

    // 发货物流（商家寄出）。与退货物流是两条独立的单
    shipTracking: pick(raw, 'shipTracking', 'trackingNo', 'waybill') || null,
    shipCompany: pick(raw, 'shipCompany', 'expressCompany') || null,

    intercept: {
      state: interceptState,
      fee: toFen(pick(itc, 'fee', 'interceptFee')),
      at: toMs(pick(itc, 'at', 'time')),
    },

    returnShip: {
      company: pick(ship, 'company', 'expressCompany') || null,
      trackingNo: pick(ship, 'trackingNo', 'tracking_no', 'waybill') || null,
      shippedAt: shipShippedAt,
      signedAt: returnSignedAt,
      received,
    },

    risk: null,
    appeal: {
      state: oneOf(pick(raw.appeal, 'state'), ['none', 'drafted', 'submitted', 'won', 'lost']) || 'none',
      at: toMs(pick(raw.appeal, 'at')),
      evidenceMissing: [],
    },

    // 派生：距离平台自动同意还有多久。为负表示已超时
    deadlineLeft: deadlineAt === null ? null : deadlineAt - t,
    overdue: deadlineAt !== null && deadlineAt <= t,
  };

  return order;
}

/** 批量归一化，顺手丢掉连单号都没有的脏行 */
function normalizeAll(list, now) {
  if (!Array.isArray(list)) return [];
  return list
    .map((r) => normalize(r, now))
    .filter((o) => o.asn || o.orderSn);
}

/** 是否已有退货物流单号（用户在界面上问的「已退货单号」） */
function hasReturnTracking(o) {
  return !!(o && o.returnShip && o.returnShip.trackingNo);
}

/** 货是否已回到手上 */
function returned(o) {
  return !!(o && o.returnShip && o.returnShip.received === true);
}

module.exports = {
  TYPE, INTERCEPT, STATUS, RISK, DAY_MS,
  pick, toMs, toFen, oneOf,
  normalize, normalizeAll,
  hasReturnTracking, returned,
};
