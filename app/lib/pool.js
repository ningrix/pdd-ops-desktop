'use strict';
/**
 * 采集箱：把商品从源店铺"读出来"存到本地，不绑定任何店铺，
 * 之后可以选择上架到哪个店铺。
 */
const fs = require('fs');
const path = require('path');

let FILE = null;

function init(userDataDir) {
  FILE = path.join(userDataDir, 'pool.json');
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch (_) {}
}

/**
 * 图集去重（保持顺序）。
 *
 * 为什么在读取侧也做：拼多多的图集接口本身会返回重复 URL
 * （实测一条 21 项的图集只有 11 个唯一 URL）。ops.collectGoods 已在采集时去重，
 * 但修复之前采集进池的旧条目仍带重复 —— 读取时再兜一层，避免：
 *   ① 加水印时重复处理同一张图（浪费一半时间）
 *   ② 上架后主图有重复图位
 */
function dedupGallery(g) {
  if (!Array.isArray(g)) return [];
  const seen = Object.create(null);
  const out = [];
  for (const u of g) {
    if (!u || seen[u]) continue;
    seen[u] = 1;
    out.push(u);
  }
  return out;
}

function normalize(it) {
  if (!it || typeof it !== 'object') return it;
  if (Array.isArray(it.gallery)) it.gallery = dedupGallery(it.gallery);
  return it;
}

function load() {
  try {
    if (!FILE || !fs.existsSync(FILE)) return [];
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(a) ? a.map(normalize) : [];
  } catch (_) {
    return [];
  }
}

function save(list) {
  try {
    if (!FILE) return false;
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

function list() {
  return load().map((it) => ({
    id: it.id,
    title: it.title,
    sourceMallName: it.sourceMallName,
    sourceGoodsId: it.sourceGoodsId,
    catId: it.catId || null,
    price: it.price,
    images: (it.gallery || []).length,
    skus: (it.skus || []).length,
    sizes: it.sizes || [],
    colors: it.colors || [],
    catNames: it.catNames || [],
    thumb: it.thumb,
    createdAt: it.createdAt,
    // 骨架预分配结果：界面靠这几个字段显示「能不能上架、用哪个骨架」
    skeletonPlans: it.skeletonPlans || null,
    skeletonReady: it.skeletonReady,
    skeletonReadyCount: it.skeletonReadyCount,
    skeletonAdvice: it.skeletonAdvice || null,
    skeletonPlannedAt: it.skeletonPlannedAt || null,
    skeletonCatFrom: it.skeletonCatFrom || null,
  }));
}

function add(item) {
  const all = load();
  const id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const rec = Object.assign({ id, createdAt: new Date().toISOString() }, item);
  // 同一源店铺 + 同一商品只保留一条
  const idx = all.findIndex((x) => x.sourceGoodsId === rec.sourceGoodsId
                                && x.sourceMallId === rec.sourceMallId);
  if (idx >= 0) {
    rec.id = all[idx].id;
    all[idx] = rec;
  } else {
    all.unshift(rec);
  }
  save(all);
  return rec.id;
}

function get(id) {
  return load().find((x) => x.id === id) || null;
}

function remove(id) {
  const all = load().filter((x) => x.id !== id);
  save(all);
  return true;
}

/**
 * 局部更新一条。
 * 用途：采集后回写骨架预分配结果（skeletonPlans / skeletonReady）。
 * 浅合并，不改动没传的字段。
 */
function update(id, patch) {
  if (!id || !patch || typeof patch !== 'object') return null;
  const all = load();
  const i = all.findIndex((x) => x.id === id);
  if (i < 0) return null;
  all[i] = Object.assign({}, all[i], patch);
  save(all);
  return all[i];
}

module.exports = { init, list, add, get, remove, update };
