'use strict';
/**
 * 从拼多多 App（MuMu 模拟器）采集商品数据
 *
 * 为什么需要它：消费者端网页的价格与规格是**服务端打码**的
 * （实测：桌面/iPhone/微信/安卓 UA + 设备模拟全部试过，minGroupPrice 恒为 0、
 *  skuProperty 恒为 []，oakData 里 0 处规格）。只有真 App 才给完整数据。
 *
 * 分工策略（两者互补）：
 *   App  → 价格、颜色、尺码（网页端拿不到）
 *   网页 → 标题、主图、详情图、商品属性（App 里难拿图片）
 *
 * 用法：
 *   node tools/pdd-app-collect.js <goods_id 或 商品链接>
 *   node tools/pdd-app-collect.js --json 1234567890
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'work');

function findAdb() {
  const f = path.join(WORK, 'mumu_adb.txt');
  if (fs.existsSync(f)) {
    const p = fs.readFileSync(f, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  }
  const alt = [
    'D:\\Program Files\\Netease\\MuMu\\nx_device\\15.0\\shell\\adb.exe',
    'D:\\Program Files\\Netease\\MuMu\\nx_main\\adb.exe',
  ];
  for (const a of alt) if (fs.existsSync(a)) return a;
  return 'adb';
}

function findDevice() {
  const f = path.join(WORK, 'mumu_device.txt');
  if (fs.existsSync(f)) {
    const d = fs.readFileSync(f, 'utf8').trim();
    if (d) return d;
  }
  return '127.0.0.1:16384';
}

const ADB = findAdb();
const DEV = findDevice();

function adb(args, opts) {
  const o = Object.assign({ encoding: 'utf8', timeout: 90000 }, opts || {});
  try { return execFileSync(ADB, ['-s', DEV].concat(args), o) || ''; }
  catch (e) { return '__ERR__' + String((e && (e.stderr || e.message)) || e).slice(0, 300); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 人类式点击：微滑代替 tap（有按下时长），坐标带抖动 */
async function humanTap(x, y) {
  const jx = x + Math.round((Math.random() - 0.5) * 10);
  const jy = y + Math.round((Math.random() - 0.5) * 10);
  const dur = 70 + Math.round(Math.random() * 80);
  adb(['shell', 'input', 'swipe', String(jx), String(jy),
       String(jx + 2), String(jy + 1), String(dur)]);
  await sleep(600 + Math.round(Math.random() * 1400));
}

function dumpUi() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/ui_collect.xml']);
  return String(adb(['shell', 'cat', '/sdcard/ui_collect.xml']));
}

/**
 * 解析 uiautomator XML，按文档顺序取出所有 text 节点。
 * 顺序很重要：「颜色」标签之后、到「尺码」标签之前的就是颜色值。
 */
function parseNodes(xml) {
  const out = [];
  const re = /<node\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    const t = /\btext="([^"]*)"/.exec(tag);
    const b = /\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(tag);
    const c = /\bclickable="(true|false)"/.exec(tag);
    if (!t) continue;
    const text = t[1].trim();
    if (!text) continue;
    out.push({
      text,
      x1: b ? +b[1] : 0, y1: b ? +b[2] : 0,
      x2: b ? +b[3] : 0, y2: b ? +b[4] : 0,
      clickable: c ? c[1] === 'true' : false,
    });
  }
  return out;
}

/** 明显不是商品标题的文本 */
const NOT_TITLE = [
  /服饰类商品|消费提醒|七天无理由|不支持七天|已洗涤|吊牌/,
  /^(已售|券后|补贴|官方|品牌|店铺|支持|预计|最快|收藏|客服|进店|我关注)/,
  /退货包运费|极速退款|保证金|假一赔十|顺丰包邮|48小时发货|未发货秒退/,
  /^(商品详情|商品大图|商品缩略图|颜色款式|商品保障|店铺保障)/,
  /^[\d\s¥.:%★+\-]+$/,
  /\.(gif|png|jpe?g|slim|webp|svg)(\?|$)/i,   // 资源文件名
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,                  // uuid
  /^[0-9a-f]{16,}$/i,                           // 长 hash
  /件$|人拼|人收藏|人好评|人买过/,
  /券$|关注券|无门槛|优惠前|已优惠|立即领取/,
  /^(店铺|收藏|客服|分享|首页|关闭弹窗|点击查看)/,
];

