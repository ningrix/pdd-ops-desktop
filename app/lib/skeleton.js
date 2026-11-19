'use strict';
/**
 * 骨架使用记录 + 骨架预分配。
 *
 * 背景：跨店上架需要在目标店里「克隆一条自己的商品当骨架」，但平台对同一商品
 * 的连续新建有频控 —— 报 `600102 该商品已被新建过,请勿连续新建`。
 *
 * 未确认：平台没有公开这个频控的实际窗口期和次数上限。所以这里不猜一个"冷却时间"，
 *         只做两件事：① 按「最久未用优先」轮换，别把同一个骨架连着打死；
 *                   ② 全失败时把每个骨架的最近使用时间报出来，让用户自己决定等多久。
 *
 * 为什么要在采集时就分配骨架（本模块新增的部分）：
 *   上架时才找骨架有两个问题 ——
 *     ① 采集时不知道这个商品能不能上架，批量跑到第 N 个才炸，前面白做；
 *     ② 每次上架都要现拉 listGoods（几秒到几十秒），而且拉到的清单没缓存。
 *   所以采集完就按目标店铺算好「用哪个骨架、备选是谁、是不是在冷却期」，
 *   上架时直接用。失败从「上架时」提前到「采集时」。
 *
 * 落盘：
 *   app/userdata/skeleton-used.json     { [goodsId]: 最后使用时间戳ms }
 *   app/userdata/skeleton-cache.json    { [mallId]: { at, items[] } }
 */
const fs = require('fs');
const path = require('path');

let FILE = null;        // skeleton-used.json
let CACHE_FILE = null;  // skeleton-cache.json

/** 保守冷却时间。未确认：平台未公开，实测 1 分钟内必拒，15 分钟是经验值 */
const COOLDOWN_MIN = 15;
/** 商品清单缓存有效期。过期才重新拉 listGoods */
const CACHE_TTL_MS = 10 * 60 * 1000;

function init(userDataDir) {
  FILE = path.join(userDataDir, 'skeleton-used.json');
  CACHE_FILE = path.join(userDataDir, 'skeleton-cache.json');
}

// ---------------------------------------------------------------- 基础读写
function readJson(f) {
  try {
    if (!f || !fs.existsSync(f)) return {};
    const o = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (o && typeof o === 'object') ? o : {};
  } catch (_) {
    return {};
  }
}

