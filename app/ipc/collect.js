'use strict';
/**
 * 采集域：买家端采集会话 + 网页/App 商品采集 + 本地图片落地。
 *
 * collector:*      采集会话视图（persist:collector 分区）的显示/导航/求值/读取
 * collect:full     从 URL 或 App 深链采一个商品，完整字段（含 SKU/规格）
 * app:collect      只给 goods_id 时走 App 通道采集
 * img:fetchToLocal 把 CDN 图片下载到本地目录（空白新建上传前的必备步骤）
 * img:setFileInput 用 CDP 把本地文件喂给 input[type=file]（页面 JS 做不到）
 *
 * 采集会话的登录态靠 main.js 的 before-quit flush COLLECTOR_PARTITION 保活，
 * 本文件只负责用 getCollector() 拿视图。
 */
module.exports = function registerCollect(ctx) {
  const {
    ipcMain, fs, path, DATA_DIR, getCollector,
    sleep, log, trace, pool,
    currentMall, detachView, attachView, setFileInputFiles, errText, withPlatform,
    COLLECTOR_PARTITION, COLLECTOR_HOME,
    getViewKind, setViewKind,
  } = ctx;

  // 采集会话读取脚本是 lib/collector 导出的常量，本文件直接用，不走 ctx
  // （它在 main.js 里也是这么解构的；漏注入会报 COLLECTOR_READ_JS is not defined）。
  const { COLLECTOR_READ_JS } = require('../lib/collector');
  const imgtool = require('../lib/imgtool');

/**
 * 下载一组图片 URL 到本地目录。返回本地路径列表。
 * 用途：空白新建商品时，源图是 PDD CDN 上的 URL，得先落地成本地文件才能上传。
 */
async function fetchImagesToDir(urls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ok = [];
  const errors = [];
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  for (let i = 0; i < list.length; i++) {
    const ext = /\.png(\?|$)/i.test(list[i]) ? '.png' : '.jpg';
    const dest = path.join(dir, 'src_' + String(i + 1).padStart(2, '0') + ext);
    const r = await imgtool.download(list[i], dest);
    if (r && r.ok) ok.push(dest);
    else errors.push('第 ' + (i + 1) + ' 张：' + ((r && r.error) || '失败'));
  }
  return { ok: ok.length > 0, files: ok, errors };
}

ipcMain.handle('img:fetchToLocal', async (_e, { urls, tag }) => {
  const dir = path.join(DATA_DIR, 'uploads', (tag || 'tmp') + '_' + Date.now());
  const r = await fetchImagesToDir(urls, dir);
  return Object.assign({ dir }, r);
});

/** 把本地文件喂给页面 file input（CDP） */
ipcMain.handle('img:setFileInput', async (_e, { files, selector }) => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  return withPlatform('setFileInput',
    () => setFileInputFiles(m.view.webContents, selector || 'input[type=file]', files), 60000);
});

// ---------------------------------------------------------------- 采集会话 IPC
/** 切换右侧浏览区显示「店铺后台」还是「采集会话」 */
ipcMain.handle('collector:show', async (_e, on) => {
  setViewKind(on ? 'collector' : 'mall');
  if (on) getCollector();
  detachView();
  attachView();
  return { ok: true, kind: getViewKind() };
});

ipcMain.handle('collector:navigate', async (_e, url) => {
  const v = getCollector();
  const target = url || COLLECTOR_HOME;
  try { await v.webContents.loadURL(target); } catch (e) {
    if (!/ERR_ABORTED/.test(String(e && e.message))) return { ok: false, error: errText(e) };
  }
  return { ok: true, url: v.webContents.getURL() };
});

/** 采集会话里执行任意 JS（调试用） */
ipcMain.handle('collector:eval', async (_e, { code, timeoutMs }) => {
  const v = getCollector();
  return withPlatform('collectorEval', async () => {
    const val = await v.webContents.executeJavaScript(code, true);
    return { ok: true, value: val };
  }, timeoutMs || 60000);
});

/**
 * 从采集会话当前页面读商品数据。
 * 消费者端商品页强制登录（实测 needLogin:true），登录后数据在
 * window.rawData.store.initDataObj.goods 里；同时做一轮 DOM 兜底。
 */
ipcMain.handle('collector:read', async () => {
  const v = getCollector();
  return withPlatform('collectorRead', async () => {
    const val = await v.webContents.executeJavaScript(COLLECTOR_READ_JS, true);
    return val;
  }, 90000);
});

/**
 * 一键采集：网页（标题/主图/详情图/属性）+ App（价格/颜色/尺码），合并后返回。
 *
 * 两个来源分工的原因：
 *   · 网页端价格和规格是服务端打码的（实测任何 UA / 设备模拟都一样）
 *   · App 里的商品图在缓存里，导不出来
 *
 * 容错：两边互为备份。App 不可用（模拟器没开、掉登录）时只用网页数据照样能采；
 * 网页不可用时只用 App 数据。两个都失败才报错。
 */
