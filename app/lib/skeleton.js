'use strict';
/**
 * 骨架使用记录。
 *
 * 背景：跨店上架需要在目标店里「克隆一条自己的商品当骨架」，但平台对同一商品
 * 的连续新建有频控 —— 报 `600102 该商品已被新建过,请勿连续新建`。
 *
 * 未确认：平台没有公开这个频控的实际窗口期和次数上限。所以这里不猜一个"冷却时间"，
 *         只做两件事：① 按「最久未用优先」轮换，别把同一个骨架连着打死；
 *                   ② 全失败时把每个骨架的最近使用时间报出来，让用户自己决定等多久。
 *
 * 落盘 app/userdata/skeleton-used.json，格式 { [goodsId]: 最后使用时间戳ms }
 */
const fs = require('fs');
const path = require('path');

let FILE = null;

function init(userDataDir) {
  FILE = path.join(userDataDir, 'skeleton-used.json');
}

function load() {
  try {
    if (!FILE || !fs.existsSync(FILE)) return {};
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return (o && typeof o === 'object') ? o : {};
  } catch (_) {
    return {};
  }
}

function save(o) {
  try {
    if (!FILE) return false;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(o, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

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

/**
 * 把候选骨架按「最久未用优先」排序。
 * @param {Array} items listGoods 的 items
 * @param {number} srcCatId 源商品类目
 * @returns {{sameCat:Array, otherCat:Array, stats:object}}
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
  const fresh = tried.filter((x) => x.lastUsedMin === null || x.lastUsedMin >= 15).length;
  return '同品类（cat ' + srcCatId + '）骨架只有 ' + n + ' 个，全部被平台频控拒绝（600102）。\n' +
         '各骨架最近使用：\n  ' + lines.join('\n  ') + '\n' +
         (fresh ? ('其中 ' + fresh + ' 个超过 15 分钟未用，可稍后直接重试。')
                : '全部在 15 分钟内用过。平台未公开该频控窗口，建议等 15~30 分钟，' +
                  '或给目标店补充一个同品类商品（候选越多越不容易卡住）。');
}

module.exports = { init, markUsed, lastUsed, rank, diagnosis, minutesAgo };
