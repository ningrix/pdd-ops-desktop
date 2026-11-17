'use strict';
/**
 * 商品检测 —— 规则层（纯 Node，零依赖，不读图）
 *
 * 设计原则（来自 AGENTS.md）：
 *  - §1.3.2 查不到就说「未确认」，不许给近似答案事后纠正
 *    → 凡是依赖平台规则但我们没拿到官方原文的，标 level:'info' + unconfirmed:true
 *  - §1.3.5 金额一律用「分」为单位的整数
 *
 * 分三级：
 *  error  确定会被平台拒 / 一定有问题，必须改
 *  warn   很可能会影响流量或审核，建议改
 *  info   提示性信息，可能是数据缺失或个人选择（不一定是错）
 */

/**
 * 拼多多标题上限。依据：官方发品接口 goods_name 校验 + 商家后台输入框限制。
 * 实测：后台标题输入框 maxlength=60。
 */
const TITLE_MAX = 60;

/** 主图数量：平台最低 1 张；行业建议 5 张以上（建议值，非平台硬规则） */
const GALLERY_MIN_HARD = 1;
const GALLERY_GOOD = 5;

/** 主图建议尺寸下限。依据：官方 goods.add 注释「尺寸长宽比 1:1 且不低于 480px」 */
const IMG_MIN_SIDE = 480;
const IMG_MAX_BYTES = 1024 * 1024;

/**
 * 标题堆砌检测用词表。
 * 未确认：平台没有公开完整违禁词/堆砌判定词表，这里只是「营销套话重复」的常见模式，
 * 命中了不代表违规，只提示「考虑精简」。
 */
const FILLER_WORDS = [
  '爆款', '新款', '正品', '包邮', '特价', '清仓', '热卖',
  '同款', '网红', 'ins', '抖音', '小红书', '明星',
];

