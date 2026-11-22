'use strict';
/**
 * 尺码模板域：列出模板、按类目/尺码标签匹配模板。
 *
 * 注意 SIZE_TPL_FILE 由 ctx 注入，不在本文件里用 __dirname 拼——
 * 搬到 app/ipc/ 后 __dirname 会变成 app/ipc，路径就错了。
 *
 * 匹配优先级：先按商品真实尺码标签覆盖度，再按类目关键词兜底。
 * 返回里的 bySizes 标明命中方式，界面据此显示。
 */
module.exports = function registerSize(ctx) {
  const {
    ipcMain, fs, path, SIZE_TPL_FILE, trace,
  } = ctx;

// ---------------------------------------------------------------- 尺码表模板
// SIZE_TPL_FILE 由 ctx 注入（见文件头注释）

function loadSizeTemplates() {
  try {
    return JSON.parse(fs.readFileSync(SIZE_TPL_FILE, 'utf8')).templates || [];
  } catch (e) {
    trace('loadSizeTemplates fail: ' + e.message);
    return [];
  }
}

ipcMain.handle('size:list', () => {
  return loadSizeTemplates().map((t) => ({
    id: t.id, name: t.name, unit: t.unit,
    rowCount: t.rows.length,
    sizes: t.rows.map((r) => r[0]),
    columns: t.columns,
  }));
});

/** 按类目名 + 商品实际尺码标签匹配模板
 *  规则：
 *   ① 品牌/款式模板优先（Lululemon、凯乐石这类）
 *   ② 性别过滤（类目名含「女」只允许 women_*，含「男」只允许 men_*）
 *   ③ 尺码标签优先于类目关键词：模板的 sizes 与商品实际尺码重合度越高越优先
 *      （因为同一类目里，有的商品是 XS/S/M，有的是 2/4/6，有的是 39/40）
 */
ipcMain.handle('size:match', (_e, payload) => {
  let catNames = [];
  let sizes = [];
  if (Array.isArray(payload)) {
    catNames = payload;
  } else if (payload && typeof payload === 'object') {
    catNames = Array.isArray(payload.catNames) ? payload.catNames : [];
    sizes = Array.isArray(payload.sizes) ? payload.sizes.map(String) : [];
  }

  const hay = catNames.filter(Boolean).join(' / ').toLowerCase();
  const gender = hay.indexOf('女') >= 0 ? 'women'
               : (hay.indexOf('男') >= 0 ? 'men' : null);

  const all = loadSizeTemplates();
  // 尺码标签归一化：真实商品的标签五花八门
  //   "S（80-100斤）" → "S"
  //   "2XL(160-180斤)" → "XXL"
  //   "165/90A" → "165/90A"
  const ALIAS = {
    '2XL': 'XXL', '3XL': 'XXXL', '4XL': 'XXXXL', '5XL': 'XXXXXL',
    'XXL': 'XXL', 'XXXL': 'XXXL',
    '均码': 'FREE', 'FREE': 'FREE', 'ONESIZE': 'FREE',
  };
  const norm = (x) => {
    let s = String(x || '').trim();
    // 去掉括号/中文注释
    s = s.replace(/[（(].*?[）)]/g, '');
    s = s.replace(/[\u4e00-\u9fa5].*$/, '');
    s = s.replace(/\s+/g, '').toUpperCase();
    if (!s) return '';
    return ALIAS[s] || s;
  };
  const prodSet = new Set(sizes.map(norm).filter(Boolean));

  const overlap = (t) => {
    if (!prodSet.size) return { hit: 0, ratio: 0 };
    let hit = 0;
    for (const r of t.rows) if (prodSet.has(norm(r[0]))) hit++;
    return { hit, ratio: hit / t.rows.length };
  };

  const build = (t, matchedBy, extra) => Object.assign({
    id: t.id, name: t.name, unit: t.unit,
    matchedBy,
    rowCount: t.rows.length,
    sizes: t.rows.map((r) => r[0]),
    columns: t.columns,
    rows: t.rows,
  }, extra || {});

  // ① 尺码标签优先：重合度 >= 0.5 直接命中，取重合度最高的
  //    ⚠️ 必须先按性别过滤，否则女装的 S/M/L 会撞到男装模板
  const genderOk = (t) => {
    if (!gender) return true;
    if (!/^(men|women)_/.test(t.id)) return true;      // 品牌/款式模板不限性别
    const tg = t.id.indexOf('women_') === 0 ? 'women' : 'men';
    return tg === gender;
  };

  if (prodSet.size) {
    let best = null;
    for (const t of all) {
      if (!genderOk(t)) continue;
      const o = overlap(t);
      if (o.ratio >= 0.5 && (!best || o.ratio > best.ratio)) best = { t, o };
    }
    if (best) {
      return build(best.t, '尺码标签[' + sizes.slice(0, 6).join(',') + ']',
                   { bySizes: true, overlap: best.hit + '/' + best.t.rows.length });
    }
  }

  // ② 退回品牌/款式 → ③ 类目关键词
  const specific = all.filter((t) => !/^(men|women)_/.test(t.id));
  const generic = all.filter((t) => /^(men|women)_/.test(t.id));

  const hitKw = (t) => {
    for (const kw of (t.match || [])) {
      if (hay.indexOf(String(kw).toLowerCase()) >= 0) return kw;
    }
    return null;
  };

  for (const t of specific) {
    const kw = hitKw(t);
    if (kw) return build(t, '关键词「' + kw + '」', { bySizes: false });
  }
  for (const t of generic) {
    if (gender) {
      const tg = t.id.indexOf('women_') === 0 ? 'women' : 'men';
      if (tg !== gender) continue;
    }
    const kw = hitKw(t);
    if (kw) return build(t, '关键词「' + kw + '」', { bySizes: false });
  }
  return null;
});

  return {  };
};
