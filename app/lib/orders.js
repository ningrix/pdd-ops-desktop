'use strict';
/**
 * 订单列表读取（注入到拼多多订单页执行）。
 * 接口：POST /mangkhut/mms/recentOrderList
 * 已确认字段：goods_id / goods_name / goods_number / goods_price /
 *             order_amount / order_sn / order_time / after_sales_status
 */

function readOrderPage(params) {
  return `(async () => {
    const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
    if (typeof mms !== 'function') return { __blocked: true, error: '订单页 __mms 不可用' };
    try {
      const r = await mms('POST', location.origin + '/mangkhut/mms/recentOrderList', ${JSON.stringify(params)});
      return JSON.stringify(r);
    } catch (e) {
      return { success: false, errorMsg: String((e && e.message) || e) };
    }
  })()`;
}

function readOrderDom() {
  return `(() => {
    const parse = () => {
      const rows = [...document.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim())
      );
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 2 || r[1].indexOf('订单编号') < 0) continue;
        const h = r[1];
        const snm = h.match(/订单编号：\\s*([^\\s]+)/);
        const tm = h.match(/(?:下单时间|成交时间)：\\s*([0-9-]+ [0-9:]+)/);
        const n = rows[i + 1] || [];
        const product = n[0] || '';
        const idm = product.match(/ID:\\s*(\\d+)/);
        let name = product.split('ID:')[0].trim();
        let spec = '';
        if (product.indexOf('ID:') >= 0) {
          spec = product.split('ID:')[1].replace(/^\\s*\\d+\\s*/, '').trim();
        }
        out.push({
          orderSn: snm ? snm[1] : '',
          orderTimeText: tm ? tm[1] : '',
          status: n[1] || '',
          quantity: n[2] || '',
          goodsPrice: n[3] || '',
          orderAmount: n[4] || '',
          goodsId: idm ? idm[1] : '',
          goodsName: name,
          spec,
        });
      }
      return out;
    };
    return parse();
  })()`;
}

function readAllOrderDom(maxPages) {
  const max = Number(maxPages) || 20;
  return `(async () => {
    const parse = () => {
      const rows = [...document.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('td')].map(td => (td.innerText || '').replace(/\\s+/g, ' ').trim())
      );
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 2 || r[1].indexOf('订单编号') < 0) continue;
        const h = r[1];
        const snm = h.match(/订单编号：\\s*([^\\s]+)/);
        const tm = h.match(/(?:下单时间|成交时间)：\\s*([0-9-]+ [0-9:]+)/);
        const n = rows[i + 1] || [];
        const product = n[0] || '';
        const idm = product.match(/ID:\\s*(\\d+)/);
        let name = product.split('ID:')[0].trim();
        let spec = '';
        if (product.indexOf('ID:') >= 0) {
          spec = product.split('ID:')[1].replace(/^\\s*\\d+\\s*/, '').trim();
        }
        out.push({
          orderSn: snm ? snm[1] : '',
          orderTimeText: tm ? tm[1] : '',
          status: n[1] || '',
          quantity: n[2] || '',
          goodsPrice: n[3] || '',
          orderAmount: n[4] || '',
          goodsId: idm ? idm[1] : '',
          goodsName: name,
          spec,
        });
      }
      return out;
    };
    const all = [];
    const seen = new Set();
    for (let p = 0; p < ${max}; p++) {
      const rows = parse();
      let added = 0;
      for (const r of rows) {
        const key = r.orderSn || (r.goodsName + '|' + r.orderTimeText + '|' + r.spec);
        if (seen.has(key)) continue;
        seen.add(key); all.push(r); added++;
      }
      if (p >= ${max} - 1) break;
      const items = [...document.querySelectorAll('[class*="PGT_pagerItem"]')];
      const active = items.find(e => String(e.className).indexOf('PGT_pagerItemActive') >= 0);
      const idx = active ? items.indexOf(active) : -1;
      const next = items.slice(idx + 1).find(e => /^\\d+$/.test((e.innerText || '').trim()));
      if (!next) break;
      const before = rows.length;
      next.click();
      for (let w = 0; w < 20; w++) {
        await new Promise(r => setTimeout(r, 300));
        const now = parse();
        if (now.length !== before || next.className.indexOf('Active') >= 0) break;
      }
      await new Promise(r => setTimeout(r, 600));
    }
    return all;
  })()`;
}

function readAfterSales(params) {
  return `(async () => {
    const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
    if (typeof mms !== 'function') return JSON.stringify({ __blocked: true });
    try {
      const r = await mms('POST', location.origin + '/mercury/mms/afterSales/queryList', ${JSON.stringify(params)});
      return JSON.stringify(r);
    } catch (e) {
      return JSON.stringify({ __error: String((e && e.message) || e) });
    }
  })()`;
}

module.exports = { readOrderPage, readOrderDom, readAllOrderDom, readAfterSales };
