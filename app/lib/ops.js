'use strict';
/**
 * 注入到拼多多后台页面执行的业务代码（已实测跑通）
 * 全部通过 view.webContents.executeJavaScript 执行，不需要 CDP 端口
 */

const PRELUDE = `
  const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
  if (typeof mms !== 'function') {
    return { __blocked: true, error: '页面还没就绪（__mms 不可用）。等后台加载完或确认已登录。' };
  }
  const safe = (e) => {
    if (!e) return null;
    if (typeof e === 'string') return e;
    const o = {};
    for (const k of ['message','error_msg','errorMsg','error_code','errorCode','success','reason']) {
      if (e[k] !== undefined) o[k] = e[k];
    }
    return Object.keys(o).length ? o : String(e);
  };
  const call = (url, body) => {
    const full = url.startsWith('http') ? url : location.origin + url;
    try {
      const r = mms('POST', full, body || {});
      return { ok: true, data: (r && r.result !== undefined) ? r.result : r };
    } catch (e) { return { ok: false, err: safe(e) }; }
  };
  const pick = (o, ...ks) => {
    if (!o) return undefined;
    for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k];
    return undefined;
  };
`;

const wrap = (body) => `(async () => {${PRELUDE}${body}})()`;

/** 环境自检 + 登录态 */
function ping() {
  return wrap(`
    const lg = call('/janus/api/checkLogin', {});
    return {
      ok: !!lg.ok,
      login: lg.ok ? !!(lg.data && lg.data.login) : false,
      href: location.href,
      hasMms: true,
      detail: lg.ok ? undefined : lg.err
    };
  `);
}

/** 列出在售商品 */
function listGoods(size = 30) {
  return wrap(`
    const r = call('/vodka/v2/mms/query/display/mall/goodsList',
      { page: 1, size: ${size}, is_onsale: 1, pre_sale_type: 4, shipment_time_type: 3, sold_out: 0 });
    if (!r.ok) return { ok: false, error: '拉取商品失败', detail: r.err };
    const arr = (r.data && r.data.goods_list) || [];
    return {
      ok: true,
      count: arr.length,
      total: r.data && r.data.total,
      items: arr.map((g, i) => {
        // 提取这个商品实际用到的尺码标签（来自 SKU 规格）
        const sizes = [];
        const seen = {};
        const skuList = Array.isArray(g.sku_list) ? g.sku_list : [];
        for (const s of skuList) {
          const specs = Array.isArray(s.spec) ? s.spec : (Array.isArray(s.specs) ? s.specs : []);
          for (const sp of specs) {
            const pn = sp.parent_name || sp.parentName || '';
            const sn = sp.spec_name || sp.specName || '';
            if (!sn) continue;
            if (!/尺码|码数|size|鞋码|码/i.test(pn)) continue;
            if (!seen[sn]) { seen[sn] = 1; sizes.push(String(sn)); }
          }
        }
        return {
          idx: i,
          goods_id: g.id,
          title: g.goods_name,
          cat_id: g.cat_id,
          catNames: [g.cat_name_1, g.cat_name_2, g.cat_name_3, g.cat_name_4, g.cat_name]
            .filter(Boolean),
          sizes,
          group_price: (g.sku_group_price || [])[0],
          single_price: (g.sku_price || [])[0],
          market_price: g.market_price,
          sku_count: g.sku_count,
          stock: g.quantity,
          sold: g.sold_quantity,
          thumb: g.thumb_url,
          onsale: g.is_onsale
        };
      })
    };
  `);
}

