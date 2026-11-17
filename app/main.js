'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const TRACE_FILE = path.join(os.tmpdir(), 'pdd-trace.log');
function trace(m) {
  try {
    fs.appendFileSync(TRACE_FILE, new Date().toISOString().slice(11, 23) + ' ' + m + '\n');
  } catch (_) { /* ignore */ }
}
try { fs.writeFileSync(TRACE_FILE, ''); } catch (_) { /* ignore */ }
trace('module start');

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, Menu, screen } = require('electron');
trace('electron required');

// 本环境必须关闭 Chromium 沙箱与 GPU，否则 Electron 原生层会访问违例
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();
trace('switches applied');

// ---------------------------------------------------------------- 数据目录
// 实测 %APPDATA% 下写文件会被系统拒绝（EPERM），导致：
//   · malls.json 写不进去 → 店铺列表每次重启丢失
//   · Partitions 目录建不了 → 登录态不落盘 → 每次都要重新扫码
// 因此把所有数据放到应用自己目录下，绕开这个限制，同时实现"绿色便携"。
const DATA_DIR = path.join(__dirname, 'userdata');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ }
app.setPath('userData', DATA_DIR);
try { app.setPath('sessionData', DATA_DIR); } catch (_) { /* ignore */ }
trace('userData -> ' + DATA_DIR);

// ---------------------------------------------------------------- 单实例锁
// 必须只允许一个实例：多开会互相抢 malls.json（写文件报 EPERM）和同一批 session 目录，
// 表现为店铺列表丢失、登录态被覆盖。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  trace('another instance is running, quitting this one');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

const MMS_HOME = 'https://mms.pinduoduo.com/home/';
const STORE_FILE = () => path.join(app.getPath('userData'), 'malls.json');

let mainWindow = null;
/** @type {Map<string, {id:string,name:string,view:WebContentsView,partition:string}>} */
const malls = new Map();
let activeId = null;
let viewVisible = true;
let attachedId = null;
let viewBounds = { x: 340, y: 88, width: 900, height: 760 };

// ---------------------------------------------------------------- 存储
function loadMalls() {
  try {
    if (!fs.existsSync(STORE_FILE())) return [];
    const arr = JSON.parse(fs.readFileSync(STORE_FILE(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

let lastSaveError = null;

function saveMalls() {
  try {
    const p = STORE_FILE();
    const data = JSON.stringify([...malls.values()].map((m) => ({ id: m.id, name: m.name })), null, 2);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data, 'utf8');
    lastSaveError = null;
    trace('saveMalls ok -> ' + p + ' (' + data.length + ' bytes)');
  } catch (e) {
    lastSaveError = String((e && e.message) || e);
    trace('saveMalls FAIL: ' + lastSaveError);
  }
}

function log(level, msg) {
  const line = { t: new Date().toISOString().slice(11, 19), level, msg: String(msg) };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('log', line); } catch (_) { /* ignore */ }
  }
  trace('[' + level + '] ' + line.msg);
}

// ---------------------------------------------------------------- 店铺视图
function createMall(name, forcedId) {
  const id = forcedId || ('mall_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
  const partition = 'persist:' + id;

  const sess = session.fromPartition(partition);
  sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  trace('session ready ' + partition);

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  trace('view created');

  try {
    const ua = view.webContents.getUserAgent().replace(/\sElectron\/[\d.]+/i, '');
    view.webContents.setUserAgent(ua);
  } catch (_) { /* ignore */ }

  view.webContents.on('did-finish-load', () => {
    log('info', '[' + name + '] 加载完成: ' + view.webContents.getURL().slice(0, 90));
  });
  view.webContents.on('did-navigate', (_e, url) => {
    log('info', '[' + name + '] 导航: ' + String(url).slice(0, 110));
  });
  view.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return;
    log('warn', '[' + name + '] 加载失败 ' + code + ' ' + desc);
  });

  view.webContents.loadURL(MMS_HOME);
  trace('loadURL called');

  const mall = { id, name, view, partition };
  malls.set(id, mall);
  saveMalls();
  log('ok', '店铺「' + name + '」已创建（独立 session: ' + partition + '）');
  return { id, name };
}

function currentMall() {
  if (activeId && malls.has(activeId)) return malls.get(activeId);
  return malls.values().next().value || null;
}

/**
 * 把键盘焦点还给主窗口（HTML 那一层）。
 * 为什么必须显式做：WebContentsView 是原生子视图，一旦被点过就会持有原生焦点。
 * 之后即使把它 removeChildView 摘掉，主窗口的 webContents 也不会自动重新获得
 * 键盘焦点 —— 表现是：弹窗里 input 是 document.activeElement，但
 * document.hasFocus() === false，于是鼠标能点、键盘打不进字、也删不掉字。
 */
function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try { mainWindow.focus(); } catch (_) { /* ignore */ }
  try { mainWindow.webContents.focus(); } catch (_) { /* ignore */ }
  return true;
}

