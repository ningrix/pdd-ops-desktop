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

function load() {
  try {
    if (!FILE || !fs.existsSync(FILE)) return [];
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
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
    price: it.price,
    images: (it.gallery || []).length,
    skus: (it.skus || []).length,
    sizes: it.sizes || [],
    catNames: it.catNames || [],
    thumb: it.thumb,
    createdAt: it.createdAt,
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

module.exports = { init, list, add, get, remove };