/** 复制成草稿：create_by_sn → copyGoodsCommit → 改名 → 回读 */
function copyGoods({ index = 0, title = '', submit = false } = {}) {
  return wrap(`
    const INDEX = ${Number(index) || 0};
    const TITLE = ${JSON.stringify(title || '')};
    const DO_SUBMIT = ${submit ? 'true' : 'false'};
    const R = { steps: [] };

    const ls = call('/vodka/v2/mms/query/display/mall/goodsList',
      { page: 1, size: Math.max(INDEX + 1, 20), is_onsale: 1,
        pre_sale_type: 4, shipment_time_type: 3, sold_out: 0 });
    if (!ls.ok) return { ok: false, error: '拉取商品失败', detail: ls.err };
    const arr = (ls.data && ls.data.goods_list) || [];
    const g = arr[INDEX];
    if (!g) return { ok: false, error: '没有第 ' + INDEX + ' 个商品（当前只有 ' + arr.length + ' 个）' };
    R.source = { goods_id: g.id, title: g.goods_name, sku_count: g.sku_count };
    R.steps.push('源商品 goods_id=' + g.id);

    // 平台自带的「是否已复制过」检查（失败不阻断，只作提示）
    try {
      const ex = call('/vodka/v2/mms/query/display/goods_copyed/is_exist', { goods_id: g.id });
      R.copyedBefore = ex.ok ? ex.data : null;
    } catch (e) { R.copyedBefore = null; }

    const cbs = call('/glide/v2/mms/edit/commit/create_by_sn', { goods_id: g.id });
    const srcCommit = cbs.ok ? pick(cbs.data, 'goods_commit_id') : undefined;
    if (!srcCommit) {
      return { ok: false, error: 'create_by_sn 未返回 commit_id',
               detail: cbs.err, source: R.source, steps: R.steps };
    }
    R.steps.push('源 commit_id=' + srcCommit);

    const cp = call('/glide/v2/mms/edit/commit/copyGoodsCommit',
      { goods_id: g.id, goods_commit_id: srcCommit });
    const newCommit = cp.ok ? pick(cp.data, 'goods_commit_id') : undefined;
    const newGoods  = cp.ok ? pick(cp.data, 'goods_id') : undefined;
    if (!newCommit) {
      return { ok: false, error: 'copyGoodsCommit 被平台拒绝',
               detail: cp.err, source: R.source, srcCommit, steps: R.steps };
    }
    R.steps.push('新草稿 commit=' + newCommit + ' / goods_id=' + newGoods);

    const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: newCommit });
    if (!d.ok) return { ok: false, error: '草稿回读失败', detail: d.err,
                        newCommit, newGoods, steps: R.steps };
    const catId = pick(d.data, 'cat_id');
    const sku = Array.isArray(d.data.sku) ? d.data.sku : [];

    // 从 SKU 的规格里提取这个商品实际用到的尺码标签
    const sizeSet = {};
    const sizes = [];
    for (const s of sku) {
      const specs = Array.isArray(s.spec) ? s.spec : [];
      for (const sp of specs) {
        const pn = sp.parent_name || '';
        const sn = sp.spec_name || '';
        if (!sn) continue;
        if (!/尺码|码数|size|鞋码|码/i.test(pn)) continue;
        if (!sizeSet[sn]) { sizeSet[sn] = 1; sizes.push(String(sn)); }
      }
    }

    if (TITLE) {
      const b = { goods_commit_id: newCommit, goods_name: TITLE };
      if (catId) b.cat_id = catId;
      const up = call('/glide/mms/goodsCommit/action/update_goods_commit_info', b);
      R.steps.push('改名 ' + (up.ok ? 'ok' : ('失败 ' + JSON.stringify(up.err))));
      if (!up.ok) R.renameError = up.err;
    } else {
      R.steps.push('未改标题（沿用源标题）');
    }

    const back = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: newCommit });
    const bd = back.ok ? back.data : {};

    if (DO_SUBMIT) {
      const sb = call('/glide/v2/mms/edit/commit/submit', { goods_commit_id: newCommit });
      R.steps.push('上架 ' + (sb.ok ? 'ok' : ('失败 ' + JSON.stringify(sb.err))));
      R.submit = { ok: sb.ok, detail: sb.ok ? sb.data : sb.err };
    } else {
      R.steps.push('停草稿（未上架）');
    }

    R.result = {
      goods_id: newGoods,
      commit_id: newCommit,
      title: bd.goods_name,
      is_draft: bd.is_shop === 0,
      images: (bd.galleries || []).length,
      skus: sku.length,
      sizes: sizes,
      cat_id: catId,
      catNames: [bd.cat_name_1, bd.cat_name_2, bd.cat_name_3, bd.cat_name_4, bd.cat_name]
        .filter(Boolean),
      freight_template: bd.cost_template_id,
      min_group_price: bd.min_group_price,
      market_price: bd.market_price,
      stock_warning: sku.length && sku.every(s => !s.quantity && !s.quantity_delta)
        ? '所有 SKU 库存为 0，上架前必须补库存' : 'ok'
    };
    R.ok = true;
    return R;
  `);
}

