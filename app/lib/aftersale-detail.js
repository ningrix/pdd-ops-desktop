'use strict';
/**
 * 售后详情页文本解析 + 分诊建议。
 * 纯函数、零依赖，可离线断言（work/test-aftersale-detail.mjs）。
 *
 * 输入是售后详情页 (aftersales-ssr/detail) 的 innerText 压平成一行的结果。
 * 字段名来自实测，见 research/售后助手_可行性调查_2026-11-22.md。
 */

/** 从压平文本里取「标签：值」，取到下一个已知标签为止 */
function pick(text, label, stops) {
  const t = String(text || '');
  const i = t.indexOf(label);
  if (i < 0) return '';
  let rest = t.slice(i + label.length).replace(/^[:：\s]+/, '');
  const stopList = stops || ['退款金额', '申请原因', '发货物流公司', '退货快递单号',
    '订单编号', '成团时间', '收货信息', '物流轨迹', '备注', '售后状态', '协商详情',
    '官方退货', '退货方式', '退货包运费'];
  let end = rest.length;
  for (const s of stopList) {
    const k = rest.indexOf(s);
    if (k >= 0 && k < end) end = k;
  }
  return rest.slice(0, end).trim();
}

/** 「超过 5天10时33分32秒 则申请达成」→ 秒 */
function parseCountdown(text) {
  const m = String(text || '').match(/超过\s*(\d+)\s*天\s*(\d+)\s*时\s*(\d+)\s*分\s*(\d+)\s*秒/);
  if (!m) return null;
  return Number(m[1]) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** 是否提到「签收后需 N 小时内处理」 */
function parseSignedDeadlineHours(text) {
  const m = String(text || '').match(/退货被签收[^。]{0,12}?(\d+)\s*小时内处理/);
  return m ? Number(m[1]) : null;
}

function parseDetail(text) {
  const t = String(text || '');
  const out = {
    afterSalesCode: pick(t, '售后编码', ['售后类型', '退款金额']),
    typeText: pick(t, '售后类型', ['退款金额', '申请原因']),
    refundYuan: null,
    reason: pick(t, '申请原因', ['发货物流公司', '退货快递单号', '订单编号']),
    shipCarrier: '',
    shipSn: '',
    returnSn: '',
    statusText: '',
    countdownSec: parseCountdown(t),
    signedDeadlineHours: parseSignedDeadlineHours(t),
    protectLeft: null,
    hasChatImages: false,
  };
  const amt = t.match(/退款金额[:：]\s*¥?\s*([\d.]+)/);
  if (amt) out.refundYuan = Number(amt[1]);
  const ship = t.match(/发货物流公司[:：]\s*(\S+?)\s*发货快递单号[:：]\s*([A-Za-z0-9]+)/);
  if (ship) { out.shipCarrier = ship[1]; out.shipSn = ship[2]; }
  const rsn = t.match(/退货快递单号[:：]\s*([A-Za-z0-9]+)/);
  if (rsn) out.returnSn = rsn[1];
  // 售后状态：只在「售后状态」标签之后找，否则会先命中「售后类型：退货退款待商家处理」里的片段
  const stIdx = t.indexOf('售后状态');
  const stSeg = stIdx >= 0 ? t.slice(stIdx) : t;
  const STATUS_RE = /(买家已发货[，,]?\s*待商家处理|待商家确认收货|待消费者寄货|买家待寄回|待商家处理|待买家处理|平台处理中|平台介入中|退款成功|售后关闭|已签收待处理)/;
  const sm = stSeg.match(STATUS_RE);
  if (sm) out.statusText = sm[1].replace(/\s+/g, '');
  const pl = t.match(/本周剩余申请次数为\s*(\d+)\s*次/);
  if (pl) out.protectLeft = Number(pl[1]);
  // 「消费者与商家聊天时发送的图片： -」表示没有；有图时该位置是图片/链接
  const chat = t.match(/消费者与商家聊天时发送的图片[:：]\s*(\S?)/);
  out.hasChatImages = !!(chat && chat[1] && chat[1] !== '-');
  return out;
}

/**
 * 分诊建议。只输出「该做什么」，不代替人做决定。
 * 返回 { code, text, level }，level: urgent | act | wait | skip
 */
function triage(d, ctx) {
  const c = ctx || {};
  const sec = d && d.countdownSec;
  const status = String((d && d.statusText) || '');
  const reason = String((d && d.reason) || '');
  const typeText = String((d && d.typeText) || '');

  // 1) 时间最紧：24 小时内到期，先处理这一单
  if (sec != null && sec <= 24 * 3600) {
    return { code: 'urgent', level: 'urgent', text: '不到 24 小时，先处理这单' };
  }
  // 2) 原因落在「质量/破损/货不对板」：必须先备举证，不能盲同意也不能盲驳
  if (/质量|破损|污渍|瑕疵|描述|不符|假|空包|掉包/.test(reason)) {
    return { code: 'evidence', level: 'act', text: '涉及质量或货不对板，先备举证' };
  }
  // 3) 原因落在「主观不合适」：驳回基本赢不了，同意最省事（省复议额度）
  if (/尺码|大小|不喜欢|不想要|拍错|多拍|少拍/.test(reason)) {
    return { code: 'agree', level: 'skip', text: '主观原因，驳回难赢，建议同意' };
  }
  // 4) 退货已签收：货回来了，开箱核对后同意
  if (c.signed === true) {
    return { code: 'check', level: 'act', text: '退货已签收，开箱核对后同意' };
  }
  // 5) 需要退货但无轨迹：别急着驳回（无证据），也别先同意（货没确认）
  if (c.needReturn !== false && c.signed === false && /待商家确认收货|待商家处理/.test(status)) {
    return { code: 'wait_trace', level: 'wait', text: '退货无轨迹，等物流再处理' };
  }
  // 6) 待消费者寄货且拖了几天：催寄
  if (/待消费者寄货|待买家处理/.test(status) && c.days != null && c.days >= 3) {
    return { code: 'chase', level: 'act', text: '买家未寄回，催寄或联系消费者' };
  }
  // 7) 仅退款且无退货包裹
  if (c.needReturn === false) {
    return { code: 'refund_only', level: 'wait', text: '无退货包裹，按仅退款规则处理' };
  }
  if (/退货/.test(typeText)) {
    return { code: 'normal', level: 'act', text: '按流程核对退货' };
  }
  return { code: 'unknown', level: 'wait', text: '信息不足，打开详情看' };
}

module.exports = { parseDetail, triage, parseCountdown, parseSignedDeadlineHours };
