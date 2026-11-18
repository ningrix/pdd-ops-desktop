'use strict';
/**
 * 从「采集会话」当前页面提取商品数据。
 * 注入到消费者端商品页执行（需已登录买家账号）。
 *
 * 已知：纯 HTTP 抓取返回 needLogin:true；登录后数据在
 * window.rawData.store.initDataObj.goods。DOM 兜底以防结构变动。
 */
const COLLECTOR_READ_JS = String.raw`(() => {
  const out = {
    ok: false,
    url: location.href,
    needLogin: false,
    source: null,
    title: null,
    gallery: [],
    price: null,
    marketPrice: null,
    sizes: [],
    colors: [],
    skus: [],
    skuCount: 0,
    catNames: [],
    rawKeys: [],
    notes: []
  };

  const pickNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  };

  // ---------- 1. 尝试 rawData ----------
  try {
    const rd = window.rawData || {};
    const store = rd.store || {};
    const init = store.initDataObj || {};
    out.rawKeys = Object.keys(init).slice(0, 20);

    if (init.needLogin) out.needLogin = true;

    // 常见路径逐个试
    const cands = [
      init.goods,
      init.goodsInfo,
      init.goodsDetail,
      (init.goodsData || {}).goods,
      init.detail && init.detail.goods,
      rd.goods
    ].filter(Boolean);

    let g = null;
    for (const c of cands) {
      if (c && (c.goodsName || c.goods_name || c.goodsID || c.skus || c.sku)) { g = c; break; }
    }

    if (g) {
      out.source = 'rawData';
      out.title = g.goodsName || g.goods_name || null;
      const gal = g.gallery || g.topGallery || g.banner || [];
      out.gallery = (Array.isArray(gal) ? gal : [])
        .map((x) => (typeof x === 'string' ? x : (x && (x.url || x.imgUrl || x.hdUrl))))
        .filter(Boolean);
      out.price = pickNum(g.minGroupPrice || g.min_group_price || g.minOnSaleGroupPrice);
      out.marketPrice = pickNum(g.marketPrice || g.market_price);
      const skus = g.skus || g.sku || g.skuList || [];
      if (Array.isArray(skus) && skus.length) {
        out.skuCount = skus.length;
        const sz = {}, cl = {};
        out.skus = skus.map((s) => {
          const specs = s.specs || s.spec || [];
          const flat = (Array.isArray(specs) ? specs : []).map((sp) => ({
            parent_name: sp.parent_name || sp.parentName || '',
            spec_name: sp.spec_name || sp.specName || ''
          }));
          for (const f of flat) {
            if (/尺码|码数|size|鞋码|码/i.test(f.parent_name)) sz[f.spec_name] = 1;
            else if (/颜色|色彩|color/i.test(f.parent_name)) cl[f.spec_name] = 1;
          }
          return {
            group: pickNum(s.groupPrice || s.group_price || s.multi_price),
            single: pickNum(s.normalPrice || s.normal_price || s.price),
            spec: flat
          };
        });
        out.sizes = Object.keys(sz);
        out.colors = Object.keys(cl);
      }
      const cats = [g.catName1 || g.cat_name_1, g.catName2 || g.cat_name_2,
                    g.catName3 || g.cat_name_3, g.catName4 || g.cat_name_4, g.catName]
        .filter(Boolean);
      out.catNames = cats;
    }
  } catch (e) {
    out.notes.push('rawData 解析异常: ' + (e && e.message));
  }

  // ---------- 2. DOM 兜底 ----------
  if (!out.title) {
    const t = document.querySelector('h1') ||
              document.querySelector('[class*=goodsName]') ||
              document.querySelector('[class*=goods-name]');
    if (t) { out.title = (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120); out.source = out.source || 'DOM'; }
  }
  if (!out.title) {
    const mt = document.title || '';
    if (mt && mt.length > 3) { out.title = mt.replace(/\s*-\s*拼多多.*$/, '').slice(0, 120); out.source = out.source || 'title'; }
  }

  if (!out.gallery.length) {
    const imgs = [];
    for (const im of document.querySelectorAll('img')) {
      const src = im.currentSrc || im.src || '';
      if (!src || src.indexOf('pddpic.com') < 0) continue;
      if (im.naturalWidth && im.naturalWidth < 200) continue;
      imgs.push(src);
    }
    out.gallery = [...new Set(imgs)].slice(0, 20);
    if (out.gallery.length && !out.source) out.source = 'DOM';
  }

  if (!out.price) {
    const txt = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
    const m = txt.match(/(?:¥|￥)\s*(\d+(?:\.\d{1,2})?)/);
    if (m) out.price = Math.round(parseFloat(m[1]) * 100);
  }

  // ---------- 3. 汇总 ----------
  out.ok = !!(out.title && out.gallery.length);
  if (out.needLogin && !out.ok) out.notes.push('页面要求登录：请在采集会话里扫码登录买家账号');
  return JSON.stringify(out);
})()`;

module.exports = { COLLECTOR_READ_JS };
