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
    const text = decodeEntities(t[1]).trim();
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

/** uiautomator 会把 emoji 输出成 HTML 实体，解码回来便于判断 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch (e) { return ''; }
    })
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

// ------------------------------------------------------------- 过滤规则
/** 明显不是商品标题的文本 */
const NOT_TITLE = [
  /服饰类商品|消费提醒|七天无理由|不支持七天|已洗涤|吊牌/,
  /^(已售|券后|补贴|官方|品牌|店铺|支持|预计|最快|收藏|客服|进店|我关注)/,
  /退货包运费|极速退款|保证金|假一赔十|顺丰包邮|48小时发货|未发货秒退|全场包邮/,
  /^(商品详情|商品大图|商品缩略图|颜色款式|商品保障|店铺保障|商品评价)/,
  /^[\d\s¥.:%★+\-]+$/,
  /件$|人拼|人收藏|人好评|人买过|人已拼/,
  /券$|关注券|无门槛|优惠前|已优惠|立即领取/,
  /^(店铺|收藏|客服|分享|首页|关闭弹窗|点击查看)/,
  /\.(gif|png|jpe?g|slim|webp|svg)(\?|$)/i,
  /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /^[0-9a-f]{16,}$/i,
  // 拼单/团购 干扰
  /拼单|去拼单|团长|即将结束|参与可立即|已拼\s*$/,
  /\d{1,2}:\d{2}:\d{2}/,          // 倒计时
  /^这些人已拼/,
  /先用后付|0元下单|支付方式|确认收货后再付款/,
];

const PRICE_LABEL = '(?:大促价|秒杀价|活动价|到手价|补贴价|新客价?|券后价?|拼单价|单买价|百亿补贴)';

const SIZE_PATTERNS = [
  /^\d{1,3}(?:\.5)?$/,
  /^\d{1,3}[（(][^)）]{1,20}[)）]$/,
  /^\d{1,3}\/\d{1,3}[A-Z]?$/,
  /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|\dXL|均码|F|FREE)$/i,
  /^(?:均码|通用)$/,
];

function isSizeToken(t) {
  const s = String(t).trim();
  if (!s || s.length > 22) return false;
  return SIZE_PATTERNS.some((re) => re.test(s));
}