/** 查草稿 */
function draftDetail(commit) {
  return wrap(`
    const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: ${Number(commit)} });
    if (!d.ok) return { ok: false, error: d.err };
    const g = d.data, sku = Array.isArray(g.sku) ? g.sku : [];
    return {
      ok: true,
      goods_id: g.goods_id, commit_id: g.id, title: g.goods_name,
      cat_id: g.cat_id, is_draft: g.is_shop === 0,
      min_group_price: g.min_group_price, max_group_price: g.max_group_price,
      market_price: g.market_price, freight_template: g.cost_template_id,
      images: (g.galleries || []).length, skus: sku.length,
      sku_sample: sku.slice(0, 8).map(s => ({
        sku_id: s.sku_id, single: s.price, group: s.multi_price, qty: s.quantity
      }))
    };
  `);
}

/**
 * 反查某个商品"当前有效的"编辑 commit id
 * 用途：保存草稿之后 commit_id 可能被替换，旧 id 再提交会报 600001「该编辑不存在」
 */
function resolveCommit(goods) {
  return wrap(`
    const G = ${Number(goods)};
    if (!G) return { ok: false, err: '缺少 goods_id' };
    const r = call('/glide/v2/mms/edit/commit/create_by_sn', { goods_id: G });
    if (!r.ok) return { ok: false, err: r.err };
    const cid = pick(r.data, 'goods_commit_id');
    return { ok: !!cid, commitId: cid, old: pick(r.data, 'old_goods_commit_id') };
  `);
}

/**
 * 提交草稿上架
 * 注意：commit/submit 的 body 必须同时带 goods_id 和 goods_commit_id，
 *      只传 commit 会被拒（3000000 参数不合法，缺少goodsId）
 */
function submitDraft(goods, commit) {
  return wrap(`
    const COMMIT = ${Number(commit)};
    let GOODS = Number(${Number(goods) || 0}) || 0;

    // 没给 goods_id 就自己查
    if (!GOODS) {
      const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: COMMIT });
      GOODS = d.ok ? (pick(d.data, 'goods_id') || 0) : 0;
    }
    if (!GOODS) {
      return { ok: false, error: '拿不到 goods_id，无法提交',
               detail: '提交上架必须同时带 goods_id 和 goods_commit_id' };
    }

    const sb = call('/glide/v2/mms/edit/commit/submit', {
      goods_id: GOODS,
      goods_commit_id: COMMIT
    });
    if (!sb.ok) {
      return { ok: false, error: '提交上架被平台拒绝', detail: sb.err,
               goods_id: GOODS, commit_id: COMMIT };
    }

    const rd = call('/vodka/v2/mms/query/display/mall/goodsListByGoodsId',
      { goods_id: GOODS, is_onsale: 1, page: 1, size: 10 });

    return {
      ok: true,
      goods_id: GOODS,
      commit_id: COMMIT,
      submit: sb.data,
      readback: rd.ok ? rd.data : rd.err
    };
  `);
}

