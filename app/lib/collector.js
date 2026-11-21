'use strict';
/**
 * 从「采集会话」当前页面提取商品数据。
 *
 * 实测结论（消费者端 H5，已登录，桌面/iPhone/微信/安卓 UA 与设备模拟全部试过）：
 *   能读到：标题、类目链、详情图、商品属性
 *   读不到：价格（服务端打码成 3??.88）、规格（skuProperty 恒为 []）、SKU 库存
 *   → 价格与规格是**服务端门禁**，与 UA/设备模拟无关。所以采集后必须人工补规格。
 */
const COLLECTOR_READ_JS = String.raw`(() => {
  const out = {
    ok: false,
    url: location.href,
    needLogin: false,
    source: null,
    title: null,
    gallery: [],
    detailGallery: [],
    property: [],
    cats: [],
    catId: null,
    price: null,
    marketPrice: null,
    sizes: [],
    colors: [],
    skus: [],
    skuCount: 0,
    catNames: [],
    missing: [],       // 需要人工补的字段
    notes: [],
  };

  const S = (v, n) => { try { return JSON.stringify(v).slice(0, n || 200); } catch (e) { return null; } };
  const pickNum = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

  let g = null;
  try {
    const init = (window.rawData && window.rawData.store && window.rawData.store.initDataObj) || {};
    if (init.needLogin) out.needLogin = true;
    g = init.goods || null;
  } catch (e) {
    out.notes.push('读取 rawData 失败: ' + (e && e.message));
  }

  if (g) {
    out.source = 'rawData';
    out.title = g.goodsName || null;
    out.catId = g.catID || null;

    // 类目链
    const chain = [g.catID1, g.catID2, g.catID3, g.catID4].filter((x) => Number(x) > 0);
    out.cats = chain;

    // 主图
    const tg = Array.isArray(g.topGallery) ? g.topGallery : [];
    out.gallery = tg.map((x) => (typeof x === 'string' ? x : (x && (x.url || x.imgUrl)))).filter(Boolean);

    // 详情图（这块数据很全，实测 11 张）
    const dg = Array.isArray(g.detailGallery) ? g.detailGallery : [];
    const dimgs = dg.map((x) => (typeof x === 'string' ? x : (x && (x.url || x.imgUrl)))).filter(Boolean);
    out.detailGallery = [...new Set(dimgs)];
    // 主图不足时用详情图补前 5 张（详情图通常也是 1:1 商品图）
    if (out.gallery.length < 3 && out.detailGallery.length) {
      out.gallery = [...new Set(out.gallery.concat(out.detailGallery.slice(0, 5)))];
      out.notes.push('主图接口只给 ' + tg.length + ' 张，已用详情图补足');
    }

    // 商品属性（填充物/绒子含量/版型…）—— 上架填属性时直接能用
    const gp = Array.isArray(g.goodsProperty) ? g.goodsProperty : [];
    out.property = gp.map((p) => ({
      key: p && p.key, values: (p && p.values) || [], ref_pid: p && p.ref_pid,
    })).filter((p) => p.key);

    // 价格 / 规格：服务端门禁，通常是 "0" 和 []
    out.price = pickNum(g.minGroupPrice || g.minOnSaleGroupPrice);
    out.marketPrice = pickNum(g.minNormalPrice || g.maxNormalPrice);
    const skus = Array.isArray(g.skus) ? g.skus : [];
    out.skuCount = skus.length;
    const sp = Array.isArray(g.skuProperty) ? g.skuProperty : [];
    if (sp.length) {
      // 若将来开放，按 parent_name 归到颜色/尺码
      const sz = {}, cl = {};
      for (const p of sp) {
        const pn = (p && (p.parent_name || p.parentName)) || '';
        for (const v of ((p && (p.values || p.specs)) || [])) {
          const nm = typeof v === 'string' ? v : (v && (v.spec_name || v.name));
          if (!nm) continue;
          if (/尺码|码数|size|鞋码/i.test(pn)) sz[nm] = 1;
          else if (/颜色|色彩|color/i.test(pn)) cl[nm] = 1;
        }
      }
      out.sizes = Object.keys(sz);
      out.colors = Object.keys(cl);
    }
  }

  // ---------- DOM 兜底 ----------
  if (!out.title) {
    const b = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
    // 商品页标题通常在「前往APP查看价格」之后、「商品详情」之前
    const m = b.match(/前往APP查看价格\s*(.{6,80}?)\s*商品详情/) ||
              b.match(/券后[^ ]*\s*(.{6,80}?)\s*商品详情/);
    if (m) { out.title = m[1].trim(); out.source = out.source || 'DOM'; }
  }
  if (!out.title && document.title) {
    out.title = String(document.title).replace(/\s*-\s*拼多多.*$/, '').slice(0, 120);
  }

  if (!out.gallery.length) {
    const imgs = [];
    for (const im of document.querySelectorAll('img')) {
      const src = im.currentSrc || im.src || '';
      if (!src || src.indexOf('pddpic.com') < 0) continue;
      if (im.naturalWidth && im.naturalWidth < 200) continue;
      imgs.push(src);
    }
    out.gallery = [...new Set(imgs)].slice(0, 10);
  }

  // ---------- 汇总 ----------
  if (!out.price) out.missing.push('价格（服务端打码，需自己定价）');
  if (!out.skuCount || !out.sizes.length && !out.colors.length) {
    out.missing.push('规格 · 颜色/尺码（服务端不下发，需人工补）');
  }
  out.catNames = out.cats;
  out.ok = !!(out.title && out.gallery.length);
  if (out.needLogin && !out.ok) out.notes.push('页面要求登录：先在采集会话里登录买家账号');
  return JSON.stringify(out);
})()`;

module.exports = { COLLECTOR_READ_JS };