/** 尺码值的严格模式 */
const SIZE_PATTERNS = [
  /^\d{1,3}(?:\.5)?$/,                    // 36 / 39.5 / 100
  /^\d{1,3}[（(][^)）]{1,20}[)）]$/,       // 2（90-100）
  /^\d{1,3}\/\d{1,3}[A-Z]?$/,             // 150/72A
  /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|\dXL|均码|F|FREE)$/i,
];

function isSizeToken(t) {
  const s = String(t).trim();
  if (!s || s.length > 22) return false;
  return SIZE_PATTERNS.some((re) => re.test(s));
}

function isPriceText(s) {
  return /^¥\s*\d/.test(s) || /^(补贴价|新客|券后|拼单价|单买价)\s*¥/.test(s);
}

/** 从商品详情页解析：标题 / 价格
 *
 * 标题的关键技巧：它在价格节点之后（实测 y 轴上紧跟「券后 ¥ xxx」）。
 * 只靠"最长文本"会抓到《消费提醒》那段法律文案。
 */
function parseDetail(nodes) {
  const out = { title: null, price: null, marketPrice: null, sold: null };

  // ---- 价格 ----
  const prices = [];
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i].text;
    let m = /^(?:补贴价|新客|券后|拼单价|单买价)?\s*¥\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (m) { prices.push(Math.round(parseFloat(m[1]) * 100)); continue; }
    // 「¥」单独一个节点，后面跟数字
    if (t === '¥' && i + 1 < nodes.length) {
      const nx = nodes[i + 1].text;
      if (/^\d+(?:\.\d+)?$/.test(nx)) prices.push(Math.round(parseFloat(nx) * 100));
    }
  }
  if (prices.length) {
    out.price = Math.min.apply(null, prices);
    if (prices.length > 1) {
      const mx = Math.max.apply(null, prices);
      if (mx !== out.price) out.marketPrice = mx;
    }
  }

  // ---- 标题：优先取「价格节点之后」的文本 ----
  const priceIdx = [];
  for (let i = 0; i < nodes.length; i++) {
    if (isPriceText(nodes[i].text) || (nodes[i].text === '¥' && i + 1 < nodes.length
        && /^\d/.test(nodes[i + 1].text))) priceIdx.push(i);
  }
  const cands = [];
  for (const pi of priceIdx) {
    for (let k = pi + 1; k <= pi + 8 && k < nodes.length; k++) {
      const t = nodes[k].text;
      if (t.length < 8 || t.length > 90) continue;
      if (NOT_TITLE.some((re) => re.test(t))) continue;
      if (!/[\u4e00-\u9fa5]/.test(t)) continue;
      cands.push({ t, dist: k - pi });
      break;
    }
  }
  if (cands.length) {
    cands.sort((a, b) => b.t.length - a.t.length);   // 商品标题通常最长，徽标/券名都短
    out.title = cands[0].t;
  }
  // 兜底：全文最长的、不含排除词的文本
  if (!out.title) {
    let best = null;
    for (const n of nodes) {
      const t = n.text;
      if (t.length < 10 || t.length > 90) continue;
      if (NOT_TITLE.some((re) => re.test(t))) continue;
      if (!best || t.length > best.length) best = t;
    }
    out.title = best;
  }

  const sold = nodes.find((n) => /^已售[\d.]+[万+]*[件元]|^本店已拼/.test(n.text));
  out.sold = sold ? sold.text : null;
  return out;
}