function detachView() {
  if (!mainWindow || !attachedId) return;
  const m = malls.get(attachedId);
  if (m) {
    try { mainWindow.contentView.removeChildView(m.view); } catch (_) { /* ignore */ }
  }
  attachedId = null;
  // 视图摘掉后必须把键盘焦点交还 HTML 层，否则弹窗输入框打不进字
  focusMainWindow();
}

function attachView() {
  if (!mainWindow) return;
  const mall = currentMall();
  if (!mall || !viewVisible) {
    detachView();
    return;
  }
  if (attachedId && attachedId !== mall.id) detachView();
  if (attachedId !== mall.id) {
    try { mainWindow.contentView.addChildView(mall.view); } catch (_) { /* ignore */ }
    attachedId = mall.id;
    trace('view attached ' + mall.id);
  }
  applyBounds();
}

function applyBounds() {
  if (!attachedId || !mainWindow) return;
  const m = malls.get(attachedId);
  if (!m) return;
  try {
    m.view.setBounds({
      x: Math.round(Math.max(0, viewBounds.x)),
      y: Math.round(Math.max(0, viewBounds.y)),
      width: Math.round(Math.max(120, viewBounds.width)),
      height: Math.round(Math.max(120, viewBounds.height)),
    });
  } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------- 窗口
function createWindow() {
  Menu.setApplicationMenu(null);

  // 按屏幕可用区域自适应，避免窗口比屏幕还大导致操作不了
  let wa = { width: 1360, height: 860 };
  try {
    wa = screen.getPrimaryDisplay().workAreaSize;
  } catch (_) { /* ignore */ }
  const w = Math.max(900, Math.min(1500, Math.round(wa.width * 0.96)));
  const h = Math.max(620, Math.min(980, Math.round(wa.height * 0.94)));
  trace('window size: ' + w + 'x' + h + ' (workArea ' + wa.width + 'x' + wa.height + ')');

  mainWindow = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#0f1420',
    title: '拼多多上货中台',
    // 隐藏系统标题栏，由 renderer 的 .topbar 兼任（消除白色横条 + 品牌重复）
    // 约束：height 必须等于 style.css 的 --topbar-h；color 必须等于 --topbar-bg
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#18213a', symbolColor: '#c9d4e6', height: 46 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  trace('BrowserWindow created');

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  trace('loadFile called');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 屏幕较小时直接最大化，保证所有控件都点得到
    if (w < 1200 || h < 780) {
      try { mainWindow.maximize(); } catch (_) { /* ignore */ }
    }
    trace('window shown');
  });

  mainWindow.on('closed', () => {
    for (const m of malls.values()) {
      try { m.view.webContents.close(); } catch (_) { /* ignore */ }
    }
    malls.clear();
    attachedId = null;
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('malls:list', () => ({
  malls: [...malls.values()].map((m) => ({ id: m.id, name: m.name })),
  activeId,
  visible: viewVisible,
}));

ipcMain.handle('malls:add', (_e, name) => {
  const info = createMall(name || '新店铺');
  activeId = info.id;
  attachView();
  return info;
});

ipcMain.handle('malls:remove', (_e, id) => {
  const m = malls.get(id);
  if (!m) return false;
  if (attachedId === id) {
    try { mainWindow.contentView.removeChildView(m.view); } catch (_) { /* ignore */ }
    attachedId = null;
  }
  try { m.view.webContents.close(); } catch (_) { /* ignore */ }
  malls.delete(id);
  if (activeId === id) activeId = malls.keys().next().value || null;
  saveMalls();
  attachView();
  log('warn', '店铺「' + m.name + '」已移除');
  return true;
});

ipcMain.handle('malls:activate', (_e, id) => {
  if (!malls.has(id)) return false;
  activeId = id;
  attachView();
  log('info', '切换到店铺「' + malls.get(id).name + '」');
  return true;
});

ipcMain.handle('view:toggle', (_e, visible) => {
  viewVisible = !!visible;
  attachView();
  if (!viewVisible) focusMainWindow();   // 摘视图后把键盘焦点还给 HTML 层
  return viewVisible;
});

/** 渲染层弹窗打开前调用：确保窗口拿回键盘焦点 */
ipcMain.handle('window:focus', () => focusMainWindow());

ipcMain.handle('view:bounds', (_e, b) => {
  if (b && typeof b.x === 'number') {
    viewBounds = b;
    applyBounds();
  }
  return true;
});

ipcMain.handle('view:navigate', async (_e, url) => {
  const m = currentMall();
  if (!m) return false;
  await m.view.webContents.loadURL(url || MMS_HOME);
  return true;
});

ipcMain.handle('view:reload', () => {
  const m = currentMall();
  if (!m) return false;
  m.view.webContents.reload();
  return true;
});

ipcMain.handle('ops:ping', () => runInMall((ops) => ops.ping()));
ipcMain.handle('ops:list', () => runInMall((ops) => ops.listGoods(30)));
ipcMain.handle('ops:copy', async (_e, args) => {
  // 同店复制 = 把商品又搬回自己店，会产生重复链接。
  // 默认拦截，必须显式传 allowSameStore 才放行。
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  if (!args || !args.allowSameStore) {
    return {
      ok: false,
      blocked: 'same-store',
      error: '这是「同店复制」——会把商品在同一个店铺里再建一条重复链接。',
      advice: '正确做法是：先「采集到采集箱」，再从采集箱选择要上架的店铺。同店真的要做新链接，请勾选「允许同店复制」。',
    };
  }
  return runInMall((ops) => ops.copyGoods(args || {}));
});
ipcMain.handle('ops:draft', (_e, commit) => runInMall((ops) => ops.draftDetail(commit)));
ipcMain.handle('ops:submit', (_e, { goods, commit }) => runInMall((ops) => ops.submitDraft(goods, commit)));

// ---------------------------------------------------------------- 采集箱
const pool = require('./lib/pool');

ipcMain.handle('pool:list', () => pool.list());

ipcMain.handle('pool:collect', async (_e, { index }) => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  const r = await runInMall((o) => o.collectGoods({ index }));
  if (!r || !r.ok) return r || { ok: false, error: '采集失败' };

  const p = r.pack;
  const id = pool.add(Object.assign({}, p, {
    sourceMallId: m.id,
    sourceMallName: m.name,
  }));
  log('ok', '已采集到采集箱：' + String(p.title || '').slice(0, 20) + '（' + p.skus.length + ' SKU）');
  return { ok: true, id, pack: { title: p.title, skus: p.skus.length,
                                 images: p.gallery.length, sizes: p.sizes } };
});

ipcMain.handle('pool:remove', (_e, id) => {
  pool.remove(id);
  return { ok: true };
});

ipcMain.handle('pool:detail', (_e, id) => pool.get(id));

/** 从采集箱上架到指定店铺（跨店）
 *  做法：目标店里克隆一条它自己的商品当骨架 → 抓骨架草稿的保存载荷 →
 *        用采集箱数据覆盖标题/主图/价格 → 回放保存 → 提交
 */
ipcMain.handle('pool:publish', async (_e, { id, mallId, stock }) => {
  const it = pool.get(id);
  if (!it) return { ok: false, error: '采集箱里没有这一条' };

  const target = mallId ? malls.get(mallId) : currentMall();
  if (!target) return { ok: false, error: '目标店铺不存在' };
  if (target.id === it.sourceMallId) {
    return {
      ok: false, blocked: 'same-store',
      error: '目标店铺和源店铺是同一个。',
      advice: '同店上架会在同一个店里产生重复链接。请选择另一个店铺。',
    };
  }

  const steps = [];
  // 切到目标店
  activeId = target.id;
  attachView();
  await sleep(2500);
  steps.push('目标店铺: ' + target.name);

  // ① 目标店找一个骨架商品
  const ls = await runInMall((o) => o.listGoods(30));
  if (!ls || !ls.ok || !ls.items || !ls.items.length) {
    return { ok: false, error: '目标店铺没有在售商品，无法作为骨架', steps };
  }
  // ② 依次尝试骨架（同品类的优先），某个撞 600102 就换下一个
  const cands = ls.items.slice().sort((a, b) =>
    (b.cat_id === it.catId ? 1 : 0) - (a.cat_id === it.catId ? 1 : 0));

  let draft = null;
  let base = null;
  let lastErr = null;
  for (const cand of cands) {
    const cp = await runInMall((o) => o.copyGoods({
      index: cand.idx,
      title: String(it.title || '').slice(0, 60),
      submit: false,
      allowSameStore: true,
    }));
    if (cp && cp.ok) {
      draft = cp.result;
      base = cand;
      break;
    }
    lastErr = cp && (cp.detail || cp.error);
    steps.push('骨架 ' + String(cand.title || '').slice(0, 14) + ' 失败: ' +
               JSON.stringify(lastErr).slice(0, 80));
    await sleep(1200);
  }
  if (!draft) {
    return {
      ok: false,
      error: '目标店铺没有可用的骨架商品',
      advice: '目标店里所有商品都撞上了「该商品已被新建过」（平台限制同一商品连续新建）。' +
              '换一个目标店铺，或等一段时间再试。',
      steps,
      detail: lastErr,
    };
  }
  steps.push('骨架商品: ' + String(base.title || '').slice(0, 18) + '（goods ' + base.goods_id + '）');
  steps.push('骨架草稿: commit=' + draft.commit_id + ' goods=' + draft.goods_id +
             '（' + draft.images + ' 图 / ' + draft.skus + ' SKU）');

  // ③ 抓草稿保存载荷
  let raw = null;
  try {
    raw = await captureEditBody(target.view.webContents, draft.commit_id, draft.goods_id);
  } catch (e) {
    steps.push('抓载荷异常: ' + e.message);
  }
  if (!raw) {
    return { ok: false, error: '没抓到骨架载荷', advice: '稍后重试，或改用同店流程', steps,
             draft };
  }
  steps.push('载荷 ' + raw.length + ' 字节');

  // ④ 覆盖字段
  let body;
  try { body = JSON.parse(raw); } catch (e) {
    return { ok: false, error: '载荷解析失败', steps };
  }
  body.goods_name = String(it.title || '').slice(0, 60);
  const gal = (it.gallery || []).filter(Boolean);
  if (gal.length) {
    body.galleries = gal.map((u) => ({ url: u, width: 800, height: 800, type: 2 }));
  }
  // 价格：把源商品的最低拼单价套到所有 SKU 上（后续按 SKU 映射细化）
  if (it.price) {
    for (const s of (body.skus || [])) {
      const single = Math.max(Number(it.price) + 100, Number(s.price) || 0);
      s.multi_price = Number(it.price);
      s.price = single;
      s.multi_price_in_yuan = (s.multi_price / 100).toFixed(2);
      s.price_in_yuan = (single / 100).toFixed(2);
    }
    body.market_price = Math.max(Number(body.market_price) || 0, Number(it.price) + 100);
    body.market_price_in_yuan = (body.market_price / 100).toFixed(2);
  }
  if (stock) {
    for (const s of (body.skus || [])) s.quantity_delta = Number(stock);
  }
  steps.push('覆盖: 标题 + 图 ' + gal.length + ' 张 + 价格 ' + ((it.price || 0) / 100).toFixed(2));

  // ⑤ 回放保存
  const sv = await runInMall((o) => o.applyEditBody(JSON.stringify(body), draft.commit_id));
  steps.push('保存: ' + ((sv && sv.save && sv.save.ok) ? 'ok' : JSON.stringify(sv && sv.save)));

  // ⑥ 读页面 commit 后提交
  await sleep(2000);
  const pg = await runInMall((o) => o.readPageCommit());
  const useCommit = (pg && pg.commitId) || draft.commit_id;
  if (useCommit !== draft.commit_id) steps.push('commit 变化: ' + draft.commit_id + ' → ' + useCommit);

  const sub = await runInMall((o) => o.submitDraft(draft.goods_id, useCommit));
  steps.push('提交: ' + ((sub && sub.ok) ? 'ok' : JSON.stringify(sub && sub.detail)));

  return {
    ok: !!(sub && sub.ok),
    error: (sub && sub.ok) ? null : '提交被平台拒绝',
    detail: sub && sub.detail,
    steps,
    result: {
      goods_id: draft.goods_id,
      commit_id: useCommit,
      title: it.title,
      from: it.sourceMallName,
      to: target.name,
    },
  };
});

// 初始化采集箱存储
try { pool.init(DATA_DIR); } catch (e) { trace('pool init fail: ' + e.message); }

// ---------------------------------------------------------------- 尺码表模板
const SIZE_TPL_FILE = path.join(__dirname, 'data', 'size-templates.json');

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

/**
 * 提交上架前的"完整保存"：
 * 拼多多的类目校验读的是草稿的完整载荷状态。只调 commit/submit 而不先保存，
 * 会报 17000001「该类目商品发布必须设置满2件折扣」这类错——即使字段本身有值。
 * 所以这里：抓编辑页载荷 → 打上类目字段 → 回放 action/edit。
 */
async function prepareDraft(mall, commit, goods, opts) {
  const steps = [];
  let raw;
  try {
    raw = await captureEditBody(mall.view.webContents, commit, goods);
  } catch (e) {
    return { ok: false, error: e.message, steps };
  }
  if (!raw) return { ok: false, error: '没抓到草稿保存载荷', steps };

  let body;
  try { body = JSON.parse(raw); } catch (e) { return { ok: false, error: '载荷解析失败', steps }; }
  steps.push('载荷 ' + raw.length + ' 字节 / SKU ' + (body.skus || []).length);

  const patch = Object.assign({}, (opts && opts.patch) || {});
  if (opts && opts.factor && opts.factor > 0 && opts.factor !== 1) {
    const skus = body.skus || [];
    for (const s of skus) {
      const og = Number(s.multi_price) || 0;
      const op = Number(s.price) || 0;
      s.multi_price = Math.round(og * opts.factor);
      s.price = Math.max(Math.round(op * opts.factor), s.multi_price + 100);
      s.multi_price_in_yuan = (s.multi_price / 100).toFixed(2);
      s.price_in_yuan = (s.price / 100).toFixed(2);
    }
    steps.push('改价 ×' + opts.factor);
  }
  if (opts && opts.qty !== undefined && opts.qty !== null) {
    for (const s of (body.skus || [])) s.quantity_delta = Number(opts.qty);
    steps.push('库存 ' + opts.qty);
  }
  for (const k of Object.keys(patch)) {
    const before = body[k];
    body[k] = patch[k];
    steps.push(k + ': ' + JSON.stringify(before) + ' → ' + JSON.stringify(patch[k]));
  }

  const res = await runInMall((o) => o.applyEditBody(JSON.stringify(body), commit));
  const saveOk = !!(res && res.save && res.save.ok);
  steps.push('保存: ' + (saveOk ? 'ok' : JSON.stringify(res && res.save && res.save.err)));

  // 保存后 commit 可能被替换。优先从页面 URL 读（对草稿有效），
  // 再退到 create_by_sn（只对在售商品有效）。
  let pageCommit = null;
  const pg = await runInMall((o) => o.readPageCommit());
  if (pg && pg.commitId) pageCommit = pg.commitId;
  return { ok: saveOk, res, steps, pageCommit };
}

/**
 * 打开草稿编辑页 → 可选补库存 → 点「保存草稿」→ 读页面 URL 拿新 commit
 * 不依赖网络抓包（失败率太高），改为读页面自己的 URL。
 * 走平台锁：loadURL 会抢视图，必须串行。
 */
function saveDraftAndResolve(wc, commit, goods, stock) {
  return withPlatform('saveDraft', () => saveDraftAndResolveInner(wc, commit, goods, stock), 90000);
}

/**
 * 抓编辑页「保存草稿」的 action/edit 请求体（用主进程 webContents.debugger）。
 * 走平台锁：debugger 不能两处同时 attach。
 */
function captureEditBody(wc, commit, goods) {
  return withPlatform('captureEditBody', () => captureEditBodyInner(wc, commit, goods), 120000);
}

async function saveDraftAndResolveInner(wc, commit, goods, stock) {
  const ops = require('./lib/ops');
  const steps = [];
  const url = 'https://mms.pinduoduo.com/goods/goods_add/index?id=' + commit +
              '&goods_id=' + goods + '&type=edit';
  try {
    await wc.loadURL(url);
  } catch (e) {
    const msg = String((e && e.message) || e);
    steps.push('loadURL 异常(可忽略): ' + msg.slice(0, 60));
  }

  // 等「保存草稿」按钮出现
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = await wc.executeJavaScript(ops.hasSaveButton(), true);
    } catch (_) { ready = false; }
    if (ready) break;
    await sleep(500);
  }
  steps.push('编辑页就绪: ' + (ready ? '是' : '否'));
  if (!ready) return { ok: false, steps, pageCommit: null };

  if (stock) {
    try {
      const r = await wc.executeJavaScript(ops.setBatchStock(stock), true);
      steps.push('批量库存: ' + JSON.stringify(r));
    } catch (e) { steps.push('批量库存异常: ' + e.message.slice(0, 60)); }
    await sleep(1200);
  }

  try {
    const clicked = await wc.executeJavaScript(ops.clickSaveDraft(), true);
    steps.push('点保存: ' + JSON.stringify(clicked));
  } catch (e) {
    steps.push('点保存异常: ' + e.message.slice(0, 60));
  }
  await sleep(4000);

  let pg = null;
  try { pg = await wc.executeJavaScript(ops.readPageCommit(), true); } catch (_) {}
  const pageCommit = pg && pg.commitId ? pg.commitId : null;
  steps.push('保存后页面 commit: ' + pageCommit);

  let errs = [];
  try { errs = await wc.executeJavaScript(ops.readPageErrors(), true); } catch (_) {}
  if (errs && errs.length) steps.push('页面提示: ' + JSON.stringify(errs.slice(0, 4)));

  return { ok: true, steps, pageCommit, pageErrors: errs || [] };
}