function writeJson(f, o) {
  try {
    if (!f) return false;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

const load = () => readJson(FILE);
const save = (o) => writeJson(FILE, o);
const loadCache = () => readJson(CACHE_FILE);
const saveCache = (o) => writeJson(CACHE_FILE, o);

// ---------------------------------------------------------------- 使用记录
/** 记一次使用 */
function markUsed(goodsId) {
  if (!goodsId) return;
  const o = load();
  o[String(goodsId)] = Date.now();
  save(o);
}

/** 上次使用时间（ms），从没用过返回 null */
function lastUsed(goodsId) {
  const o = load();
  const v = o[String(goodsId)];
  return (typeof v === 'number' && v > 0) ? v : null;
}

function minutesAgo(ts) {
  if (!ts) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
}

// ---------------------------------------------------------------- 商品清单缓存
/**
 * 缓存某个店铺的在售商品清单（用于算骨架候选）。
 * @param {string} mallId
 * @param {Array} items listGoods 返回的 items
 */
function cacheMallGoods(mallId, items) {
  if (!mallId || !Array.isArray(items)) return false;
  const o = loadCache();
  o[String(mallId)] = {
    at: Date.now(),
    items: items.map((x) => ({
      goods_id: x.goods_id,
      cat_id: x.cat_id,
      title: x.title,
      colorCount: x.colorCount || 0,
    })),
  };
  return saveCache(o);
}

/**
 * 取缓存的店铺商品清单。
 * @returns {{items:Array, at:number, ageMin:number}|null}
 */
function getCachedMallGoods(mallId, maxAgeMs) {
  const ttl = maxAgeMs || CACHE_TTL_MS;
  const o = loadCache();
  const c = o[String(mallId)];
  if (!c || !Array.isArray(c.items)) return null;
  const age = Date.now() - (c.at || 0);
  if (age > ttl) return null;
  return { items: c.items, at: c.at, ageMin: Math.round(age / 60000) };
}

/** 清掉某个店铺的缓存（换店铺/商品变动时用） */
function invalidateMall(mallId) {
  const o = loadCache();
  if (o[String(mallId)]) { delete o[String(mallId)]; saveCache(o); }
}

// ---------------------------------------------------------------- 排序
/**
 * 把候选骨架按「最久未用优先」排序。
 * @param {Array} items listGoods 的 items
 * @param {number} srcCatId 源商品类目
 */
function rank(items, srcCatId) {
  const list = Array.isArray(items) ? items.slice() : [];
  const used = load();

  const withMeta = list.map((x) => {
    const ts = (typeof used[String(x.goods_id)] === 'number') ? used[String(x.goods_id)] : null;
    return Object.assign({}, x, { lastUsedAt: ts, lastUsedMin: minutesAgo(ts) });
  });

  const byLru = (a, b) => {
    const av = a.lastUsedAt === null ? -1 : a.lastUsedAt;   // 没用过的最优先
    const bv = b.lastUsedAt === null ? -1 : b.lastUsedAt;
    return av - bv;
  };

  const sameCat = withMeta.filter((x) => Number(x.cat_id) === Number(srcCatId)).sort(byLru);
  const otherCat = withMeta.filter((x) => Number(x.cat_id) !== Number(srcCatId)).sort(byLru);

  return {
    sameCat,
    otherCat,
    stats: {
      total: withMeta.length,
      sameCatCount: sameCat.length,
      neverUsed: sameCat.filter((x) => x.lastUsedAt === null).length,
    },
  };
}

// ---------------------------------------------------------------- 预分配
/**
 * 给「源商品类目 → 目标店铺」算出一份骨架分配。
 *
 * 只返回纯数据，不碰网络；调用方负责先 cacheMallGoods()。
 *
 * @param {string} mallId 目标店铺
 * @param {number} catId  源商品类目
 * @param {{colorCount?:number}} opts 源商品有几套颜色（决定要不要优选有颜色的骨架）
 * @returns {object} plan
 */
function plan(mallId, catId, opts) {
  const o = opts || {};
  const srcCat = Number(catId) || null;
  const base = {
    mallId: String(mallId || ''),
    catId: srcCat,
    ready: false,
    count: 0,
    candidates: [],
    best: null,
    allCooling: false,
    cachedAt: null,
    advice: '',
  };

  const cache = getCachedMallGoods(mallId);
  if (!cache) {
    base.advice = '还没有这个店铺的商品清单缓存，上架时会现场拉取';
    return base;
  }
  base.cachedAt = cache.at;

  if (!srcCat) {
    base.advice = '源商品没有类目信息，无法预分配骨架';
    return base;
  }

  const ranked = rank(cache.items, srcCat);
  let cands = ranked.sameCat;

  if (!cands.length) {
    base.advice = '目标店还没有这个品类的商品，无法当骨架。需要先在该店手动上一个同品类商品';
    return base;
  }

  // 源有颜色时，优先挑自己就有颜色规格的骨架（骨架没颜色框 → 颜色设不进去）
  const srcColors = Number(o.colorCount) || 0;
  if (srcColors > 0) {
    const withColor = cands.filter((x) => Number(x.colorCount) > 0);
    if (withColor.length) cands = withColor.concat(cands.filter((x) => !(Number(x.colorCount) > 0)));
  }

  const list = cands.map((x) => {
    const cooling = x.lastUsedMin !== null && x.lastUsedMin < COOLDOWN_MIN;
    return {
      goods_id: x.goods_id,
      title: String(x.title || '').slice(0, 30),
      colorCount: Number(x.colorCount) || 0,
      lastUsedMin: x.lastUsedMin,
      cooling,                                   // true = 大概率还会被 600102 拒
      ready: !cooling,
    };
  });

  base.candidates = list;
  base.count = list.length;
  base.allCooling = list.every((x) => x.cooling);

  const usable = list.filter((x) => x.ready);
  if (usable.length) {
    base.ready = true;
    base.best = usable[0].goods_id;
    base.advice = '可上架：' + usable.length + ' 个骨架可用' +
      (srcColors > 0 ? '（源有 ' + srcColors + ' 套颜色，优先选有颜色规格的骨架）' : '');
  } else {
    base.advice = '同品类骨架 ' + list.length + ' 个全部在冷却期内（' + COOLDOWN_MIN +
      ' 分钟内用过）。平台未公开频控窗口，建议等一会儿，或给目标店补一个同品类商品';
  }
  return base;
}

/**
 * 生成「骨架都失败」时的诊断文案。
 * @param {Array} tried 试过的候选（含 lastUsedMin）
 */
function diagnosis(tried, srcCatId) {
  const n = tried.length;
  if (!n) {
    return '目标店铺里没有和源商品同品类（cat ' + srcCatId + '）的在售商品，无法当骨架。' +
           '请先在目标店上架至少一个该品类的商品，再重试跨店上架。';
  }
  const lines = tried.map((x) => {
    const t = x.lastUsedMin === null ? '从未用过' : (x.lastUsedMin + ' 分钟前用过');
    return String(x.title || '').slice(0, 16) + '（' + x.goods_id + '，' + t + '）';
  });
  const fresh = tried.filter((x) => x.lastUsedMin === null || x.lastUsedMin >= COOLDOWN_MIN).length;
  return '同品类（cat ' + srcCatId + '）骨架只有 ' + n + ' 个，全部被平台频控拒绝（600102）。\n' +
         '各骨架最近使用：\n  ' + lines.join('\n  ') + '\n' +
         (fresh ? ('其中 ' + fresh + ' 个超过 ' + COOLDOWN_MIN + ' 分钟未用，可稍后直接重试。')
                : '全部在 ' + COOLDOWN_MIN + ' 分钟内用过。平台未公开该频控窗口，建议等 15~30 分钟，' +
                  '或给目标店补充一个同品类商品（候选越多越不容易卡住）。');
}

module.exports = {
  init, markUsed, lastUsed, rank, diagnosis, minutesAgo,
  cacheMallGoods, getCachedMallGoods, invalidateMall, plan,
  COOLDOWN_MIN, CACHE_TTL_MS,
};