/** 从 SKU 选择器解析：颜色 / 尺码 / 各档价格 */
function parseSku(nodes) {
  const out = { colors: [], sizes: [], prices: [], selectedHint: null };

  // SKU 弹层是浮在详情页之上的，所以两个页面的文字都会出现在 dump 里。
  // 技巧：取「最后一次出现」的标签 —— 弹层渲染在详情页之后。
  const COLOR_LABELS = ['颜色分类', '颜色', '颜色款式', '选择颜色'];
  let iColor = -1, iSize = -1;
  for (let i = 0; i < nodes.length; i++) {
    const t = nodes[i].text.trim();
    if (COLOR_LABELS.indexOf(t) >= 0) iColor = i;
    else if (/^尺码$|^选择尺码$/.test(t)) iSize = i;
  }

  // ---- 颜色：颜色标签之后、尺码标签之前 ----
  if (iColor >= 0) {
    const end = iSize > iColor ? iSize : Math.min(iColor + 30, nodes.length);
    for (let i = iColor + 1; i < end; i++) {
      const t = nodes[i].text.trim();
      if (!t || t.length < 2 || t.length > 42) continue;
      if (/^(马上卖完|即将售罄|请选择|优惠|颜色)$/.test(t)) continue;
      if (isSizeToken(t)) continue;
      if (isPriceText(t)) continue;
      if (NOT_TITLE.some((re) => re.test(t))) continue;
      if (/^(请选择|优惠|减少数量|增加数量|关闭弹窗|点击查看|查看全部)/.test(t)) continue;
      if (/\d{5,}|@|\*{3,}/.test(t)) continue;          // 手机号/地址/长数字
      if (/^[\x00-\x7F]*$/.test(t) && t.length > 4) continue;   // 纯 ASCII 长串
      out.colors.push(t);
    }
  }

  // ---- 尺码：尺码标签之后，严格匹配尺码形态，遇到第一个不匹配就停 ----
  if (iSize >= 0) {
    for (let i = iSize + 1; i < Math.min(iSize + 40, nodes.length); i++) {
      const t = nodes[i].text.trim();
      if (!t) continue;
      if (/^(免费服务|优惠|选择|请选择|立即支付|加入购物车)/.test(t)) break;
      if (isSizeToken(t)) out.sizes.push(t);
      else if (out.sizes.length > 0) {
        // 已经收集到尺码后又出现非尺码文本 → 尺码段结束
        if (!/^(马上卖完|即将售罄)$/.test(t)) break;
      }
    }
  }

  // ---- 价格档 ----
  for (const n of nodes) {
    const m = /^(补贴价|新客|券后|拼单价|单买价)\s*¥\s*(\d+(?:\.\d+)?)/.exec(n.text);
    if (m) out.prices.push({ label: m[1], fen: Math.round(parseFloat(m[2]) * 100) });
  }

  const hint = nodes.find((n) => /^请选择[:：]/.test(n.text));
  out.selectedHint = hint ? hint.text : null;

  out.colors = [...new Set(out.colors)];
  out.sizes = [...new Set(out.sizes)];
  // 价格档去重
  const seenP = new Set();
  out.prices = out.prices.filter((p) => {
    const k = p.label + p.fen;
    if (seenP.has(k)) return false;
    seenP.add(k); return true;
  });
  return out;
}

/** 找可点的购买按钮并打开 SKU 选择器 */
async function openSkuSheet() {
  const xml = dumpUi();
  const nodes = parseNodes(xml);
  // 优先「发起拼单 / 单独购买 / 直接拼单」
  const cands = nodes.filter((n) => /发起拼单|单独购买|直接拼单|立即购买/.test(n.text));
  if (!cands.length) return false;
  const btn = cands.find((n) => /发起拼单|直接拼单/.test(n.text)) || cands[0];
  const cx = Math.round((btn.x1 + btn.x2) / 2);
  const cy = Math.round((btn.y1 + btn.y2) / 2);
  await humanTap(cx, cy);
  await sleep(3500);
  return true;
}

/**
 * 用 App 打开商品详情。
 *
 * 必须用自定义 scheme `pinduoduo://`，不能用 http(s) 链接 ——
 * 后者会让系统打开浏览器而不是 App（实测）。
 * scheme 从 `dumpsys package` 里查到的可用值：pinduoduo / pddopen。
 *
 * 首次加载实测要 15~25 秒（App 冷启动 + 商品页渲染），所以要轮询等标题出现。
 */
async function openProduct(gid) {
  const schemeUrl = `pinduoduo://com.xunmeng.pinduoduo/goods.html?goods_id=${gid}`;
  adb(['shell', 'am', 'force-stop', 'com.xunmeng.pinduoduo']);
  await sleep(1200);
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', schemeUrl]);

  // 轮询等页面渲染出标题（最长 35 秒）
  let nodes = [];
  for (let i = 0; i < 14; i++) {
    await sleep(2500);
    nodes = parseNodes(dumpUi());
    const d = parseDetail(nodes);
    if (d.title && nodes.length > 10) return { nodes, detail: d, waitedMs: (i + 1) * 2500 };
  }
  return { nodes, detail: parseDetail(nodes), waitedMs: 35000 };
}