/**
 * 提交上架：
 *   ① 开编辑页 → 保存草稿 → 读新 commit → 提交
 *   ② 若 600001 → 再读 URL 重试
 *   ③ 若 17000001 → 说明缺满件折扣，给出明确指引
 */
ipcMain.handle('ops:publish', async (_e, args) => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  const commit = Number(args.commit);
  const goods = Number(args.goods);
  const stock = args.stock === undefined ? 0 : Number(args.stock);
  const wc = m.view.webContents;
  const steps = [];
  steps.push('目标: goods=' + goods + ' commit=' + commit);

  const prep = await saveDraftAndResolve(wc, commit, goods, stock);
  steps.push.apply(steps, prep.steps || []);

  // 编辑页都打不开 = 草稿基本已不存在，别往提交上撞
  if (prep && prep.ok === false) {
    return {
      ok: false,
      error: '编辑页打不开（草稿可能已在后台被删除）',
      advice: '这条草稿已经不存在了。回商品列表重新复制一次再上架。',
      steps,
    };
  }

  // 编辑页自己报「该编辑不存在」= 草稿已被删除，直接给出结论
  const pe = (prep && prep.pageErrors) || [];
  if (pe.some((x) => /该编辑不存在|未传goods_id/.test(String(x)))) {
    return {
      ok: false,
      error: '草稿已被删除（编辑页提示「该编辑不存在」）',
      advice: '这条草稿在后台已经没有内容了。回商品列表重新复制一次再上架。',
      steps,
      usedCommit: commit,
    };
  }

  let useCommit = prep.pageCommit || commit;

  // 提交前确认草稿还在（避免拿已删除的草稿反复提交）
  const exist = await runInMall((o) => o.draftDetail(useCommit));
  if (!exist || !exist.ok) {
    steps.push('草稿校验失败: ' + JSON.stringify((exist && (exist.error || exist.detail)) || exist || '').slice(0, 150));
    return {
      ok: false,
      error: '草稿不存在或已被删除',
      advice: '这条草稿查不到（可能已在后台删除）。回商品列表重新复制一次再上架。',
      steps,
      usedCommit: useCommit,
    };
  }
  steps.push('草稿校验通过: ' + String(exist.title || '').slice(0, 24));

  let sub = await runInMall((o) => o.submitDraft(goods, useCommit));
  steps.push('提交(' + useCommit + '): ' +
             (sub && sub.ok ? 'ok' : JSON.stringify((sub && sub.detail) || sub)));

  let err = JSON.stringify((sub && sub.detail) || '');
  if (sub && !sub.ok && /600001|该编辑不存在/.test(err)) {
    const pg = await runInMall((o) => o.readPageCommit());
    if (pg && pg.commitId) {
      steps.push('改读页面 commit: ' + useCommit + ' → ' + pg.commitId);
      useCommit = pg.commitId;
      await sleep(2000);
      sub = await runInMall((o) => o.submitDraft(pg.goodsId || goods, useCommit));
      steps.push('重试提交: ' +
                 (sub && sub.ok ? 'ok' : JSON.stringify((sub && sub.detail) || sub)));
      err = JSON.stringify((sub && sub.detail) || '');
    }
  }

  let advice = null;
  if (sub && !sub.ok) {
    if (/17000001|满2件/.test(err)) {
      advice = '缺「满2件折扣」。请在编辑页 营销 → 满2件折扣 里设 95 折，保存后再提交。';
    } else if (/610003|请先保存草稿/.test(err)) {
      advice = '草稿没有内容。删掉这条草稿，重新复制一次再上架。';
    } else if (/600001|600009/.test(err)) {
      advice = '草稿已被替换或删除。删掉旧草稿，重新复制。';
    } else if (/600102|已被新建过/.test(err)) {
      advice = '这个商品今天复制次数太多，换一个商品。';
    }
  }

  return { ok: !!(sub && sub.ok), submit: sub, advice, steps, usedCommit: useCommit };
});