/**
 * 回放 action/edit（body 由主进程从编辑页保存请求里抓到的原文，已改好价）
 * @param {string} bodyJson 完整请求体 JSON 字符串
 * @param {number} commit
 */
function applyEditBody(bodyJson, commit) {
  return wrap(`
    let BODY;
    try { BODY = JSON.parse(${JSON.stringify(bodyJson)}); }
    catch (e) { return { ok: false, error: '请求体解析失败: ' + e.message }; }

    const r = call('/glide/mms/goodsCommit/action/edit', BODY);
    const out = { save: { ok: r.ok, err: r.ok ? null : r.err } };

    const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: ${Number(commit)} });
    if (d.ok) {
      const g = d.data, sk = Array.isArray(g.sku) ? g.sku : [];
      out.after = {
        min_group_price: g.min_group_price,
        max_group_price: g.max_group_price,
        market_price: g.market_price,
        sku_count: sk.length,
        sku0: sk[0] ? { group: sk[0].multi_price, single: sk[0].price, qty: sk[0].quantity } : null,
        qty_sum: sk.reduce((a, s) => a + (Number(s.quantity) || 0), 0)
      };
    }
    out.ok = !!r.ok;
    return out;
  `);
}

/** 点「保存草稿」并返回点击是否成功（供主进程抓请求体用） */
function clickSaveDraft() {
  return `(() => {
    const want = '保存草稿';
    const els = [...document.querySelectorAll('button,a,span,div')]
      .filter((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim() === want);
    if (!els.length) return { clicked: false, count: 0 };
    els[0].click();
    return { clicked: true, count: els.length };
  })()`;
}

/**
 * 读当前编辑页 URL 里的 commit id
 * 保存草稿后 commit 会被替换，create_by_sn 对草稿又查不到（600009），
 * 最可靠的来源就是页面自己的 URL：.../goods_add/index?id=<commit>&goods_id=<goods>
 */
function readPageCommit() {
  return `(() => {
    const q = new URLSearchParams(location.search);
    return {
      ok: true,
      commitId: q.get('id') ? Number(q.get('id')) : null,
      goodsId: q.get('goods_id') ? Number(q.get('goods_id')) : null,
      href: location.href.slice(0, 160)
    };
  })()`;
}

/** 编辑页是否已就绪（「保存草稿」按钮出现） */
function hasSaveButton() {
  return `(() => {
    const b = [...document.querySelectorAll('button')]
      .find(e => (e.innerText || '').replace(/\\s+/g, ' ').trim() === '保存草稿');
    return !!b;
  })()`;
}

/** 用编辑页的「批量设置」把库存写进去（写的是 quantity_delta） */
function setBatchStock(qty) {
  return `(() => {
    const want = ${Number(qty) || 0};
    if (!want) return { ok: false, reason: 'qty=0' };
    const inp = [...document.querySelectorAll('input')]
      .find(e => (e.placeholder || '').trim() === '库存');
    if (!inp) return { ok: false, reason: 'no-input' };
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inp), 'value');
    d.set.call(inp, String(want));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')]
      .find(e => (e.innerText || '').replace(/\\s+/g, ' ').trim() === '批量设置');
    if (!btn) return { ok: false, reason: 'no-batch-button' };
    btn.click();
    return { ok: true, set: inp.value };
  })()`;
}

/** 读页面上的校验提示（提交失败时前端会给的红字） */
function readPageErrors() {
  return `(() => {
    const out = [];
    const nodes = document.querySelectorAll('[class*=error],[class*=Error],[class*=warn],[class*=Warn]');
    for (const n of nodes) {
      const t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
      if (t && t.length < 80 && !/暂无错误内容/.test(t)) out.push(t);
    }
    return [...new Set(out)].slice(0, 8);
  })()`;
}

/**
 * 采集：把某个在售商品读成完整数据包（不创建草稿、不改动任何东西）
 * 返回标题/价格/图/SKU/尺码标签/类目，供"采集箱"保存
 */
