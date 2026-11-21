'use strict';
/**
 * B 线 · 一键申诉文案
 *
 * 关键判断：平台判责看「要素是否齐全」，不看文采。
 * 所以本模块产出四段：举证清单 → 已填要素 → 缺什么 → 按判责口径组织的说明。
 *
 * 边界（AGENTS.md §1.2.1）：只生成文本，**绝不自动提交**。
 * 申诉次数有限、提交不可撤回，必须人工过目后手动提交。
 */

const { TYPE, STATUS, hasReturnTracking, returned } = require('./model');

/** 举证要素字典。auto=true 表示能从售后单里自动填出 */
const EVIDENCE = Object.freeze({
  asn:            { label: '售后单号',      auto: true },
  orderSn:        { label: '订单号',        auto: true },
  amount:         { label: '退款金额',      auto: true },
  shipTracking:   { label: '发货物流单号',  auto: true },
  shipSigned:     { label: '签收记录',      auto: true },
  interceptState: { label: '拦截处理记录',  auto: true },
  returnTracking: { label: '退货物流单号',  auto: true },
  returnSigned:   { label: '退货签收时间',  auto: true },
  reason:         { label: '买家退款原因',  auto: true },
  preShipPhoto:   { label: '发货前商品实拍', auto: false, how: '上传发货打包时的照片（带面单更佳）' },
  openBoxVideo:   { label: '开箱视频',      auto: false, how: '拍摄退货包裹开箱全过程，一镜到底不剪辑' },
  weighRecord:    { label: '称重记录',      auto: false, how: '快递称重截图或驿站磅单，用于证明空包/少件' },
  qcReport:       { label: '质检报告',      auto: false, how: '第三方质检报告或出厂检验单' },
  chatLog:        { label: '客服沟通记录',  auto: false, how: '截图买家承认已收货 / 无质量问题的对话' },
});

/** 场景：key → 需要的举证要素 + 事实经过模板 */
const SCENES = Object.freeze({
  refund_only_signed: {
    label: '仅退款 · 买家已签收',
    need: ['shipTracking', 'shipSigned', 'preShipPhoto', 'chatLog'],
    fact: (o, f) => [
      `订单已于 ${f.signedAt} 签收（${f.tracking}），签收地址与订单收货地址一致。`,
      `买家以「${o.reason || '未说明'}」申请仅退款，未提出商品质量或与描述不符的具体问题。`,
      '商品已按订单页面描述发出，规格与图文一致。',
    ],
    ask: '请求驳回仅退款申请，改为退货退款；或由买家提供商品与描述不符的举证。',
  },

  refund_only_unsigned: {
    label: '仅退款 · 包裹在途',
    need: ['shipTracking', 'interceptState'],
    fact: (o, f) => [
      `包裹仍在途（${f.tracking}），尚未签收。`,
      o.intercept && o.intercept.state === 'requested'
        ? '商家已发起物流拦截，包裹正在退回途中。'
        : '商家已联系物流方尝试拦截。',
      '买家以「未收到货」为由申请仅退款。',
    ],
    ask: '请在拦截结果明确后再处理退款；若拦截失败，按平台规则转为退货退款流程。',
  },

  return_not_received: {
    label: '退款已成功 · 退货未收到',
    need: ['returnTracking', 'returnSigned', 'chatLog'],
    fact: (o, f) => [
      o.refundedAt ? `货款已于 ${f.refundedAt} 退出。` : '货款已退出。',
      hasReturnTracking(o)
        ? `退货物流单号 ${o.returnShip.trackingNo}，但至今未收到实物。`
        : '系统内无退货物流单号，商家未收到任何退回包裹。',
      '存在款已退、货未回的实际损失。',
    ],
    ask: '请求平台介入核实退货物流真实性，并要求买家提供签收凭证；若确未退回，申请追偿。',
  },

  return_empty_or_swap: {
    label: '退货异常 · 空包 / 少件 / 调包',
    need: ['openBoxVideo', 'weighRecord', 'returnTracking', 'returnSigned', 'qcReport'],
    fact: (o, f) => [
      `退回包裹于 ${f.returnSignedAt} 签收。`,
      `买家退款原因为「${o.reason || '未说明'}」，商家开箱验货发现实物与订单不符。`,
      '已录制完整开箱视频并留存称重记录，可证明包裹内件异常。',
    ],
    ask: '请求按验货结果处理：驳回退款或按实际损失金额部分退款。',
  },

  late_or_fake_ship: {
    label: '延迟发货 / 虚假发货',
    need: ['shipTracking', 'shipSigned'],
    fact: (o, f) => [
      `订单于 ${f.tracking} 交寄，物流揽收时间在平台承诺时效内。`,
      '物流轨迹完整，不存在虚假发货情形。',
    ],
    ask: '请求撤销处罚；如已产生扣款，申请退还。',
  },

  not_needed: {
    label: '无需申诉 · 款货两清',
    need: [],
    fact: () => [
      '货款已退出，退回商品已收回并完成验货。',
      '本次售后无实际损失需要追偿。',
    ],
    ask: '无需申诉。请核对本单基础技术服务费是否已按规则退回。',
  },

  generic: {
    label: '通用申诉',
    need: ['orderSn', 'reason'],
    fact: (o) => [
      `买家以「${o.reason || '未说明'}」发起售后。`,
      '商家认为处理结果与实际履约情况不符。',
    ],
    ask: '请求平台复核该笔售后的处理结果。',
  },
});