// ---------------------------------------------------------------- 诊断 & 店铺在线状态
ipcMain.handle('debug:info', () => {  const p = STORE_FILE();
  let exists = false, size = 0, raw = null;
  try {
    exists = fs.existsSync(p);
    if (exists) { size = fs.statSync(p).size; raw = fs.readFileSync(p, 'utf8').slice(0, 300); }
  } catch (_) { /* ignore */ }
  return {
    userData: app.getPath('userData'),
    sessionData: (() => { try { return app.getPath('sessionData'); } catch (_) { return null; } })(),
    storeFile: p,
    exists, size, raw,
    lastSaveError,
    mallCount: malls.size,
    mallIds: [...malls.keys()],
    partitions: [...malls.values()].map((m) => ({
      id: m.id, partition: m.partition, url: (() => {
        try { return m.view.webContents.getURL(); } catch (_) { return null; }
      })(),
    })),
  };
});

/** 查某个店铺的登录态（不需要它是当前显示的那个） */
ipcMain.handle('ops:pingMall', async (_e, id) => {
  const ops = require('./lib/ops');
  const m = malls.get(id);
  if (!m) return { online: false, reason: '店铺不存在' };
  const wc = m.view.webContents;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const r = await wc.executeJavaScript(ops.ping(), true);
      if (r && r.__blocked) { await sleep(600); continue; }
      return { online: !!(r && r.ok && r.login), href: r && r.href, reason: r && (r.error || r.detail) };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/destroyed|navigat|context|Render frame/i.test(msg)) { await sleep(500); continue; }
      return { online: false, reason: msg.slice(0, 160) };
    }
  }
  return { online: false, reason: '页面未就绪' };
});