function collectGoods({ index = 0 } = {}) {
  return wrap(`
    const INDEX = ${Number(index) || 0};
    const ls = call('/vodka/v2/mms/query/display/mall/goodsList',
      { page: 1, size: Math.max(INDEX + 1, 20), is_onsale: 1,
        pre_sale_type: 4, shipment_time_type: 3, sold_out: 0 });
    if (!ls.ok) return { ok: false, error: '拉取商品失败', detail: ls.err };
    const arr = (ls.data && ls.data.goods_list) || [];
    const g = arr[INDEX];
    if (!g) return { ok: false, error: '没有第 ' + INDEX + ' 个商品' };

    const cbs = call('/glide/v2/mms/edit/commit/create_by_sn', { goods_id: g.id });
    const commit = cbs.ok ? pick(cbs.data, 'goods_commit_id') : undefined;
    if (!commit) return { ok: false, error: '拿不到 commit', detail: cbs.err };

    const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: commit });
    if (!d.ok) return { ok: false, error: '读详情失败', detail: d.err };
    const gd = d.data;
    const sku = Array.isArray(gd.sku) ? gd.sku : [];

    const sizeSet = {};
    const sizes = [];
    for (const s of sku) {
      for (const sp of (Array.isArray(s.spec) ? s.spec : [])) {
        const pn = sp.parent_name || '';
        const sn = sp.spec_name || '';
        if (!sn) continue;
        if (!/尺码|码数|size|鞋码|码/i.test(pn)) continue;
        if (!sizeSet[sn]) { sizeSet[sn] = 1; sizes.push(String(sn)); }
      }
    }

    return {
      ok: true,
      pack: {
        sourceGoodsId: g.id,
        sourceCommitId: commit,
        title: gd.goods_name || g.goods_name,
        thumb: gd.thumb_url || g.thumb_url,
        gallery: (gd.galleries || []).map(x => x.url).filter(Boolean),
        price: gd.min_group_price,
        marketPrice: gd.market_price,
        catId: gd.cat_id,
        catNames: [gd.cat_name_1, gd.cat_name_2, gd.cat_name_3, gd.cat_name_4, gd.cat_name]
          .filter(Boolean),
        skus: sku.map(s => ({
          sku_id: s.sku_id,
          group: s.multi_price,
          single: s.price,
          spec: (s.spec || []).map(sp => ({
            parent_id: sp.parent_id, parent_name: sp.parent_name,
            spec_id: sp.spec_id, spec_name: sp.spec_name
          }))
        })),
        sizes,
        sizeSpecId: gd.size_spec_id,
        sizeParentSpecId: gd.size_parent_spec_id,
        costTemplateId: gd.cost_template_id,
        shipmentLimitSecond: gd.shipment_limit_second,
        twoPiecesDiscount: gd.two_pieces_discount,
      }
    };
  `);
}

/**
 * 把「规格与库存」区域滚动到视口内并等待其渲染完成。
 * 这个表单是懒渲染的：不滚到可视区，颜色输入框根本不存在。
 */
