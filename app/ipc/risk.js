'use strict';
/**
 * 商品检测域：检查每个商品能否参加平台活动，被判定假货的商品会带出原因。
 *
 * 接口：POST /bordeaux/mms/gift/query_event_goods_list  body {page, size}
 * 返回 goods_display_info_list[]：{goods_id, goods_name, hd_thumb_url, quantity,
 *   can_enroll_event: 1|0, cant_enroll_reason}
 * 注意：__mms.fetch.sync 有页面级接口白名单，必须在 /kit/freebie 页面上调用。
 *
 * 结果按店铺分包落盘：risk/store-<mallId>.json 每店一个商品包，risk/index.json 记索引。
 * 某店本次读失败时保留旧包并标 stale，不冲成空。
 */
module.exports = function registerRisk(ctx) {
  const { ipcMain, fs, path, RISK_DIR, RISK_INDEX_FILE, malls, createHiddenMallWindow, sleep, trace, writeJsonAtomic } = ctx;

  function saveRiskResult(result) {
    try {
      fs.mkdirSync(RISK_DIR, { recursive: true });
      const at = Number(result.at) || Date.now();
      const index = { version: 1, lastRunAt: at, stores: [] };
      for (const s of (result.stores || [])) {
        const file = 'store-' + String(s.mallId || 'unknown').replace(/[^\w-]/g, '_') + '.json';
        const full = path.join(RISK_DIR, file);
        const flagged = Array.isArray(s.flagged) ? s.flagged : [];
        let payload;
        if (s.error && !flagged.length) {
          // 本次没读到，沿用旧包
          let prev = null;
          try { if (fs.existsSync(full)) prev = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { /* ignore */ }
          payload = prev
            ? Object.assign({}, prev, { error: s.error, stale: true, lastTryAt: at })
            : { mallId: s.mallId, mallName: s.mallName, at, total: 0, flagged: [], error: s.error, stale: true, lastTryAt: at };
        } else {
          payload = {
            mallId: s.mallId, mallName: s.mallName, at,
            total: Number(s.total) || 0,
            flagged,
            error: s.error || null,
            stale: false,
            lastTryAt: at,
          };
        }
        writeJsonAtomic(full, payload);
        index.stores.push({
          mallId: s.mallId,
          mallName: s.mallName,
          file,
          at: payload.at,
          total: payload.total,
          flaggedCount: (payload.flagged || []).length,
          error: payload.error || null,
          stale: !!payload.stale,
        });
      }
      writeJsonAtomic(RISK_INDEX_FILE, index);
      return { ok: true, index };
    } catch (e) {
      trace('saveRiskResult FAIL: ' + ((e && e.message) || e));
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 读回上次检测结果，形状与 risk:goodsCheck 一致，渲染层不用分叉。 */
  function readRiskLast() {
    try {
      if (!fs.existsSync(RISK_INDEX_FILE)) return { ok: false, error: '还没有检测记录' };
      const index = JSON.parse(fs.readFileSync(RISK_INDEX_FILE, 'utf8'));
      const stores = [];
      for (const s of (index.stores || [])) {
        let pkg = null;
        try {
          const full = path.join(RISK_DIR, s.file);
          if (fs.existsSync(full)) pkg = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (_) { /* ignore */ }
        stores.push({
          mallId: s.mallId,
          mallName: s.mallName,
          total: pkg ? (Number(pkg.total) || 0) : 0,
          flagged: pkg && Array.isArray(pkg.flagged) ? pkg.flagged : [],
          error: (pkg && pkg.error) || s.error || null,
          stale: !!(pkg && pkg.stale),
          at: (pkg && pkg.at) || s.at || null,
        });
      }
      return {
        ok: true,
        at: index.lastRunAt || null,
        fromCache: true,
        flagged: stores.reduce((n, s) => n + s.flagged.length, 0),
        total: stores.reduce((n, s) => n + (s.total || 0), 0),
        stores,
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  ipcMain.handle('risk:goodsCheck', async (_e, opts) => {
    const o = opts || {};
    const list = Array.from(malls.values()).filter((m) => !o.mallId || m.id === o.mallId);
    if (!list.length) return { ok: false, error: '还没有店铺' };
    const out = [];
    for (const mall of list) {
      const item = { mallId: mall.id, mallName: mall.name, total: 0, flagged: [], error: null };
      let temp = null;
      try {
        temp = createHiddenMallWindow(mall);
        try { temp.setPosition(-10000, -10000); temp.showInactive(); } catch (_) { /* ignore */ }
        const wc = temp.webContents;
        try { await wc.loadURL('https://mms.pinduoduo.com/kit/freebie'); } catch (_) { /* ignore */ }
        await sleep(7000);
        const pageSize = 50;
        for (let page = 1; page <= 20; page++) {
          const raw = await wc.executeJavaScript(`(async () => {
            const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
            if (typeof mms !== 'function') return JSON.stringify({ __blocked: true });
            try {
              const r = await mms('POST', location.origin + '/bordeaux/mms/gift/query_event_goods_list', { page: ${page}, size: ${pageSize} });
              return JSON.stringify(r);
            } catch (e) {
              return JSON.stringify({ __error: String((e && e.message) || e) });
            }
          })()`, true);
          let r = raw;
          if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) { r = null; } }
          if (!r) { item.error = '接口无返回'; break; }
          if (r.__blocked) { item.error = '页面未就绪'; break; }
          if (r.__error) { item.error = r.__error; break; }
          const rows = r.goods_display_info_list || [];
          if (page === 1) item.total = Number(r.total) || rows.length;
          for (const g of rows) {
            if (Number(g.can_enroll_event) === 0) {
              item.flagged.push({
                goodsId: g.goods_id == null ? '' : String(g.goods_id),
                goodsName: g.goods_name || '',
                thumb: g.hd_thumb_url || '',
                quantity: Number(g.quantity) || 0,
                reason: g.cant_enroll_reason || '不可参加活动',
              });
            }
          }
          if (!rows.length || rows.length < pageSize) break;
          await sleep(300);
        }
      } catch (e) {
        item.error = String((e && e.message) || e);
      } finally {
        if (temp) { try { if (!temp.isDestroyed()) temp.destroy(); } catch (_) { /* ignore */ } }
      }
      out.push(item);
      await sleep(400);
    }
    const flagged = out.reduce((n, s) => n + s.flagged.length, 0);
    const result = { ok: true, at: Date.now(), flagged, total: out.reduce((n, s) => n + (s.total || 0), 0), stores: out };
    // 按店铺分包落盘，下次打开直接读回，不用重新检测
    const saved = saveRiskResult(result);
    if (saved.ok) result.saved = saved.index;
    else result.saveError = saved.error;
    return result;
  });

  /** 读回上次商品检测结果（按店铺商品包） */
  ipcMain.handle('risk:last', () => readRiskLast());

  return { saveRiskResult, readRiskLast };
};