function priceFrom(text) {
  // 「大促价 ¥ 20.9」/「券后¥323.88」/「¥20.9」
  const re = new RegExp('^' + PRICE_LABEL + '?\\s*[¥￥]\\s*(\\d+(?:\\.\\d+)?)$');
  const m = re.exec(String(text).trim());
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

function isPriceNode(text) {
  return priceFrom(text) !== null;
}

// ------------------------------------------------------------- 详情页
function parseDetail(nodes) {
  const out = { title: null, price: null, marketPrice: null, sold: null };

  // ---- 价格 ----
  const prices = [];
  const priceIdx = [];
  for (let i = 0; i < nodes.length; i++) {
    const v = priceFrom(nodes[i].text);
    if (v !== null) { prices.push(v); priceIdx.push(i); continue; }
    if (nodes[i].text === '¥' || nodes[i].text === '￥') {
      const nx = nodes[i + 1] ? nodes[i + 1].text : '';
      if (/^\d+(?:\.\d+)?$/.test(nx)) {
        prices.push(Math.round(parseFloat(nx) * 100));
        priceIdx.push(i);
      }
    }
  }
  if (prices.length) {
    out.price = Math.min.apply(null, prices);
    const mx = Math.max.apply(null, prices);
    if (mx !== out.price) out.marketPrice = mx;
  }

  // ---- 标题：价格节点之后，取「最长且最干净」的 ----
  const cands = [];
  const pushCand = (t, dist) => {
    const s = String(t).trim();
    if (s.length < 8 || s.length > 90) return;
    if (NOT_TITLE.some((re) => re.test(s))) return;
    if (!/[\u4e00-\u9fa5]/.test(s)) return;
    if (/[¥￥]/.test(s)) return;
    cands.push({ t: s, dist });
  };
  for (const pi of priceIdx) {
    for (let k = pi + 1; k <= pi + 10 && k < nodes.length; k++) pushCand(nodes[k].text, k - pi);
  }
  if (!cands.length) {
    // 兜底：全页扫描
    nodes.forEach((n, i) => pushCand(n.text, 100 + i));
  }
  if (cands.length) {
    // 先按距离分组：距离越近越可能是标题；同距离内取最长
    cands.sort((a, b) => (a.dist - b.dist) || (b.t.length - a.t.length));
    // 再在最近的一批里取最长
    const nearest = cands.filter((c) => c.dist <= cands[0].dist + 3);
    nearest.sort((a, b) => b.t.length - a.t.length);
    out.title = nearest[0].t;
  }

  const sold = nodes.find((n) => /^已售[\d.]+[万+]*[件元]|^本店已拼|^[\d.]+万\+?人已拼/.test(n.text));
  out.sold = sold ? sold.text : null;
  return out;
}

// ------------------------------------------------------------- SKU 弹层
const COLOR_LABELS = ['颜色分类', '颜色', '颜色款式', '选择颜色', '颜色/款式'];
const SIZE_LABELS = ['尺码', '选择尺码', '尺寸'];

/**
 * 判断当前 dump 里是否真有 SKU 弹层。
 * 关键：弹层里必然同时出现「颜色xxxx」和「尺码」两个标签，且有「请选择」提示。
 * 只看一个标签会误判 —— 详情页里也有「颜色款式」字样。
 */
function detectSkuSheet(nodes) {
  let hintIdx = -1;
  for (let i = 0; i < nodes.length; i++) {
    if (/^请选择[:：]?\s*\S*(颜色|尺码)/.test(nodes[i].text)) { hintIdx = i; break; }
  }
  const ci = nodes.findIndex((n) => COLOR_LABELS.indexOf(n.text.trim()) >= 0);
  const si = nodes.findIndex((n) => SIZE_LABELS.indexOf(n.text.trim()) >= 0);
  return { isSheet: hintIdx >= 0 && ci >= 0 && si >= 0 && ci < si, hintIdx, ci, si };
}

function parseSku(nodes) {
  const out = { colors: [], sizes: [], prices: [], selectedHint: null };
  const det = detectSkuSheet(nodes);
  if (!det.isSheet) return out;

  out.selectedHint = nodes[det.hintIdx].text;

  // 颜色：颜色标签之后 → 尺码标签之前
  for (let i = det.ci + 1; i < det.si; i++) {
    const t = nodes[i].text.trim();
    if (t.length < 2 || t.length > 42) continue;
    if (isSizeToken(t)) continue;
    if (isPriceNode(t)) continue;
    if (NOT_TITLE.some((re) => re.test(t))) continue;
    if (/^(请选择|优惠|减少数量|增加数量|关闭弹窗|点击查看|查看全部)/.test(t)) continue;
    if (/\d{5,}|@|\*{3,}/.test(t)) continue;
    if (/^[\x00-\x7F]+$/.test(t) && t.length > 4) continue;
    out.colors.push(t);
  }

  // 尺码：尺码标签之后，严格匹配形态，遇到第一个不匹配就停
  for (let i = det.si + 1; i < Math.min(det.si + 40, nodes.length); i++) {
    const t = nodes[i].text.trim();
    if (!t) continue;
    if (/^(免费服务|优惠|选择|请选择|立即支付|加入购物车|确定)/.test(t)) break;
    if (isSizeToken(t)) out.sizes.push(t);
    else if (out.sizes.length > 0) {
      if (!/^(马上卖完|即将售罄)$/.test(t)) break;
    }
  }

  for (const n of nodes) {
    const v = priceFrom(n.text);
    if (v === null) continue;
    const m = new RegExp('^(' + PRICE_LABEL + ')').exec(n.text);
    out.prices.push({ label: m ? m[1] : '价格', fen: v });
  }

  out.colors = [...new Set(out.colors)];
  out.sizes = [...new Set(out.sizes)];
  const seenP = new Set();
  out.prices = out.prices.filter((p) => {
    const k = p.label + p.fen;
    if (seenP.has(k)) return false;
    seenP.add(k); return true;
  });
  return out;
}

// ------------------------------------------------------------- 动作
async function openProduct(gid) {
  const schemeUrl = `pinduoduo://com.xunmeng.pinduoduo/goods.html?goods_id=${gid}`;
  adb(['shell', 'am', 'force-stop', 'com.xunmeng.pinduoduo']);
  await sleep(1200);
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', schemeUrl]);

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
 * 打开规格选择器 —— **绝不点购买按钮**。
 *
 * 血泪教训：底部「发起拼单」在**单规格商品**上会直接下单（实测误下了一单
 * ¥20.9 的先用后付）。所以这里只点「规格/款式」那一行，它只会弹选择器。
 *
 * 优先级：
 *   1. 详情页的商品款式图/规格行（点它只开弹层）
 *   2. 「已选」「请选择」那一行
 *   3. 都不存在 → 判定为单规格商品，直接返回 false，不点任何东西
 */
async function openSpecSheetSafe() {
  const nodes = parseNodes(dumpUi());

  // 绝不允许点的购买类按钮（即便匹配也只用于排除）
  const BUY_RE = /发起拼单|直接拼单|单独购买|立即购买|去拼单|立即支付|确认拼单|下单/;

  // 1) 详情页的款式/规格缩略图区 —— 点它只打开选择器
  //    实测标签是「颜色款式」，旁边跟着「商品缩略图1..N」
  const STYLE_RE = /颜色款式|商品款式图|商品规格图|款式图|选择规格|规格图/;
  const styleThumb = nodes.find((n) => STYLE_RE.test(n.text) && !BUY_RE.test(n.text));
  if (styleThumb) {
    await humanTap(Math.round((styleThumb.x1 + styleThumb.x2) / 2),
                   Math.round((styleThumb.y1 + styleThumb.y2) / 2));
    await sleep(3000);
    return { opened: true, via: 'style-thumb' };
  }

  // 1b) 退一步：整行里带「款式」字样的可点节点
  const styleRow = nodes.find((n) => /款式/.test(n.text) && n.clickable && !BUY_RE.test(n.text));
  if (styleRow) {
    await humanTap(Math.round((styleRow.x1 + styleRow.x2) / 2),
                   Math.round((styleRow.y1 + styleRow.y2) / 2));
    await sleep(3000);
    return { opened: true, via: 'style-row' };
  }

  // 2) 「已选：xxx」/「请选择 xxx」行
  const selRow = nodes.find((n) => /^(已选|请选择)/.test(n.text) && !BUY_RE.test(n.text));
  if (selRow) {
    await humanTap(Math.round((selRow.x1 + selRow.x2) / 2),
                   Math.round((selRow.y1 + selRow.y2) / 2));
    await sleep(3000);
    return { opened: true, via: 'selected-row' };
  }

  // 3) 什么都不点 —— 单规格商品没有可选规格
  return { opened: false, via: null, reason: '详情页没有规格入口（可能是单规格商品）' };
}

/**
 * 主流程
 * @param {string} goodsIdOrUrl
 * @param {{deep?: boolean}} opts
 *   deep=false（默认）：**绝不点购买按钮**。只读详情页能看到的（标题/价格/当前选中款式），
 *                       颜色和尺码读不到就如实说明。
 *   deep=true ：点「发起拼单」打开规格弹层，能读到全部颜色/尺码。
 *                       风险：若商品已有默认规格或只有单一规格，拼多多会**直接下单**
 *                       （实测误下过一单 ¥20.9 的先用后付）。必须由用户显式开启。
 */
async function collect(goodsIdOrUrl, opts) {
  const deep = !!(opts && opts.deep);
  const mm = String(goodsIdOrUrl).match(/(\d{8,})/);
  const gid = mm ? mm[1] : null;
  if (!gid) throw new Error('给一个 goods_id 或包含 goods_id 的链接');

  const result = {
    ok: false,
    goodsId: gid,
    url: `https://mobile.yangkeduo.com/goods.html?goods_id=${gid}`,
    title: null, price: null, marketPrice: null, sold: null, mallName: null,
    colors: [], sizes: [], prices: [],
    skuCount: 0, waitedMs: 0, sheetOpened: false, sheetVia: null, deep: deep,
    notes: [],
  };

  const opened = await openProduct(gid);
  result.waitedMs = opened.waitedMs;
  Object.assign(result, {
    title: opened.detail.title,
    price: opened.detail.price,
    marketPrice: opened.detail.marketPrice,
    sold: opened.detail.sold,
  });

  const mall = opened.nodes.find((n) => /^.{2,24}(店|馆|旗舰店)$/.test(n.text)
    && !/^(我关注|进店|店铺)/.test(n.text));
  if (mall) result.mallName = mall.text;

  if (!result.title) {
    result.notes.push(`等了 ${result.waitedMs}ms 仍未读到标题，页面可能没加载完或深链未生效`);
    return result;
  }

  // 有一个款式名就先记下来（详情页会显示当前选中的那个）
  const styleRow = opened.nodes.find((n) => /^颜色款式$/.test(n.text));
  const hasStyleSection = !!styleRow;

  if (!deep) {
    result.notes.push(hasStyleSection
      ? '有颜色款式，但读全规格需要打开规格弹层；安全模式不点购买按钮（会误下单）。需要的话勾选「深度读取」'
      : '详情页没有款式区，可能是单规格商品');
    result.ok = !!result.title;
    return result;
  }

  // ---- 深度模式：点购买按钮打开弹层 ----
  const sheet = await openSpecSheetSafe();
  result.sheetVia = sheet.via || null;
  if (!sheet.opened) {
    result.notes.push(sheet.reason || '没有规格入口');
    result.ok = !!result.title;
    return result;
  }

  let nodes = [];
  let sku = { colors: [], sizes: [], prices: [] };
  for (let i = 0; i < 6; i++) {
    await sleep(2000);
    nodes = parseNodes(dumpUi());
    sku = parseSku(nodes);
    if (sku.colors.length || sku.sizes.length) { result.sheetOpened = true; break; }
  }

  result.colors = sku.colors;
  result.sizes = sku.sizes;
  result.prices = sku.prices;
  result.selectedHint = sku.selectedHint;
  result.skuCount = sku.colors.length * sku.sizes.length;

  if (!result.sheetOpened) {
    result.notes.push('规格弹层没确认打开（缺「请选择 颜色/尺码」提示）');
  }

  result.ok = !!(result.title && (result.colors.length || result.sizes.length));
  return result;
}

// ------------------------------------------------------------- CLI
async function main() {
  const asJson = process.argv.includes('--json');
  const deep = process.argv.includes('--deep');
  const args = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--deep');
  const target = args[0];

  if (!target) {
    console.log('用法: node tools/pdd-app-collect.js <goods_id 或 商品链接> [--json] [--deep]');
    console.log('      --deep  打开规格弹层读全部颜色/尺码（可能直接下单，慎用）');
    console.log('');
    console.log('设备:', DEV);
    console.log('adb :', ADB);
    console.log(String(adb(['devices'])).trim());
    const has = String(adb(['shell', 'pm', 'list', 'packages'])).includes('com.xunmeng.pinduoduo');
    console.log('拼多多已安装:', has);
    return;
  }

  const r = await collect(target, { deep });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    const y = (fen) => (fen ? (fen / 100).toFixed(2) + ' 元' : '-');
    console.log('商品ID :', r.goodsId);
    console.log('店铺   :', r.mallName || '-');
    console.log('标题   :', r.title);
    console.log('价格   :', y(r.price), r.price ? '(' + r.price + ' 分)' : '');
    console.log('参考价 :', y(r.marketPrice));
    console.log('已售   :', r.sold || '-');
    console.log('颜色   :', r.colors.length, '个');
    r.colors.forEach((c, i) => console.log('   ', i + 1, c));
    console.log('尺码   :', r.sizes.length, '个');
    if (r.sizes.length) console.log('   ', r.sizes.join('  '));
    if (r.prices.length) {
      console.log('价格档 :');
      r.prices.forEach((p) => console.log('   ', p.label, y(p.fen)));
    }
    console.log('SKU数  :', r.skuCount);
    if (r.notes.length) { console.log('备注   :'); r.notes.forEach((n) => console.log('   ', n)); }
    console.log('结果   :', r.ok ? 'OK' : '数据不全');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('失败:', e && e.message); process.exit(1); });
}

module.exports = { collect, parseNodes, parseDetail, parseSku, detectSkuSheet, ADB, DEV };