function fen(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function yuan(f) {
  return f == null ? '-' : (f / 100).toFixed(2);
}

/**
 * 检测一个采集箱条目。
 * @param {object} item  PoolItem
 * @param {object} [opts] { imageReport } 传入图像层结果可合并评分
 * @returns {{score:number, level:string, issues:Array, summary:object}}
 */
function inspectItem(item, opts) {
  const o = opts || {};
  const issues = [];
  const push = (code, level, msg, fix, extra) =>
    issues.push(Object.assign({ code, level, msg, fix: fix || null }, extra || {}));

  if (!item || typeof item !== 'object') {
    return { score: 0, level: 'error', issues: [{ code: 'BAD_ITEM', level: 'error', msg: '条目为空' }] };
  }

  const title = String(item.title || '');
  const skus = Array.isArray(item.skus) ? item.skus : [];
  const gallery = Array.isArray(item.gallery) ? item.gallery.filter(Boolean) : [];
  const sizes = Array.isArray(item.sizes) ? item.sizes : [];
  const marketPrice = fen(item.marketPrice);

  // ---------------- 标题 ----------------
  if (!title.trim()) {
    push('TITLE_EMPTY', 'error', '标题为空', '填一个含类目词的标题');
  } else {
    if (title.length > TITLE_MAX) {
      push('TITLE_TOO_LONG', 'error',
        `标题 ${title.length} 字，超过上限 ${TITLE_MAX} 字（多 ${title.length - TITLE_MAX} 字）`,
        `删掉 ${title.length - TITLE_MAX} 个字，优先删重复的卖点词`,
        { got: title.length, limit: TITLE_MAX });
    }
    // 营销套话堆砌
    const hits = FILLER_WORDS.filter((w) => title.toLowerCase().includes(w));
    if (hits.length >= 3) {
      push('TITLE_FILLER', 'warn',
        `标题含 ${hits.length} 个营销套话（${hits.join('、')}），会挤占关键词位`,
        '保留 1 个最相关的，其余换成属性词/场景词',
        { words: hits });
    }
    // 完全重复的短语（如「羽绒服羽绒服」）
    const dup = [];
    for (let len = 4; len <= 8; len++) {
      for (let i = 0; i + len * 2 <= title.length; i++) {
        const seg = title.slice(i, i + len);
        if (title.slice(i + len, i + len * 2) === seg) dup.push(seg);
      }
    }
    if (dup.length) {
      push('TITLE_DUP', 'warn',
        `标题有连续重复片段：${[...new Set(dup)].slice(0, 3).join('、')}`,
        '删掉重复的那一半，腾出字数给关键词');
    }
  }

  // ---------------- SKU ----------------
  if (!skus.length) {
    push('SKU_EMPTY', 'error', '没有任何 SKU', '补规格和 SKU 后再上架');
  } else {
    let badPrice = 0;
    let badSpec = 0;
    let maxSingle = 0;
    let minGroup = Infinity;

    for (const s of skus) {
      const g = fen(s.group);
      const p = fen(s.single);
      if (g == null || p == null) { badPrice++; continue; }
      if (p < maxSingle || maxSingle === 0) maxSingle = Math.max(maxSingle, p);
      if (g < minGroup) minGroup = g;
      // 单买价必须高于拼单价（拼单价是团购优惠价）
      if (p <= g) badPrice++;
      if (!Array.isArray(s.spec) || !s.spec.length) badSpec++;
    }

    if (badPrice) {
      push('SKU_PRICE_BAD', 'error',
        `${badPrice} 个 SKU 价格异常（单买价 ≤ 拼单价，或价格缺失）`,
        '单买价必须高于拼单价');
    }
    if (badSpec) {
      push('SKU_SPEC_EMPTY', 'error',
        `${badSpec} 个 SKU 没有规格值`,
        '每个 SKU 必须有颜色/尺码等规格');
    }

    // 参考价必须【严格大于】所有 SKU 的最大单买价
    // 依据：实测错误码 1000161「规格单买价格必须小于参考价格」，相等也会被拒
    if (marketPrice != null && maxSingle > 0) {
      if (marketPrice <= maxSingle) {
        push('MARKET_PRICE_LOW', 'error',
          `参考价 ${yuan(marketPrice)} 必须严格大于最高单买价 ${yuan(maxSingle)}（现在${marketPrice === maxSingle ? '相等' : '更低'}，平台会报 1000161）`,
          `把参考价提到 ${yuan(maxSingle + 100)} 以上`,
          { marketPrice, maxSingle });
      } else if (marketPrice - maxSingle < 100) {
        push('MARKET_PRICE_TIGHT', 'warn',
          `参考价只比最高单买价高 ${yuan(marketPrice - maxSingle)} 元，改价时容易越界`,
          '留 5~10 元以上余量');
      }
    }

    // 拼单价与采集时的最低价不一致（可能是采集后源商品改价了）
    const itemPrice = fen(item.price);
    if (itemPrice != null && minGroup !== Infinity && Math.abs(minGroup - itemPrice) > 1) {
      push('PRICE_MISMATCH', 'info',
        `条目最低拼单价 ${yuan(itemPrice)}，但 SKU 里最低是 ${yuan(minGroup)}，数据可能不一致`,
        '重新采集一次以同步价格');
    }
  }

  // ---------------- 主图 ----------------
  if (gallery.length < GALLERY_MIN_HARD) {
    push('GALLERY_EMPTY', 'error', '没有主图', '至少上传 1 张主图');
  } else if (gallery.length < GALLERY_GOOD) {
    push('GALLERY_FEW', 'warn',
      `只有 ${gallery.length} 张主图（建议 ${GALLERY_GOOD} 张以上）`,
      '主图多能多占曝光位，建议补齐到 5 张以上');
  }

  const dupUrls = gallery.filter((u, i) => gallery.indexOf(u) !== i);
  if (dupUrls.length) {
    push('GALLERY_DUP', 'warn',
      `主图有 ${dupUrls.length} 张重复，浪费图位`,
      '删掉重复的，换成不同角度或卖点图');
  }

  // 图片规格（若图像层报告已合并，这里跳过）
  if (o.imageReport && Array.isArray(o.imageReport.images)) {
    const small = o.imageReport.images.filter((x) => x.w && x.h && Math.min(x.w, x.h) < IMG_MIN_SIDE);
    if (small.length) {
      push('IMG_TOO_SMALL', 'warn',
        `${small.length} 张主图短边不足 ${IMG_MIN_SIDE}px`,
        '用超分放大，或换更大尺寸的源图',
        { count: small.length });
    }
    const heavy = o.imageReport.images.filter((x) => x.bytes && x.bytes > IMG_MAX_BYTES);
    if (heavy.length) {
      push('IMG_TOO_HEAVY', 'warn',
        `${heavy.length} 张主图超过 1MB`,
        '压缩到 1MB 以内，平台对单图有体积限制');
    }
    const lowWhite = o.imageReport.images.filter(
      (x) => typeof x.whiteRatio === 'number' && x.whiteRatio < 0.55);
    if (lowWhite.length) {
      push('IMG_NOT_WHITE', 'info',
        `${lowWhite.length} 张主图背景不是纯白（白底占比偏低）`,
        '非白底不一定违规，但白底主图在拼多多通常是更稳妥的选择',
        { count: lowWhite.length });
    }
  }

  // ---------------- 尺码 ----------------
  const sizeSpecId = item.sizeSpecId;
  const hasSizeChart = !(sizeSpecId === null || sizeSpecId === undefined || Number(sizeSpecId) === 0);
  if (!sizes.length) {
    push('SIZES_EMPTY', 'warn',
      '没有读到尺码标签',
      '服装/鞋类通常需要尺码；如果这个商品确实无尺码（如配件），可忽略');
  }
  if (!hasSizeChart) {
    // 未确认：哪些类目强制要求尺码表，我们没有官方清单。
    // 实测过：运动羽绒服 cat 12508 会因尺码表报 10000014，但那是"有码值却无尺码表"的情况。
    push('SIZE_CHART_NONE', 'info',
      '该商品没有尺码表',
      '不是所有类目都要求尺码表。若上架报 10000014 再补，不要提前加',
      { unconfirmed: true });
  }

  // ---------------- 类目 ----------------
  const catNames = Array.isArray(item.catNames) ? item.catNames.filter(Boolean) : [];
  if (!item.catId) {
    push('CAT_MISSING', 'error', '没有类目 id', '重新采集');
  } else if (!catNames.length) {
    push('CAT_NAMES_EMPTY', 'info',
      `采集到了类目 id（${item.catId}）但没拿到类目名`,
      '不影响上架，但影响尺码模板匹配的准确度。可重新采集一次试试',
      { catId: item.catId, unconfirmed: true });
  }

  // ---------------- 其他 ----------------
  const tpd = Number(item.twoPiecesDiscount);
  if (!Number.isFinite(tpd) || tpd === 0) {
    push('NO_TWO_PIECES', 'info',
      '没有满2件折扣',
      '实测部分类目（如运动羽绒服）发布时强制要求，报 17000001 就是它；未报错则不必加',
      { unconfirmed: true });
  }

  // ---------------- 打分 ----------------
  const weight = { error: 22, warn: 8, info: 0 };
  let score = 100;
  for (const it of issues) score -= weight[it.level] || 0;
  score = Math.max(0, Math.min(100, score));

  const errCount = issues.filter((x) => x.level === 'error').length;
  const warnCount = issues.filter((x) => x.level === 'warn').length;
  const level = errCount ? 'error' : (warnCount ? 'warn' : 'ok');

  return {
    score,
    level,
    issues,
    summary: {
      error: errCount,
      warn: warnCount,
      info: issues.filter((x) => x.level === 'info').length,
      skuCount: skus.length,
      galleryCount: gallery.length,
      titleLen: title.length,
      hasSizeChart,
      catId: item.catId || null,
    },
  };
}

/** 批量检测 */
function inspectMany(items, opts) {
  const list = (Array.isArray(items) ? items : []).map((it) => {
    const r = inspectItem(it, opts);
    return Object.assign({ id: it.id, title: it.title }, r);
  });
  list.sort((a, b) => a.score - b.score);
  return {
    count: list.length,
    bad: list.filter((x) => x.level === 'error').length,
    warn: list.filter((x) => x.level === 'warn').length,
    ok: list.filter((x) => x.level === 'ok').length,
    items: list,
  };
}

module.exports = { inspectItem, inspectMany, TITLE_MAX, IMG_MIN_SIDE, IMG_MAX_BYTES };