function fen2yuan(fen) {
  if (fen === null || fen === undefined) return '-';
  return '¥' + (fen / 100).toFixed(2);
}

function fmt(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 选场景 */
function pickScene(o) {
  const t = o.type;
  const g = returned(o);
  const signed = !!(o.returnShip && o.returnShip.signedAt) || !!(o.shipSignedAt);

  if (o.refunded === true && t === TYPE.RETURN_REFUND && !g) return 'return_not_received';
  if (t === TYPE.RETURN_REFUND && g) {
    // 款已退、货已回：没有可追偿的损失，不该提供申诉
    if (o.refunded === true) return 'not_needed';
    const hay = String(o.reason || '') + String(o.remark || '');
    if (/空包|少件|调包|不符|破损|缺件|假货/.test(hay)) return 'return_empty_or_swap';
    if (/发货|物流|未收到|延迟/.test(hay)) return 'late_or_fake_ship';
    // 货已收到但商家不认可退款理由 → 按验货争议处理
    return 'return_empty_or_swap';
  }
  if (t === TYPE.REFUND_ONLY) {
    // 用发货物流的签收时间判断，不是退货签收
    const shipSignedAt = o.shipSignedAt || (o.returnShip && o.returnShip.signedAt) || null;
    return shipSignedAt ? 'refund_only_signed' : 'refund_only_unsigned';
  }
  if (/发货|物流|未收到|延迟/.test(String(o.reason || ''))) return 'late_or_fake_ship';
  return 'generic';
}

/** 从售后单自动填要素 */
function autoFill(o) {
  const f = {};
  const add = (k, v) => { if (v !== null && v !== undefined && v !== '') f[k] = v; };

  add('asn', o.asn);
  add('orderSn', o.orderSn);
  add('amount', o.amount === null ? null : fen2yuan(o.amount));
  add('reason', o.reason);
  add('shipTracking', o.shipTracking);
  add('interceptState', o.intercept && o.intercept.state && o.intercept.state !== 'none'
    ? o.intercept.state : null);

  const shipSignedAt = o.shipSignedAt || null;
  if (shipSignedAt) f.shipSigned = fmt(shipSignedAt);

  const rs = o.returnShip || {};
  add('returnTracking', rs.trackingNo);
  if (rs.signedAt) f.returnSigned = fmt(rs.signedAt);

  return f;
}

/**
 * 生成申诉包
 * @param {object} o     AftersaleOrder
 * @param {object} [ctx] { attachments: { preShipPhoto:true, ... }, shopName, platform }
 * @returns {object}
 */
function build(o, ctx) {
  const c = ctx || {};
  const own = c.attachments || {};
  const sceneKey = pickScene(o);
  const scene = SCENES[sceneKey];
  const filled = autoFill(o);

  const evidence = [];
  const missing = [];

  for (const key of scene.need) {
    const meta = EVIDENCE[key] || { label: key, auto: false };
    if (filled[key]) {
      evidence.push({ key, label: meta.label, value: filled[key], source: 'auto' });
    } else if (own[key]) {
      evidence.push({ key, label: meta.label, value: '已附（人工上传）', source: 'attachment' });
    } else {
      missing.push({ key, label: meta.label, how: meta.how || '需人工补充' });
    }
  }

  const factLines = scene.fact(o, {
    tracking: (o.returnShip && o.returnShip.trackingNo) || (filled.shipTracking || '-'),
    signedAt: filled.shipSigned || '-',
    returnSignedAt: filled.returnSigned || '-',
    refundedAt: fmt(o.refundedAt),
  });

  const head = [
    `【售后单号】${o.asn || '-'}　【订单号】${o.orderSn || '-'}`,
    `【售后类型】${scene.label}　【退款金额】${fen2yuan(o.amount)}`,
  ].join('\n');

  const body = ['【事实经过】']
    .concat(factLines.map((s, i) => `${i + 1}. ${s}`))
    .join('\n');

  const evLine = evidence.length
    ? '【已提供举证】' + evidence.map((e) => e.label).join('、')
    : '【已提供举证】（无）';

  const missLine = missing.length
    ? '【尚缺举证】' + missing.map((m) => m.label).join('、') + '（建议补齐后再提交）'
    : '';

  const text = [head, '', body, '', evLine, missLine, '', '【请求】' + scene.ask]
    .filter((s) => s !== '')
    .join('\n');

  return {
    scene: sceneKey,
    sceneLabel: scene.label,
    title: `${scene.label}｜${o.orderSn || o.asn || ''}`,
    evidence,
    missing,
    ready: missing.length === 0,
    text,
    // 提醒调用方：不要拿这个直接提交
    submitPolicy: 'manual_only',
  };
}

module.exports = { build, pickScene, autoFill, EVIDENCE, SCENES, fen2yuan, fmt };
