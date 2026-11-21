'use strict';
/**
 * B 线 · 售后分诊
 *
 * 一张单子四个状态位（物流单号 / 拦截 / 退款 / 收货），交叉后只产生四种判定。
 * 核心只有一条：款已退、货未回 = 钱货两空，必须申诉。
 *
 * 第三个维度是处理倒计时 —— 超时平台自动同意退款，优先级高于全部。
 */

const { RISK, STATUS, returned } = require('./model');

/** 判定权重：数字越小越紧急 */
const RANK = Object.freeze({
  OVERDUE: 0,
  LOST: 1,
  TRANSIT: 2,
  REST: 3,
});

/**
 * 单张单子判定
 * @returns {{risk:string, why:string, confident:boolean}}
 *   confident=false 表示至少一个状态位是 null，判定基于推断而非事实
 */
function classify(o) {
  if (!o) return { risk: RISK.IN_TRANSIT, why: '空记录', confident: false };

  const r = o.refunded;          // true / false / null
  const g = returned(o);         // bool，货是否已收回
  const closed = o.status === STATUS.CLOSED;

  // 已关闭且从未退款 → 无损失
  if (closed && r === false) {
    return { risk: RISK.CLOSED, why: '售后已关闭，款未退', confident: true };
  }

  if (r === true && g) {
    return {
      risk: RISK.CLOSED,
      why: '款已退、货已回，只剩退回运费与技术服务费要核销',
      confident: true,
    };
  }
  if (r === true && !g) {
    return {
      risk: RISK.MONEY_GOODS_LOST,
      why: '款已退、货未回 —— 钱货两空，必须举证申诉',
      confident: true,
    };
  }
  if (r === false && g) {
    return {
      risk: RISK.SAFE,
      why: '款未退、货已回，可拒绝退款或二次销售',
      confident: true,
    };
  }
  if (r === false && !g) {
    return {
      risk: RISK.IN_TRANSIT,
      why: '款未退、货未回，等寄回或拦截生效',
      confident: true,
    };
  }

  // r === null：退款状态未知
  if (g) return { risk: RISK.SAFE, why: '货已回但退款状态未知', confident: false };
  return { risk: RISK.IN_TRANSIT, why: '退款与收货状态都未确认', confident: false };
}

/** 紧急度分档；closed/safe 一律落到 REST */
function rankOf(o, c) {
  if (o.overdue && c.risk !== RISK.CLOSED && c.risk !== RISK.SAFE) return RANK.OVERDUE;
  if (c.risk === RISK.MONEY_GOODS_LOST) return RANK.LOST;
  if (c.risk === RISK.IN_TRANSIT) return RANK.TRANSIT;
  return RANK.REST;
}

/**
 * 现在该做什么。这是分诊台唯一要回答的问题。
 * @returns {{code:string, label:string, why:string}}
 */
function nextAction(o, c) {
  if (o.status === STATUS.APPEALING) {
    return { code: 'wait_appeal', label: '等申诉结果', why: '已提交申诉' };
  }
  if (o.overdue && c.risk !== RISK.CLOSED && c.risk !== RISK.SAFE) {
    return {
      code: 'respond',
      label: '立即处理',
      why: '已超时，平台会自动同意退款',
    };
  }
  switch (c.risk) {
    case RISK.MONEY_GOODS_LOST:
      return { code: 'appeal', label: '一键申诉', why: '钱货两空，需要举证追偿' };
    case RISK.IN_TRANSIT:
      return o.intercept && o.intercept.state === 'requested'
        ? { code: 'track_intercept', label: '盯拦截进度', why: '拦截已发起，等结果' }
        : { code: 'watch', label: '盯倒计时', why: '等买家寄回或包裹在途' };
    case RISK.SAFE:
      return { code: 'restock', label: '可二次销售', why: '货已回，款未退' };
    case RISK.CLOSED:
    default:
      return { code: 'reconcile', label: '核对技术服务费', why: '已闭环，只需对账核销' };
  }
}

/** 生成分诊结果（不改原对象，返回包装） */
function triage(list) {
  const rows = (Array.isArray(list) ? list : []).map((o) => {
    const c = classify(o);
    return {
      order: o,
      risk: c.risk,
      why: c.why,
      confident: c.confident,
      rank: rankOf(o, c),
      action: nextAction(o, c),
      deadlineLeft: o.deadlineLeft,
      amount: o.amount === null ? 0 : o.amount,
    };
  });

  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // 同档：剩余时间短的在前，没有截止时间的排后面
    const al = a.deadlineLeft === null ? Number.POSITIVE_INFINITY : a.deadlineLeft;
    const bl = b.deadlineLeft === null ? Number.POSITIVE_INFINITY : b.deadlineLeft;
    if (al !== bl) return al - bl;
    // 再看金额，大的在前
    if (a.amount !== b.amount) return b.amount - a.amount;
    return String(a.order.asn || '').localeCompare(String(b.order.asn || ''));
  });

  return rows;
}

/**
 * 汇总（给看板用）
 * @returns {object}
 */
function summarize(rows) {
  const out = {
    total: rows.length,
    overdue: 0,
    byRisk: { money_goods_lost: 0, in_transit: 0, safe: 0, closed: 0 },
    atRiskAmount: 0,        // 钱货两空的敞口（分）
    pendingReturn: 0,       // 还等着收货的单数
    lowConfidence: 0,       // 状态位不全，判定不稳
  };

  for (const r of rows) {
    // 只数「逾期且仍需处理」的。已闭环的单子截止时间必然已过，算进来没有意义
    if (r.rank === RANK.OVERDUE) out.overdue += 1;
    if (out.byRisk[r.risk] !== undefined) out.byRisk[r.risk] += 1;
    if (r.risk === RISK.MONEY_GOODS_LOST) out.atRiskAmount += r.amount;
    if (r.risk === RISK.IN_TRANSIT) out.pendingReturn += 1;
    if (!r.confident) out.lowConfidence += 1;
  }
  return out;
}

module.exports = { classify, triage, summarize, nextAction, rankOf, RANK };