function scrollToSpec() {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const findTitle = () => {
      for (const el of document.querySelectorAll('div,span')) {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (t === '规格与库存' || t === '2规格与库存') return el;
      }
      return null;
    };
    let title = findTitle();
    if (!title) {
      // 兜底：按文本包含找
      for (const el of document.querySelectorAll('div')) {
        const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
        if (t.length < 40 && t.indexOf('规格与库存') >= 0) { title = el; break; }
      }
    }
    if (title) {
      title.scrollIntoView({ block: 'start' });
      await sleep(1200);
      window.scrollBy(0, 120);
      await sleep(800);
    }
    // 等颜色输入框出现
    for (let i = 0; i < 40; i++) {
      const ins = [...document.querySelectorAll('[class*="new-spec-single-color"] input')]
        .filter(x => (x.placeholder || '').indexOf('备注') < 0);
      if (ins.length) return { ok: true, colors: ins.length, scrolled: !!title };
      await sleep(400);
    }
    return { ok: false, colors: 0, scrolled: !!title };
  })()`;
}

/**
 * 读当前编辑页的规格状态（颜色 / 尺码 / SKU 行数）
 * 用于 DOM 改规格前后做对照。
 */
function readSpecState() {
  return `(() => {
    const colorInputs = [...document.querySelectorAll('[class*="new-spec-single-color"] input')]
      .filter(i => (i.placeholder || '').indexOf('备注') < 0);
    const colors = colorInputs.map(i => i.value.trim()).filter(Boolean);

    const sizeLabels = [...document.querySelectorAll('[class*="CBX_outerWrapper"]')]
      .map(l => (l.innerText || '').replace(/\\s+/g, ' ').trim())
      .filter(t => t && t !== '全选以下规格值' && t.length < 20);

    let skuRows = 0;
    for (const tr of document.querySelectorAll('tr')) {
      if (tr.querySelectorAll('input').length >= 3) skuRows++;
    }
    return { ok: true, colors, sizeOptions: sizeLabels.slice(0, 80), skuRows };
  })()`;
}

/**
 * 设置颜色规格（DOM 操作，让页面自己生成合法 spec_id）
 * colors: ["黑色","骨白色",...]
 *
 * 核心：必须用原生 value setter + input/change 事件，React 才认。
 * 填满最后一个空框时页面会自动追加新行，所以先「长到目标数量」再统一写值。
 */
function setColors(colors) {
  const want = Array.isArray(colors) ? colors.map((x) => String(x).trim()).filter(Boolean) : [];
  return `(async () => {
    const WANT = ${JSON.stringify(want)};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const getIns = () => [...document.querySelectorAll('[class*="new-spec-single-color"] input')]
      .filter(i => (i.placeholder || '').indexOf('备注') < 0);
    const setVal = (inp, v) => {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(inp, v);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
    };

    if (!WANT.length) return { ok: false, error: '没有目标颜色' };

    // ① 先删多余行（从尾部删）
    let guard = 0;
    while (guard++ < 40) {
      const rows = [...document.querySelectorAll('[class*="new-spec-single-color"]')].filter(r => {
        const inp = [...r.querySelectorAll('input')].find(i => (i.placeholder || '').indexOf('备注') < 0);
        return inp && inp.value.trim();
      });
      if (rows.length <= WANT.length) break;
      const last = rows[rows.length - 1];
      const del = [...last.querySelectorAll('a')].find(e => (e.innerText || '').trim() === '删除');
      if (!del) break;
      del.click();
      await sleep(420);
    }

    // ② 长到目标数量：反复填第一个空框
    guard = 0;
    while (guard++ < 60) {
      const ins = getIns();
      if (ins.length >= WANT.length && ins.slice(0, WANT.length).every(i => i.value.trim())) break;
      const empty = ins.find(i => !i.value.trim());
      if (!empty) break;
      // 这个空框最终要填什么？按它前面已有值的数量决定
      const idx = ins.indexOf(empty);
      const v = WANT[Math.min(idx, WANT.length - 1)];
      setVal(empty, v);
      await sleep(480);
    }

    // ③ 统一校准每个位置的值
    for (let round = 0; round < 3; round++) {
      const ins = getIns();
      let changed = 0;
      for (let i = 0; i < WANT.length && i < ins.length; i++) {
        if (ins[i].value.trim() !== WANT[i]) {
          setVal(ins[i], WANT[i]);
          changed++;
          await sleep(220);
        }
      }
      if (!changed) break;
    }

    // ④ 删掉数量之外还留着的行
    guard = 0;
    while (guard++ < 20) {
      const rows = [...document.querySelectorAll('[class*="new-spec-single-color"]')].filter(r => {
        const inp = [...r.querySelectorAll('input')].find(i => (i.placeholder || '').indexOf('备注') < 0);
        return inp && inp.value.trim();
      });
      if (rows.length <= WANT.length) break;
      const last = rows[rows.length - 1];
      const del = [...last.querySelectorAll('a')].find(e => (e.innerText || '').trim() === '删除');
      if (!del) break;
      del.click();
      await sleep(380);
    }

    const final = getIns().map(i => i.value.trim()).filter(Boolean);
    return { ok: final.length >= WANT.length, want: WANT, got: final };
  })()`;
}

/**
 * 勾选尺码（按页面上标准码表的复选框文本匹配源尺码标签）
 *
 * 关键：不靠「猜 checkbox 有没有选中」（类名带版本号、不可靠）。
 * 改为从 SKU 表格反推当前生效的尺码集合，再用差集决定点哪些标签。
 * 表格是唯一可信事实来源 —— 它列出来的就是真正生效的组合。
 */
function setSizes(sizes) {
  const want = Array.isArray(sizes) ? sizes.map((x) => String(x).trim()).filter(Boolean) : [];
  return `(async () => {
    const WANT = ${JSON.stringify(want)};
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const norm = (x) => String(x || '')
      .replace(/[（(].*?[）)]/g, '')
      .replace(/[\\u4e00-\\u9fa5]/g, '')
      .replace(/\\s+/g, '')
      .toUpperCase();
    const wantSet = new Set(WANT.map(norm).filter(Boolean));

    const getLabels = () => [...document.querySelectorAll('[class*="CBX_outerWrapper"]')]
      .filter(l => {
        const t = (l.innerText || '').replace(/\\s+/g, ' ').trim();
        return t && t !== '全选以下规格值' && t.length < 20;
      });

    // 从 SKU 表格读出「当前生效的尺码」
    const readActive = () => {
      const labels = getLabels();
      const active = new Set();
      const rows = [...document.querySelectorAll('tr')]
        .filter(tr => tr.querySelectorAll('input').length >= 3);
      for (const tr of rows) {
        const txt = (tr.innerText || '').replace(/\\s+/g, ' ');
        for (const lb of labels) {
          const t = (lb.innerText || '').replace(/\\s+/g, ' ').trim();
          if (t && txt.indexOf(t) >= 0) active.add(norm(t));
        }
      }
      return active;
    };

    let cur = readActive();
    if (!cur.size && !wantSet.size) return { ok: true, turnedOn: 0, turnedOff: 0, note: '空集' };

    const toOff = [...cur].filter(n => !wantSet.has(n));
    const toOn = [...wantSet].filter(n => !cur.has(n));

    let on = 0, off = 0;
    const labels = getLabels();
    const byNorm = new Map();
    for (const lb of labels) {
      const t = (lb.innerText || '').replace(/\\s+/g, ' ').trim();
      const n = norm(t);
      if (n && !byNorm.has(n)) byNorm.set(n, lb);
    }

    for (const n of toOff) {
      const lb = byNorm.get(n);
      if (lb) { lb.click(); off++; await sleep(160); }
    }
    for (const n of toOn) {
      const lb = byNorm.get(n);
      if (lb) { lb.click(); on++; await sleep(160); }
    }

    await sleep(800);
    const after = readActive();
    const missing = [...wantSet].filter(n => !after.has(n));
    return { ok: missing.length === 0, turnedOn: on, turnedOff: off,
             want: WANT, before: [...cur], after: [...after], missing };
  })()`;
}

module.exports = { ping, listGoods, copyGoods, draftDetail, submitDraft,
                   applyEditBody, clickSaveDraft, resolveCommit, readPageCommit,
                   hasSaveButton, setBatchStock, readPageErrors, collectGoods,
                   readSpecState, setColors, setSizes, scrollToSpec };