/**
 * 主流程
 * @param {string} goodsIdOrUrl
 */
async function collect(goodsIdOrUrl) {
  const gid = String(goodsIdOrUrl).match(/(\d{8,})/)
    ? String(goodsIdOrUrl).match(/(\d{8,})/)[1]
    : null;
  if (!gid) throw new Error('给一个 goods_id 或包含 goods_id 的链接');

  const result = {
    ok: false,
    goodsId: gid,
    url: `https://mobile.yangkeduo.com/goods.html?goods_id=${gid}`,
    title: null, price: null, marketPrice: null, sold: null, mallName: null,
    colors: [], sizes: [], prices: [],
    skuCount: 0, waitedMs: 0,
    notes: [],
  };

  // 1. 用 App 打开商品
  const opened = await openProduct(gid);
  result.waitedMs = opened.waitedMs;
  Object.assign(result, {
    title: opened.detail.title,
    price: opened.detail.price,
    marketPrice: opened.detail.marketPrice,
    sold: opened.detail.sold,
  });

  // 店铺名
  const mall = opened.nodes.find((n) => /^[\u4e00-\u9fa5A-Za-z0-9]{2,24}(店|馆)$/.test(n.text));
  if (mall) result.mallName = mall.text;

  if (!result.title) {
    result.notes.push(`等了 ${result.waitedMs}ms 仍未读到标题，页面可能没加载完或深链未生效`);
    return result;
  }

  // 2. 打开规格选择器
  const okBtn = await openSkuSheet();
  if (!okBtn) {
    result.notes.push('没找到购买按钮，规格未读到');
    return result;
  }

  // 3. 轮询等 SKU 弹层出现（最多 12 秒）
  let nodes = [];
  let sku = { colors: [], sizes: [], prices: [] };
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    nodes = parseNodes(dumpUi());
    sku = parseSku(nodes);
    if (sku.colors.length || sku.sizes.length) break;
  }

  result.colors = sku.colors;
  result.sizes = sku.sizes;
  result.prices = sku.prices;
  result.selectedHint = sku.selectedHint;
  result.skuCount = sku.colors.length * sku.sizes.length;

  if (!result.colors.length && !result.sizes.length) {
    result.notes.push('规格选择器打开了但没解析到值，检查 SKU 弹层是否真的出现');
  }

  result.ok = !!(result.title && (result.colors.length || result.sizes.length));
  return result;
}

// ---------------------------------------------------------------- CLI
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json');
  const asJson = process.argv.includes('--json');
  const target = args[0];

  if (!target) {
    console.log('用法: node tools/pdd-app-collect.js <goods_id 或 商品链接> [--json]');
    console.log('');
    // 顺手体检
    console.log('设备:', DEV);
    console.log('adb :', ADB);
    const devs = String(adb(['devices'])).trim();
    console.log(devs);
    const has = String(adb(['shell', 'pm', 'list', 'packages'])).includes('com.xunmeng.pinduoduo');
    console.log('拼多多已安装:', has);
    return;
  }

  const r = await collect(target);
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    console.log('商品ID :', r.goodsId);
    console.log('标题   :', r.title);
    console.log('价格   :', r.price ? (r.price / 100).toFixed(2) + ' 元' : '-',
                '(' + (r.price || 0) + ' 分)');
    console.log('参考价 :', r.marketPrice ? (r.marketPrice / 100).toFixed(2) + ' 元' : '-');
    console.log('已售   :', r.sold || '-');
    console.log('颜色   :', r.colors.length, '个');
    r.colors.forEach((c, i) => console.log('   ', i + 1, c));
    console.log('尺码   :', r.sizes.length, '个');
    console.log('   ', r.sizes.join('  '));
    if (r.prices.length) {
      console.log('价格档 :');
      r.prices.forEach((p) => console.log('   ', p.label, (p.fen / 100).toFixed(2) + ' 元'));
    }
    console.log('SKU数  :', r.skuCount);
    if (r.notes.length) { console.log('备注   :'); r.notes.forEach((n) => console.log('   ', n)); }
    console.log('结果   :', r.ok ? 'OK' : '数据不全');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('失败:', e && e.message); process.exit(1); });
}

module.exports = { collect, parseNodes, parseDetail, parseSku, ADB, DEV };
