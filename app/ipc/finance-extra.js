'use strict';
/**
 * 资金域（明细部分）：售后退货清单、退货物流轨迹、费用设置、拿货成本账本、商品单位成本。
 *
 * 为什么叫 extra：finance:collect / :last / :orders / :ordersLast 仍在 main.js，
 * 它们依赖 createHiddenMallWindow 与资金快照的写入顺序，等下一轮再搬。
 *
 * 落盘文件（全部在 app/userdata/finance/ 下）：
 *   returns-manual.json  人工补录的退货单号/快递/完成标记
 *   return-traces.json   退货物流轨迹缓存
 *   carriers-learned.json 从轨迹里学到的快递 id→名称
 *   fees.json            平台费率与推广/快递/包装单价
 *   costs.json           按日期录入的拿货成本
 *   product-costs.json   按商品录入的单位成本
 *
 * 金额一律「分」。未知用 null，不用 false。
 */
module.exports = function registerFinanceextra(ctx) {
  const {
    ipcMain, app, fs, path, dialog, getMainWindow, FINANCE_DIR, FINANCE_COSTS_FILE,
    FINANCE_PRODUCT_COSTS_FILE, FINANCE_FEES_FILE, FINANCE_RETURNS_FILE, FINANCE_TRACES_FILE, FINANCE_CARRIER_FILE,
    CARRIER_BY_ID, malls, currentMall, createHiddenMallWindow, withPlatform,
    sleep, trace, writeJsonAtomic, loadCarrierLearned, saveCarrierLearned,
    carrierOf, loadReturnTraces, saveReturnTraces,
    parseReturnTrace, loadFinanceCosts, saveFinanceCosts, loadProductCosts, saveProductCosts,
    readFinanceFees, saveFinanceFees, readFinanceOrders,
  } = ctx;

  const xlsx = require('../lib/xlsx');
  const returnsExport = require('../lib/returns-export');

  /** 人工补录的退货单号 / 快递 / 完成标记（returns-manual.json）。 */
  function loadReturnsManual() {
    try {
      if (!fs.existsSync(FINANCE_RETURNS_FILE)) return {};
      const o = JSON.parse(fs.readFileSync(FINANCE_RETURNS_FILE, 'utf8'));
      return o && typeof o === 'object' ? o : {};
    } catch (_) { return {}; }
  }

  function saveReturnsManual(o) {
    fs.mkdirSync(FINANCE_DIR, { recursive: true });
    writeJsonAtomic(FINANCE_RETURNS_FILE, o);
  }

/** 售后退货清单：平台在途单 + 已完成退款单 + 本地手工补录/完成标记 */
ipcMain.handle('finance:returns', () => {
  const snap = readFinanceOrders();
  const manual = loadReturnsManual();
  const learned = loadCarrierLearned();
  const traces = loadReturnTraces();
  const rows = [];
  const seen = new Set();
  const nowSec = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const daysOf = (t) => (t ? Math.max(0, Math.floor((nowSec - Number(t)) / DAY)) : null);

  if (snap.ok && snap.data) {
    for (const s of (snap.data.stores || [])) {
      // ① 平台售后单（现在含已完成 status=5）
      for (const a of (s.afterSales || [])) {
        const m = manual[a.orderSn] || {};
        seen.add(a.orderSn);
        const days = daysOf(a.createdAt);
        const tr = traces[a.orderSn] || null;
        // 售后类型决定「需不需要退货」：未发货退款/仅退款不用退货，谈不上签收
        const needReturn = /退货/.test(String(a.typeName || ''));
        // status 5 = 已完成，10 = 待消费者寄货，11 = 待商家确认收货
        const stage = a.status === 5 ? 'done'
          : (a.status === 10 ? 'pending_ship' : (a.status === 11 ? 'in_transit' : 'pending'));
        let signed = null;
        let signedText = '未知';
        if (!needReturn) {
          // 未发货退款 / 仅退款：本来就没有退货包裹，谈不上签收
          signed = null;
          signedText = '无退货包裹';
        } else if (tr) {
          signed = tr.signed;
          signedText = tr.signed === true ? '已签收 · 注意查收' : (tr.signedText || '在途');
        } else if (stage !== 'done') {
          signed = false;
          signedText = '未签收';
        } else {
          // 已完成但还没抓过物流：不猜，标出来让人去抓
          signedText = '未抓签收';
        }
        rows.push({
          orderSn: a.orderSn,
          afterSalesId: a.id || '',
          mallId: s.mallId,
          mallName: s.mallName,
          goodsName: a.goodsName,
          thumbUrl: a.thumbUrl || '',
          refundAmount: a.refundAmount,
          platformStatus: a.status,
          platformTitle: a.title,
          typeName: a.typeName,
          needReturn,
          carrierId: a.carrierId == null ? null : Number(a.carrierId),
          returnSn: m.returnSn || a.returnSn || '',
          carrier: m.carrier || carrierOf(a.carrierId, m.returnSn || a.returnSn, learned),
          done: !!m.done,
          doneAt: m.doneAt || null,
          manual: !!m.returnSn || !!m.carrier || !!m.done,
          source: 'platform',
          stage,
          stageText: stage === 'done' ? '已完成'
            : (stage === 'pending_ship' ? '待寄回' : (stage === 'in_transit' ? '在途待收' : '待处理')),
          signed,
          signedText,
          traceNode: tr ? (tr.nodeText || '') : '',
          traceTime: tr ? (tr.nodeTime || '') : '',
          traceAt: tr ? (tr.at || null) : null,
          createdAt: a.createdAt || null,
          days,
          within21: days != null && days <= 21,
        });
      }

      // ② 已退款但没有售后单记录的（多为未发货退款），保持「未知」不猜
      for (const o of (s.orders || [])) {
        if (!/退款成功/.test(String(o.status || ''))) continue;
        if (!o.orderSn || seen.has(o.orderSn)) continue;
        seen.add(o.orderSn);
        const m = manual[o.orderSn] || {};
        const days = daysOf(o.orderTime);
        rows.push({
          orderSn: o.orderSn,
          mallId: s.mallId,
          mallName: s.mallName,
          goodsName: o.goodsName,
          thumbUrl: o.thumbUrl || '',
          refundAmount: Number(o.orderAmount) || 0,
          platformStatus: 5,
          platformTitle: o.status,
          typeName: '已退款',
          carrierId: null,
          returnSn: m.returnSn || '',
          carrier: m.carrier || '',
          done: !!m.done,
          doneAt: m.doneAt || null,
          manual: !!m.returnSn || !!m.carrier || !!m.done,
          source: 'refunded',
          stage: 'refunded',
          stageText: '已退款',
          // 退款已完成但货有没有退回来，平台接口拿不到 —— 未知用 null，不用 false
          signed: m.done ? true : null,
          signedText: m.done ? '已签收' : '未知',
          createdAt: o.orderTime || null,
          days,
          within21: days != null && days <= 21,
        });
      }
    }
  }

  // ③ 手工新增（平台已取不到的已完成单，人工补录）
  for (const [orderSn, m] of Object.entries(manual)) {
    if (seen.has(orderSn)) continue;
    const days = daysOf(m.createdAt || m.doneAt);
    rows.push({
      orderSn, mallId: m.mallId || null, mallName: m.mallName || '', goodsName: m.goodsName || '',
      thumbUrl: m.thumbUrl || '',
      refundAmount: Number(m.refundAmount) || 0, platformStatus: null, platformTitle: '',
      typeName: '手工补录', returnSn: m.returnSn || '', carrier: m.carrier || '',
      done: !!m.done, doneAt: m.doneAt || null, manual: true, source: 'manual',
      stage: m.done ? 'done' : 'manual',
      stageText: m.done ? '已完成' : '待核对',
      signed: m.done ? true : null,
      signedText: m.done ? '已签收' : '未知',
      createdAt: m.createdAt || null,
      days,
      within21: days != null && days <= 21,
    });
  }

  // 排序只按时间（新的在前）。已签收的留在原位，不沉底 —— 沉底后勾错了找不到。
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const within21 = rows.filter((r) => r.within21).length;
  const open = rows.filter((r) => !r.done).length;
  return { ok: true, at: Date.now(), rows, stats: { total: rows.length, within21, open } };
});

/**
 * 抓在途售后的真实退货物流轨迹（签收判断）。
 * 只有「售后接口能取到的在途单」有 afterSalesId，才能打开详情页；
 * 已完成退款（系统提前退款）没有 afterSalesId，详情页也取不到退货物流 —— 那些保持未知，不猜。
 */
ipcMain.handle('finance:returnTrace', async (_e, opts) => {
  const o = Object.assign({ maxItems: 200, force: false }, opts || {});
  const snap = readFinanceOrders();
  if (!snap.ok || !snap.data) return { ok: false, error: '还没有订单数据，先点「商品贡献」读取' };
  const traces = loadReturnTraces();
  const targets = [];
  for (const s of (snap.data.stores || [])) {
    for (const a of (s.afterSales || [])) {
      if (!a.id || !a.orderSn) continue;
      // 只有「退货退款」才需要查退货物流；未发货退款/仅退款没有退货包裹
      if (!/退货/.test(String(a.typeName || ''))) continue;
      // 断点续跑：已经抓过的跳过，除非显式 force
      if (!o.force && traces[a.orderSn]) continue;
      targets.push({ mallId: s.mallId, afterSalesId: String(a.id), orderSn: a.orderSn });
    }
  }
  const out = { ok: true, at: Date.now(), total: targets.length, checked: 0, signed: 0, noTrace: 0, failed: 0 };
  const limit = Math.min(targets.length, Math.max(1, Number(o.maxItems) || 60));
  for (let i = 0; i < limit; i++) {
    const it = targets[i];
    const mall = malls.get(it.mallId);
    if (!mall) { out.failed += 1; continue; }
    let temp = null;
    try {
      temp = createHiddenMallWindow(mall);
      try { temp.setPosition(-10000, -10000); temp.showInactive(); } catch (_) { /* ignore */ }
      const wc = temp.webContents;
      const url = 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=' +
        encodeURIComponent(it.afterSalesId) + '&orderSn=' + encodeURIComponent(it.orderSn);
      try { await wc.loadURL(url); } catch (_) { /* 跳转中断是常态 */ }
      let text = '';
      for (let k = 0; k < 12; k++) {
        await sleep(900);
        try {
          text = await wc.executeJavaScript(
            "(document.body.innerText||'').replace(/\\s+/g,' ')", true);
        } catch (_) { text = ''; }
        if (text && text.indexOf('退货物流') >= 0) break;
      }
      const tr = parseReturnTrace(text);
      if (tr) {
        traces[it.orderSn] = Object.assign({ at: Date.now() }, tr);
        out.checked += 1;
        if (tr.signed) out.signed += 1;
      } else {
        // 没有退货物流区块：可能是买家还没寄。记成「无轨迹」，仍然不是签收
        traces[it.orderSn] = {
          at: Date.now(), signed: false, signedText: '无轨迹',
          carrier: '', returnSn: '', nodeText: '', nodeTime: '', raw: '',
        };
        out.noTrace += 1;
      }
    } catch (e) {
      out.failed += 1;
    } finally {
      if (temp) { try { if (!temp.isDestroyed()) temp.destroy(); } catch (_) { /* ignore */ } }
    }
  }
  saveReturnTraces(traces);
  return out;
});

ipcMain.handle('finance:returnSet', (_e, entry) => {
  try {
    const e = entry || {};
    const orderSn = String(e.orderSn || '').trim();
    if (!orderSn) return { ok: false, error: '缺少订单号' };
    const manual = loadReturnsManual();
    const cur = manual[orderSn] || {};
    const next = Object.assign({}, cur);
    if (e.returnSn !== undefined) next.returnSn = String(e.returnSn || '').trim().slice(0, 40);
    if (e.carrier !== undefined) next.carrier = String(e.carrier || '').trim().slice(0, 30);
    // 手工填的快递名按 carrierId 记住，下次同快递自动带出
    if (e.carrier && e.carrierId) {
      const learned = loadCarrierLearned();
      learned[String(Number(e.carrierId))] = String(e.carrier).trim().slice(0, 30);
      saveCarrierLearned(learned);
    }
    if (e.done !== undefined) {
      next.done = !!e.done;
      next.doneAt = next.done ? Date.now() : null;
    }
    if (e.mallName !== undefined) next.mallName = String(e.mallName || '').slice(0, 60);
    if (e.goodsName !== undefined) next.goodsName = String(e.goodsName || '').slice(0, 120);
    if (e.refundAmount !== undefined) next.refundAmount = Math.round(Number(e.refundAmount) || 0);
    manual[orderSn] = next;
    saveReturnsManual(manual);
    return { ok: true, item: Object.assign({ orderSn }, next) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('finance:returnRemove', (_e, orderSn) => {
  try {
    const manual = loadReturnsManual();
    delete manual[String(orderSn || '')];
    saveReturnsManual(manual);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/** 费用扣项设置：平台费率/推广/快递/包装 */
ipcMain.handle('finance:feeGet', () => ({ ok: true, data: readFinanceFees() }));
ipcMain.handle('finance:feeSet', (_e, x) => {
  try { return { ok: true, data: saveFinanceFees(x || {}) }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

/** 拿货成本账本（本地 JSON，简单模式：采购当天计入现金成本） */
ipcMain.handle('finance:costList', () => {
  const rows = loadFinanceCosts();
  rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return { ok: true, items: rows };
});

ipcMain.handle('finance:costAdd', (_e, entry) => {
  try {
    const e = entry || {};
    const date = String(e.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日期格式必须是 YYYY-MM-DD' };
    const quantity = Number(e.quantity);
    const unitCost = Math.round(Number(e.unitCost));
    if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, error: '数量必须大于 0' };
    if (!Number.isFinite(unitCost) || unitCost < 0) return { ok: false, error: '单价必须是非负金额' };
    const rows = loadFinanceCosts();
    const item = {
      id: 'cost_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      date,
      mallId: e.mallId || null,
      productTitle: String(e.productTitle || '').slice(0, 120),
      quantity,
      unitCost,
      totalCost: Math.round(quantity * unitCost),
      supplier: String(e.supplier || '').slice(0, 80),
      note: String(e.note || '').slice(0, 200),
      createdAt: Date.now(),
    };
    rows.push(item);
    saveFinanceCosts(rows);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('finance:costDelete', (_e, id) => {
  try {
    const rows = loadFinanceCosts();
    const next = rows.filter((x) => x.id !== id);
    saveFinanceCosts(next);
    return { ok: true, removed: rows.length - next.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/** 商品单位拿货成本（商品贡献表内联录入） */
ipcMain.handle('finance:productCostList', () => ({ ok: true, items: loadProductCosts() }));

ipcMain.handle('finance:productCostSet', (_e, entry) => {
  try {
    const e = entry || {};
    const goodsId = String(e.goodsId || '').trim();
    const productName = String(e.productName || e.productTitle || '').trim().slice(0, 200);
    const unitCost = Math.round(Number(e.unitCost));
    if (!goodsId && !productName) return { ok: false, error: '缺少商品 ID/名称' };
    if (!Number.isFinite(unitCost) || unitCost < 0) return { ok: false, error: '单位成本必须是非负金额' };
    const rows = loadProductCosts();
    const idx = rows.findIndex((x) => (goodsId ? x.goodsId === goodsId : String(x.productName || '').replace(/\s+/g, '') === productName.replace(/\s+/g, '')));
    const item = { goodsId, productName, unitCost, updatedAt: Date.now() };
    if (idx >= 0) rows[idx] = Object.assign(rows[idx], item); else rows.push(item);
    saveProductCosts(rows);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('finance:productCostDelete', (_e, entry) => {
  try {
    const e = entry || {};
    const goodsId = String(e.goodsId || '').trim();
    const productName = String(e.productName || '').replace(/\s+/g, '');
    const rows = loadProductCosts();
    const next = rows.filter((x) => !(goodsId ? x.goodsId === goodsId : String(x.productName || '').replace(/\s+/g, '') === productName));
    saveProductCosts(next);
    return { ok: true, removed: rows.length - next.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/**
 * 导出退货跟进表为 Excel。
 *
 * 为什么在主进程写文件：渲染层是 file:// 页面，没有 fs；而且要用系统「另存为」
 * 对话框让用户选位置。xlsx 由 lib/xlsx.js 零依赖生成（见那里的注释：CSV 会把
 * 18 位订单号转成科学计数法）。
 *
 * 「是否完成」列：已完成写「是」，未完成**留空**（用户明确要求，不要写「未完成」）。
 */
ipcMain.handle('returns:export', async (_e, payload) => {
  try {
    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    if (!rows.length) return { ok: false, error: '没有可导出的行' };

    const table = returnsExport.buildRows(rows);
    if (table.length <= 1) return { ok: false, error: '没有可导出的行' };

    const stamp = (() => {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    })();

    // 传了 filePath 就直接写（自动化/批量导出用），否则弹「另存为」
    let target = (payload && typeof payload.filePath === 'string' && payload.filePath.trim()) || '';
    if (!target) {
      const opts = {
        title: '导出退货跟进',
        defaultPath: path.join(app.getPath('downloads'), '退货跟进_' + stamp + '.xlsx'),
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
      };
      const parent = typeof getMainWindow === 'function' ? getMainWindow() : null;
      const picked = parent
        ? await dialog.showSaveDialog(parent, opts)
        : await dialog.showSaveDialog(opts);
      if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
      target = picked.filePath;
    }

    const buf = xlsx.build({
      sheetName: '退货跟进',
      columns: returnsExport.COLUMNS,
      rows: table,
    });
    fs.writeFileSync(target, buf);
    return { ok: true, file: target, count: rows.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

  return {  };
};