// ---------------------------------------------------------------- 改价
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 打开该草稿的编辑页，程序点一次「保存草稿」，抓 action/edit 的完整请求体。
 * 这样不必逆向 schema —— 页面自己会给出这份草稿的合法载荷。
 */
async function captureEditBodyInner(wc, commit, goods) {
  const dbg = wc.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attached = true;
    }
  } catch (e) {
    throw new Error('调试器附加失败: ' + e.message);
  }

  const bodies = [];
  const onMsg = (_evt, method, params) => {
    if (method !== 'Network.requestWillBeSent') return;
    const req = (params && params.request) || {};
    const url = req.url || '';
    if (url.indexOf('action/edit') >= 0 && req.postData) bodies.push(req.postData);
  };
  dbg.on('message', onMsg);

  try {
    await dbg.sendCommand('Network.enable', { maxTotalBufferSize: 80 * 1024 * 1024 });

    const url = 'https://mms.pinduoduo.com/goods/goods_add/index?id=' + commit +
                '&goods_id=' + goods + '&type=edit';
    log('info', '打开发货编辑页抓取保存载荷 ...');
    await wc.loadURL(url);
    await sleep(7000);

    const ops = require('./lib/ops');
    const clicked = await wc.executeJavaScript(ops.clickSaveDraft(), true);
    log('info', '点击「保存草稿」: ' + JSON.stringify(clicked));

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !bodies.length) await sleep(500);

    return bodies[0] || null;
  } finally {
    try { dbg.removeListener('message', onMsg); } catch (_) { /* ignore */ }
    if (attached) {
      try { await dbg.sendCommand('Network.disable'); } catch (_) { /* ignore */ }
      try { dbg.detach(); } catch (_) { /* ignore */ }
    }
  }
}