ipcMain.handle('collect:full', async (e, { target, deep }) => {
  const t = String(target || '').trim();
  if (!t) return { ok: false, error: '先填商品链接或商品ID' };
  const gid = (t.match(/(\d{8,})/) || [])[1];
  if (!gid) return { ok: false, error: '链接或ID里找不到商品编号（需要 8 位以上数字）' };

  const url = 'https://mobile.yangkeduo.com/goods.html?goods_id=' + gid;
  const notes = [];
  let app = null;
  let web = null;

  // ---------- 1. App：价格 / 颜色 / 尺码（失败不阻塞） ----------
  try {
    const r = await collectFromApp(gid, !!deep);
    if (r && r.ok) app = r.data;
    else notes.push('App 那半段没成功：' + ((r && r.error) || '未知'));
  } catch (ex) {
    notes.push('App 那半段异常：' + errText(ex));
  }

  // ---------- 2. 网页：标题 / 主图 / 详情图 / 属性 ----------
  try {
    web = await collectFromWeb(url);
    if (!web || !web.ok) {
      notes.push('网页那半段没成功：' + ((web && (web.notes || [])[0]) || '读取失败'));
      web = null;
    }
  } catch (ex) {
    notes.push('网页那半段异常：' + errText(ex));
    web = null;
  }

  // App 数据校验：和网页标题对不上说明读到了别的商品（冷启动恢复旧页面）
  if (app && web && app.title && web.title) {
    const norm = (s) => String(s).replace(/[\s\p{P}]/gu, '').slice(0, 12);
    const a = norm(app.title);
    const b = norm(web.title);
    let same = a === b;
    if (!same) {
      // 前 8 个字有交集也算同一个商品（标题可能有细微差异）
      let hit = 0;
      for (const ch of a) if (b.indexOf(ch) >= 0) hit++;
      same = hit >= Math.min(8, Math.ceil(a.length * 0.7));
    }
    if (!same) {
      notes.push('App 读到的商品和网页不一致（' + String(app.title).slice(0, 14) +
                 ' ≠ ' + String(web.title).slice(0, 14) + '），已丢弃 App 数据');
      app = null;
    }
  }

  if (!app && !web) {
    return {
      ok: false,
      error: notes[0] || '两边都没采到数据',
      notes,
    };
  }

  // ---------- 3. 合并 ----------
  const data = {
    ok: true,
    goodsId: gid,
    url,
    // 标题优先用网页端：它是按 goods_id 直接打开的，最权威；App 可能停在别的页面
    title: (web && web.title) || (app && app.title) || null,
    price: (app && app.price) || null,
    marketPrice: (app && app.marketPrice) || null,
    sold: (app && app.sold) || null,
    mallName: (app && app.mallName) || null,
    colors: (app && app.colors) || [],
    sizes: (app && app.sizes) || [],
    prices: (app && app.prices) || [],
    skuCount: (app && app.skuCount) || 0,
    gallery: [],
    detailGallery: [],
    property: [],
    catNames: [],
    catId: null,
    sources: { app: !!app, web: !!web },
    notes,
  };

  if (web) {
    const imgs = [];
    const seen = new Set();
    for (const u of [].concat(web.gallery || [], web.detailGallery || [])) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      imgs.push(u);
    }
    data.gallery = imgs.slice(0, 20);
    data.detailGallery = (web.detailGallery || []).slice(0, 30);
    data.property = web.property || [];
    data.catNames = web.cats || [];
    data.catId = web.catId || null;
  }

  if (!app) {
    notes.push('这次没有价格和颜色/尺码（App 那半段没跑通）。价格上架时自己定，颜色尺码可以手动补');
  }
  if (!web) {
    notes.push('这次没有图片（网页那半段没跑通），可以稍后单独补');
  }
  data.notes = notes;
  return { ok: true, data };
});

/** 跑 App 采集脚本 */
function collectFromApp(gid, deep) {
  const script = path.join(__dirname, '..', 'tools', 'pdd-app-collect.js');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: '找不到采集脚本 tools/pdd-app-collect.js' });

  log('info', 'App 采集：' + gid + (deep ? '（深度）' : '（安全）'));

  return new Promise((resolve) => {
    const args = [script, gid, '--json'];
    if (deep) args.push('--deep');
    const child = spawn(process.execPath, args, {
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; try { child.kill(); } catch (_) {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'App 采集超时（180 秒）。检查模拟器是否在运行、拼多多是否已登录' }), 180000);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (ex) => { clearTimeout(timer); finish({ ok: false, error: '启动采集脚本失败：' + errText(ex) }); });
    child.on('close', () => {
      clearTimeout(timer);
      const i = out.lastIndexOf('{');
      let data = null;
      if (i >= 0) { try { data = JSON.parse(out.slice(i)); } catch (_) { data = null; } }
      if (!data) { finish({ ok: false, error: '采集脚本没有返回可解析的结果', raw: (out + err).slice(-600) }); return; }
      if (!data.ok) { finish({ ok: false, error: (data.notes && data.notes[0]) || '采集数据不全', data }); return; }
      finish({ ok: true, data });
    });
  });
}

/** 在采集会话（买家账号）里打开商品页并读取，用于补主图/详情图/属性 */
async function collectFromWeb(url) {
  const v = getCollector();
  const wc = v.webContents;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; resolve(); };
    const timer = setTimeout(done, 25000);
    wc.once('did-finish-load', () => { clearTimeout(timer); setTimeout(done, 2500); });
    wc.once('did-fail-load', () => { clearTimeout(timer); done(); });
    try { wc.loadURL(url).catch(done); } catch (_) { done(); }
  });

  await sleep(1500);

  try {
    const raw = await wc.executeJavaScript(COLLECTOR_READ_JS, true);
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return d;
  } catch (ex) {
    return { ok: false, error: errText(ex) };
  }
}

/**
 * 兼容旧入口：只跑 App 那半段（不含网页补图）。
 * 保留它是因为界面上「深度读取」的警告和分级反馈依赖这个粒度。
 */
ipcMain.handle('app:collect', async (e, { target, deep }) => collectFromApp(
  (String(target || '').match(/(\d{8,})/) || [])[1] || '',
  !!deep,
).then((r) => (r && r.data && r.data.goodsId ? r : { ok: false, error: '链接或ID里找不到商品编号' })));

  return {  };
};
