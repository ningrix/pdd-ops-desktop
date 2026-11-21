'use strict';
/**
 * 资金复盘纯计算层（Z-2）：零依赖、不碰 Electron、可离线断言。
 * main.js 直接 require；渲染层如需可经 <script> 挂 window.FinanceCore（IIFE 双环境导出）。
 */
(function () {

  /** 订单归一化（与 main.js 原 finance:orders 内联映射逐字段一致）。 */
  function normalizeOrder(it, mallId, mallName) {
    const status = it.order_status_str || String(it.order_status == null ? '' : it.order_status);
    const after = it.after_sales_status != null
      ? it.after_sales_status
      : (/退款|退货|换货|售后/.test(status) ? status : null);
    return {
      mallId,
      mallName,
      orderSn: it.order_sn || '',
      orderTime: Number(it.order_time) || null,
      status,
      afterSaleStatus: after,
      goodsId: it.goods_id == null ? '' : String(it.goods_id),
      goodsName: it.goods_name || '',
      spec: it.spec || '',
      quantity: Number(it.goods_number) || 0,
      goodsPrice: Number(it.goods_price) || 0,
      orderAmount: Number(it.order_amount) || 0,
      merchantDiscount: Number(it.merchant_discount) || 0,
      platformDiscount: Number(it.platform_discount) || 0,
      shippingAmount: Number(it.shipping_amount) || 0,
      trackingNumber: it.tracking_number || '',
      // 商品图：订单接口自带 thumb_url，退货/贡献列表直接复用，不额外下载
      thumbUrl: it.thumb_url || '',
    };
  }

  /** 逐页拉订单（Z-2）。fetchPage(pageNumber)：正常返回原始响应；null=超时；throw=接口异常。 */
  async function collectOrders({ fetchPage, maxPages, pageSize, mallId, mallName }) {
    const cap = Math.max(1, Number(maxPages) || 20);
    const size = Math.max(1, Number(pageSize) || 20);

  // —— 分页主循环（A-2 / Z-2）——
  // 终止：空页 / 累计达 total / 页数上限。orderSn 去重；
  // 只有「自然跑满页数上限且 total 还没采够」才标记 truncated（任务书 Z-2 ③）。
  const orders = [];
  const seenSn = new Set();
  let total = null;
  let error = null;
  let dupSkipped = 0;
  let p = 1;
  for (; p <= cap; p++) {
    let r = null;
    try {
      r = await fetchPage(p);
    } catch (e) {
      error = '订单接口失败：' + String((e && e.message) || e);
      break;
    }
    if (!r || r.__blocked) { error = (r && r.error) || '订单页未就绪'; break; }
    if (r.success === false) { error = r.errorMsg || r.error_msg || '订单接口失败'; break; }
    const res = r.result || r;
    const items = res.pageItems || [];
    if (total == null) total = res.totalItemNum == null ? null : Number(res.totalItemNum);
    if (!items.length) break;
    for (const it of items) {
      const sn = String(it.order_sn || '');
      if (sn && seenSn.has(sn)) { dupSkipped += 1; continue; }
      if (sn) seenSn.add(sn);
      orders.push(normalizeOrder(it, mallId, mallName));
    }
    if (total != null && orders.length >= total) break;
    if (p < cap) await sleep(500);
  }
  const hitCap = p > cap;
  const truncated = hitCap && total != null && orders.length < total;
  const truncatedNote = truncated
    ? ('订单 ' + orders.length + '/' + total + '（读取上限 ' + (cap * size) + ' 单）')
    : null;
  return { orders, total, error, truncated, truncatedNote, dupSkipped };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const api = { collectOrders, normalizeOrder, sleep };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.FinanceCore = api;
})();