ipcMain.handle('ops:changePrice', async (_e, args) => {
  const ops = require('./lib/ops');
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };

  const commit = Number(args.commit);
  const goods = Number(args.goods);
  const factor = args.factor === undefined || args.factor === null ? null : Number(args.factor);
  const setGroup = args.setGroup === undefined || args.setGroup === null ? null : Number(args.setGroup);
  const qty = args.qty === undefined || args.qty === null ? null : Number(args.qty);
  if (factor === null && setGroup === null) {
    return { ok: false, error: '需要 factor 或 setGroup' };
  }

  const steps = [];
  let raw;
  try {
    raw = await captureEditBody(m.view.webContents, commit, goods);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (!raw) {
    return { ok: false, error: '没抓到保存载荷：编辑页可能没加载完，或「保存草稿」按钮结构变了', steps };
  }
  steps.push('抓到载荷 ' + raw.length + ' 字节');

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: '载荷解析失败: ' + e.message, steps };
  }

  const skus = body.skus || [];
  steps.push('SKU 数 ' + skus.length);
  if (!skus.length) return { ok: false, error: '载荷里没有 skus', steps };

  for (const s of skus) {
    const og = Number(s.multi_price) || 0;
    const op = Number(s.price) || 0;
    if (setGroup !== null) {
      s.multi_price = setGroup;
      s.price = Math.max(setGroup + 100, op);
    } else {
      s.multi_price = Math.round(og * factor);
      s.price = Math.round(op * factor);
      if (s.price <= s.multi_price) s.price = s.multi_price + 100;
    }
    s.multi_price_in_yuan = (s.multi_price / 100).toFixed(2);
    s.price_in_yuan = (s.price / 100).toFixed(2);
  }

  const gs = skus.map((s) => Number(s.multi_price) || 0);
  const ss = skus.map((s) => Number(s.price) || 0);
  body.market_price = Math.max(Number(body.market_price) || 0, Math.max.apply(null, ss) + 100);
  body.market_price_in_yuan = (body.market_price / 100).toFixed(2);
  if (body.groups && typeof body.groups === 'object') {
    body.groups.group_price = Math.min.apply(null, gs);
    body.groups.single_price = Math.max.apply(null, ss);
  }
  steps.push('拼单价 ' + (Math.min.apply(null, gs) / 100).toFixed(2) + ' ~ ' +
             (Math.max.apply(null, gs) / 100).toFixed(2) + ' 元');

  // 类目必填项（例如满2件折扣），由调用方传入
  if (args.patch && typeof args.patch === 'object') {
    for (const k of Object.keys(args.patch)) {
      const before = body[k];
      body[k] = args.patch[k];
      steps.push('类目字段 ' + k + ': ' + JSON.stringify(before) + ' → ' + JSON.stringify(args.patch[k]));
    }
  }

  if (qty !== null) {
    for (const s of skus) s.quantity_delta = qty;
    steps.push('quantity_delta = ' + qty + '（草稿态不一定回显库存）');
  }

  const payload = JSON.stringify(body);
  const res = await runInMall((o) => o.applyEditBody(payload, commit));
  return Object.assign({}, res, { steps: steps.concat((res && res.steps) || []) });
});

