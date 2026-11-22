'use strict';
/**
 * 退货跟进表 → 二维数组（供 lib/xlsx 生成 Excel）。
 *
 * 纯函数、零依赖，可离线断言（test/test-returns-export.mjs）。
 *
 * 列定义与界面表格一致，另外把订单号单独成列（界面上它是商品名下面那行小字，
 * 导出后要靠它对账）。
 *
 * 「是否完成」列：已完成写「是」，**未完成留空字符串** —— 不要写「未完成」。
 * 空单元格在 Excel 里才好筛选/求和，也避免和「没读取到」混淆。
 */

const HEADER = ['订单号', '商品', '店铺', '状态', '签收情况', '退货单号', '快递', '退款(元)', '是否完成'];

/** 列宽（Excel 字符单位），与 HEADER 一一对应 */
const COLUMNS = [
  { w: 24 }, { w: 40 }, { w: 12 }, { w: 10 }, { w: 14 },
  { w: 22 }, { w: 10 }, { w: 11 }, { w: 9 },
];

function text(v) {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * @param {Array} rows finance:returns 的 rows
 * @returns {any[][]} 含表头的二维数组
 */
function buildRows(rows) {
  const out = [HEADER.slice()];
  for (const r of (rows || [])) {
    if (!r) continue;
    // 注意：Number(null) === 0，直接 Number() 会把「退款未知」导成 0 元。
    // 未知必须是 null（Excel 空格），不能是 0。
    const raw = r.refundAmount;
    const amt = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
    out.push([
      text(r.orderSn),
      text(r.goodsName),
      text(r.mallName),
      text(r.stageText),
      text(r.signedText),
      text(r.returnSn),
      text(r.carrier),
      Number.isFinite(amt) ? Math.round(amt) / 100 : null,   // 分 → 元
      r.done ? '是' : '',                                    // 未完成留空
    ]);
  }
  return out;
}

module.exports = { buildRows, HEADER, COLUMNS };