/**
 * 平台访问互斥锁。
 * 所有对拼多多页面的操作（runInMall / captureEditBody / 打开编辑页）都必须排队，
 * 否则并发时会互相 loadURL 抢占，抓到错载荷、状态变成"未知"。
 * AGENTS.md §1.2.3 要求：批量任务必须有全局互斥锁 + 看门狗。
 */
let platformQueue = Promise.resolve();
let platformDepth = 0;

function withPlatform(label, fn, timeoutMs) {
  const limit = timeoutMs || 120000;
  const run = async () => {
    platformDepth++;
    trace('platform+ ' + label + ' (depth ' + platformDepth + ')');
    let timer = null;
    try {
      const work = fn();
      const guard = new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error('平台操作超时（' + limit + 'ms）：' + label)), limit);
      });
      return await Promise.race([work, guard]);
    } catch (e) {
      const msg = String((e && e.message) || e);
      log('err', '平台操作失败[' + label + ']: ' + msg.slice(0, 160));
      return { ok: false, error: msg.slice(0, 300), unknown: true };
    } finally {
      if (timer) clearTimeout(timer);
      platformDepth--;
      trace('platform- ' + label + ' (depth ' + platformDepth + ')');
    }
  };

  // 串行化：前一个完成（无论成败）才轮到下一个
  const next = platformQueue.then(run, run);
  platformQueue = next.catch(() => {});   // 队列本身不能被 reject 打断
  return next;
}

async function runInMall(build) {
  let ops;
  try {
    ops = require('./lib/ops');
  } catch (e) {
    return { ok: false, error: 'ops 模块加载失败: ' + e.message };
  }
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺，先点「添加店铺」' };
  if (!m.view || !m.view.webContents) return { ok: false, error: '店铺视图未就绪' };

  const js = build(ops);
  const wc = m.view.webContents;

  return withPlatform('runInMall', async () => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const res = await wc.executeJavaScript(js, true);
        if (res && res.__blocked) {
          await sleep(1200);
          continue;
        }
        return res;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/destroyed|navigat|context|Render frame/i.test(msg) && Date.now() < deadline) {
          await sleep(1000);
          continue;
        }
        log('err', '执行失败: ' + msg.slice(0, 200));
        return { ok: false, error: msg.slice(0, 300) };
      }
    }
    return { ok: false, error: '页面未就绪（__mms 一直不可用）。请在右侧浏览器里确认已登录商家后台。' };
  }, 40000);
}

// ---------------------------------------------------------------- 启动
trace('registering whenReady');
app.whenReady().then(() => {
  trace('whenReady fired');
  createWindow();

  const saved = loadMalls();
  trace('saved malls: ' + saved.length);
  for (const s of saved) {
    try { createMall(s.name, s.id); } catch (e) { trace('restore fail: ' + e.message); }
  }
  if (malls.size) activeId = malls.keys().next().value;

  mainWindow.webContents.once('did-finish-load', () => {
    trace('renderer did-finish-load');
    attachView();
    log('ok', '应用已启动');
    if (!malls.size) {
      log('info', '点左侧「＋ 添加」，在右侧内置浏览器里扫码登录（只需一次）');
    }
  });
});

process.on('uncaughtException', (e) => {
  trace('uncaughtException: ' + (e && e.stack ? e.stack : e));
});
process.on('unhandledRejection', (e) => {
  trace('unhandledRejection: ' + (e && e.stack ? e.stack : e));
});

/**
 * 退出前把各店铺 session 的 cookie / storage 落盘。
 * 不做这一步时，强制结束进程会让刚扫码的登录态丢失（Chromium 是异步刷盘的）。
 */
let flushed = false;
app.on('before-quit', async (event) => {
  if (flushed) return;
  flushed = true;
  event.preventDefault();
  trace('before-quit: flushing sessions');
  for (const m of malls.values()) {
    try {
      await session.fromPartition(m.partition).flushStorageData();
      trace('flushed ' + m.partition);
    } catch (e) {
      trace('flush fail ' + m.partition + ': ' + e.message);
    }
  }
  try { await session.defaultSession.flushStorageData(); } catch (_) { /* ignore */ }
  trace('flush done, quitting');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
