'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

const TRACE_FILE = path.join(os.tmpdir(), 'pdd-trace.log');
const MALL_ZOOM = 0.7; // 店铺后台视图默认缩放：页面内容更紧凑，一屏看更多
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
const FINANCE_DIR = path.join(DATA_DIR, 'finance');
const FINANCE_SNAPSHOT_DIR = path.join(FINANCE_DIR, 'snapshots');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ }
try { fs.mkdirSync(FINANCE_SNAPSHOT_DIR, { recursive: true }); } catch (_) { /* ignore */ }
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

// ---------------------------------------------------------------- 资金快照
function financeDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function financeDataDate(stores) {
  const dates = [];
  for (const s of (stores || [])) {
    for (const d of (s.daily || [])) if (d && d.date) dates.push(String(d.date).slice(0, 10));
    for (const d of (s.days || [])) if (d && d.date) dates.push(String(d.date).slice(0, 10));
  }
  return dates.length ? dates.sort().pop() : null;
}

function saveFinanceSnapshot(data) {
  try {
    const at = Number(data.at) || Date.now();
    const day = financeDay(at);
    const dataDate = financeDataDate(data.stores || []);
    const payload = {
      version: 1,
      collectedAt: at,
      dataDate,
      month: data.month || new Date(at).toISOString().slice(0, 7),
      aggregate: data.aggregate || null,
      stores: data.stores || [],
    };
    const snapshotFile = path.join(FINANCE_SNAPSHOT_DIR, 'snapshot-' + day + '.json');
    fs.writeFileSync(snapshotFile, JSON.stringify(payload, null, 2), 'utf8');
    const index = {
      version: 1,
      lastCollectedAt: at,
      dataDate,
      dataMonth: data.month || new Date(at).toISOString().slice(0, 7),
      storeCount: (data.stores || []).length,
      okCount: (data.stores || []).filter((s) => !s.error).length,
      file: path.basename(snapshotFile),
      stores: (data.stores || []).map((s) => ({
        mallId: s.mallId,
        mallName: s.mallName,
        account: s.account || null,
        error: s.error || null,
        balance: s.balance ? {
          cash: s.balance.cash,
          cashAvailable: s.balance.cashAvailable,
          market: s.balance.market,
          deposit: s.balance.deposit,
        } : null,
      })),
    };
    fs.writeFileSync(path.join(FINANCE_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
    return { ok: true, file: snapshotFile, index };
  } catch (e) {
    trace('saveFinanceSnapshot FAIL: ' + ((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function readFinanceSnapshot() {
  try {
    const indexFile = path.join(FINANCE_DIR, 'index.json');
    if (!fs.existsSync(indexFile)) return { ok: false, error: '还没有资金快照' };
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const file = path.join(FINANCE_SNAPSHOT_DIR, index.file || '');
    if (!index.file || !fs.existsSync(file)) return { ok: false, index, error: '快照文件不存在' };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, index, data };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function log(level, msg) {
  // 用本地时间，和渲染层 toTimeString() 保持一致。
  // 之前这里用 toISOString()（UTC），同一条日志框里会跳 8 小时。
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const t = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  const line = { t, level, msg: String(msg) };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('log', line); } catch (_) { /* ignore */ }
  }
  trace('[' + level + '] ' + line.msg);
}

// ---------------------------------------------------------------- 店铺视图
// ---------------------------------------------------------------- 账单下载接管
// 对账中心的「下载账单」是 JS 触发的浏览器下载，没 href 可抓。
// 只能在 session 层接管 will-download，落盘到 app\userdata\bills\。
let lastBillDownload = null;

function attachDownloadHandler(sess) {
  try {
    sess.on('will-download', (event, item) => {
      try {
        const dir = path.join(DATA_DIR, 'bills');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const raw = String(item.getFilename() || 'bill.xlsx');
        const safe = raw.replace(/[\\\\/:*?"<>|]/g, '_');
        const full = path.join(dir, stamp + '-' + safe);
        item.setSavePath(full);
        item.once('done', (_e, state) => {
          if (state === 'completed') {
            let size = 0;
            try { size = fs.statSync(full).size; } catch (_) {}
            lastBillDownload = { path: full, name: safe, at: Date.now(), size };
            log('ok', '账单已下载: ' + safe + '（' + Math.round(size / 1024) + ' KB）');
            if (mainWindow && !mainWindow.isDestroyed()) {
              try { mainWindow.webContents.send('bill:downloaded', lastBillDownload); } catch (_) {}
            }
          } else {
            log('err', '账单下载失败: ' + state);
          }
        });
      } catch (e) { trace('download handler error: ' + e.message); }
    });
  } catch (e) { trace('attach download fail: ' + e.message); }
}

function createMall(name, forcedId) {
  const id = forcedId || ('mall_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
  const partition = 'persist:' + id;

  const sess = session.fromPartition(partition);
  sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  attachDownloadHandler(sess);
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
  try { view.webContents.setZoomFactor(MALL_ZOOM); } catch (_) { /* ignore */ }

  view.webContents.on('did-finish-load', () => {
    // 不同子域（mms / cashier）会重置 zoom，每次加载完成都重新压回 80%
    try { view.webContents.setZoomFactor(MALL_ZOOM); } catch (_) { /* ignore */ }
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
  const target = (attachedId === '__collector__')
    ? (collectorView && !collectorView.webContents.isDestroyed() ? collectorView : null)
    : (malls.get(attachedId) || {}).view;
  if (target) {
    try { mainWindow.contentView.removeChildView(target); } catch (_) { /* ignore */ }
  }
  attachedId = null;
  // 视图摘掉后必须把键盘焦点交还 HTML 层，否则弹窗输入框打不进字
  focusMainWindow();
}

// ---------------------------------------------------------------- 采集会话
/**
 * 采集会话：独立 partition 的 WebContentsView，用来登录「买家账号」，
 * 打开别人的商品链接读取数据（消费者端商品页强制登录，实测 needLogin:true）。
 * 与商家店铺完全隔离：不同 partition、不同 cookie，互不影响登录态。
 */
const { COLLECTOR_READ_JS } = require('./lib/collector');

const COLLECTOR_PARTITION = 'persist:collector';
const COLLECTOR_HOME = 'https://mobile.yangkeduo.com/';
let collectorView = null;

function getCollector() {
  if (collectorView && !collectorView.webContents.isDestroyed()) return collectorView;

  const sess = session.fromPartition(COLLECTOR_PARTITION);
  sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));

  collectorView = new WebContentsView({
    webPreferences: {
      partition: COLLECTOR_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  /**
   * UA 必须用桌面 Chrome。
   *
   * 不能用 iPhone UA —— 实测：移动端 UA 会让拼多多判定你在手机浏览器里，
   * 直接跳到 down_download.html（App 下载引导页，页面显示「正在跳转...」永不结束）。
   * 桌面 UA 下手机站按正常响应式渲染，元素大小也正常。
   */
  try {
    collectorView.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
  } catch (_) { /* ignore */ }

  // 兜底：万一同一个 webContents 被跳到下载引导页，主动退回
  collectorView.webContents.on('will-navigate', (e, url) => {
    if (/down_download|app_download|market_download/i.test(url)) {
      e.preventDefault();
      log('warn', '[采集会话] 拦下一次 App 下载引导跳转，保持在当前页');
    }
  });

  collectorView.webContents.on('did-finish-load', () => {
    log('info', '[采集会话] 加载完成: ' + collectorView.webContents.getURL().slice(0, 90));
  });
  collectorView.webContents.on('did-navigate', (_e, url) => {
    log('info', '[采集会话] 导航: ' + String(url).slice(0, 110));
  });

  collectorView.webContents.loadURL(COLLECTOR_HOME);
  trace('collector view created');
  return collectorView;
}

/** 当前应该挂载哪个视图：'mall' 或 'collector' */
let viewKind = 'mall';

function activeView() {
  if (viewKind === 'collector') return getCollector();
  const m = currentMall();
  return m ? m.view : null;
}

function attachView() {
  if (!mainWindow) return;
  const v = activeView();
  if (!v || !viewVisible) {
    detachView();
    return;
  }
  const key = (viewKind === 'collector') ? '__collector__' : (currentMall() || {}).id;
  if (!key) { detachView(); return; }
  if (attachedId && attachedId !== key) detachView();
  if (attachedId !== key) {
    try { mainWindow.contentView.addChildView(v); } catch (_) { /* ignore */ }
    attachedId = key;
    trace('view attached ' + key);
  }
  applyBounds();
}

function applyBounds() {
  if (!attachedId || !mainWindow) return;
  const v = (attachedId === '__collector__')
    ? (collectorView && !collectorView.webContents.isDestroyed() ? collectorView : null)
    : (malls.get(attachedId) || {}).view;
  if (!v) return;
  try {
    v.setBounds({
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
    icon: path.join(__dirname, 'assets', 'icons', 'app-256.png'),
    // 隐藏系统标题栏，由 renderer 的 .topbar 兼任（消除白色横条 + 品牌重复）
    // 不使用 titleBarOverlay：窗口按钮由渲染层 .win-controls 自绘，避免原生 overlay 与 CSS 顶栏像素错位
    titleBarStyle: 'hidden',
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

/** 自绘窗口按钮（最小化/最大化/关闭） */
ipcMain.handle('window:action', (_e, action) => {
  if (!mainWindow) return false;
  try {
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') mainWindow.close();
    return true;
  } catch (_) { return false; }
});

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

ipcMain.handle('pool:collect', async (_e, { index, goodsId }) => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  const r = await runInMall((o) => o.collectGoods({ index, goodsId }));
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
/**
 * 从采集箱上架到指定店铺（跨店）—— 业务实现，IPC 与批量队列共用
 */
async function poolPublishImpl({ id, mallId, stock, factor, dryRun }) {
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
  //
  //    优先用缓存和采集时预分配好的结果：上架不该每次都现拉 listGoods（几秒到几十秒）。
  //    缓存过期（10 分钟）才回退到现场拉取。
  const planForThis = (it.skeletonPlans || []).find((p) => p.mallId === target.id) || null;
  let ls = null;
  const cachedGoods = skeleton.getCachedMallGoods(target.id);
  if (cachedGoods && cachedGoods.items.length) {
    ls = { ok: true, items: cachedGoods.items };
    steps.push('商品清单用缓存（' + cachedGoods.ageMin + ' 分钟前，' + cachedGoods.items.length + ' 条）');
  } else {
    ls = await runInMall((o) => o.listGoods(30));
    if (ls && ls.ok && Array.isArray(ls.items)) skeleton.cacheMallGoods(target.id, ls.items);
  }
  if (!ls || !ls.ok || !ls.items || !ls.items.length) {
    return { ok: false, error: '目标店铺没有在售商品，无法作为骨架', steps };
  }
  if (planForThis && planForThis.ready) {
    const usable = (planForThis.candidates || []).filter((c) => c.ready).length;
    steps.push('采集时已预分配骨架：' + usable + ' 个可用，首选 ' + planForThis.best);
  } else if (planForThis && !planForThis.ready) {
    steps.push('⚠ 采集时的预分配结论：' + (planForThis.advice || '骨架不可用，仍在重试'));
  }

  // 先把源的颜色算出来 —— 挑骨架时要看它有没有颜色规格
  const srcColors = [];
  {
    const seen = {};
    for (const s of (it.skus || [])) {
      for (const sp of (s.spec || [])) {
        if (!/颜色|色彩|color/i.test(sp.parent_name || '')) continue;
        if (!seen[sp.spec_name]) { seen[sp.spec_name] = 1; srcColors.push(sp.spec_name); }
      }
    }
  }

  // ② 骨架必须【同类目】—— 跨类目骨架的尺码表是另一套体系（鞋码 39-45 vs 服装 150/72A），
  //    硬套只会得到一条规格错乱的商品。宁可拒绝，不产废品。
  const srcCat = Number(it.catId) || null;
  let ranked = skeleton.rank(ls.items, srcCat);
  let cands = srcCat ? ranked.sameCat : ranked.otherCat;

  // 预分配结果给的「首选骨架」提到最前面，其余仍按 LRU 排
  if (planForThis && planForThis.best && cands.length) {
    const i = cands.findIndex((x) => String(x.goods_id) === String(planForThis.best));
    if (i > 0) cands = [cands[i]].concat(cands.slice(0, i), cands.slice(i + 1));
  }

  if (srcCat && !cands.length) {
    const catName = (it.catNames && it.catNames.length)
      ? it.catNames.join(' / ')
      : ('类目 ' + srcCat);
    return {
      ok: false,
      blocked: 'no-skeleton',
      error: '目标店铺还没有「' + catName + '」这个品类的商品，无法自动上架',
      advice: skeleton.diagnosis([], srcCat) +
              '\n每个品类第一次上架前，需要目标店先有一个同类商品当「骨架」：' +
              '手动发布一个「' + catName + '」商品（规格尽量填全，比如鞋就把 36~45 都加上），' +
              '上架后可立刻下架但别删除。之后这个品类的自动上架都会克隆它 —— 一个品类只需手动铺一次。',
      steps,
    };
  }
  if (srcCat) {
    steps.push('同品类骨架 ' + cands.length + ' 个（其中 ' +
               ranked.stats.neverUsed + ' 个从未用过），按最久未用优先');
  }

  // ③ 源有颜色 → 优先挑「自己就有颜色规格」的骨架
  //    原因：改颜色是在页面已有的颜色输入框里填值。骨架本身没有颜色规格时，
  //    页面上没有输入框可填，颜色必然设不进去（实测遇到：骨架 0 个颜色框，源 5 个颜色）。
  if (srcColors.length && cands.length > 1) {
    const withColors = cands.filter((x) => Number(x.colorCount || 0) > 0);
    if (withColors.length) {
      steps.push('源有 ' + srcColors.length + ' 个颜色 → 优先挑有颜色规格的骨架 ' +
                 withColors.length + ' 个');
      cands = withColors;
    } else {
      steps.push('⚠ 同品类骨架都没有颜色规格，颜色可能设不进去（谨慎重试）');
    }
  }
  steps.push('骨架候选: ' + cands.length + ' 个');

  let draft = null;
  let base = null;
  let lastErr = null;
  const tried = [];
  for (const cand of cands) {
    const cp = await runInMall((o) => o.copyGoods({
      index: cand.idx,
      goodsId: cand.goods_id,          // 按 goods_id 精确认商品，不用下标
      title: String(it.title || '').slice(0, 60),
      submit: false,
      allowSameStore: true,
    }));
    tried.push(cand);
    if (cp && cp.ok) {
      draft = cp.result;
      base = cand;
      skeleton.markUsed(cand.goods_id);       // 记账：下次优先用别的骨架
      break;
    }
    lastErr = cp && (cp.detail || cp.error);
    const em = errText(lastErr);
    steps.push('骨架 ' + String(cand.title || '').slice(0, 14) +
               ' 失败: ' + em.slice(0, 70) +
               (cand.lastUsedMin !== null ? '（' + cand.lastUsedMin + ' 分钟前用过）' : ''));
    await sleep(1200);
  }
  if (!draft) {
    const all600102 = /600102|已被新建过/.test(errText(lastErr));
    return {
      ok: false,
      failed: 'failed_known',
      error: all600102
        ? '目标店同品类骨架全部被频控拒绝（600102）'
        : '目标店铺没有可用的骨架商品',
      advice: skeleton.diagnosis(tried, srcCat),
      steps,
      detail: lastErr,
    };
  }
  steps.push('骨架商品: ' + String(base.title || '').slice(0, 18) + '（goods ' + base.goods_id + '）');
  steps.push('骨架草稿: commit=' + draft.commit_id + ' goods=' + draft.goods_id +
             '（' + draft.images + ' 图 / ' + draft.skus + ' SKU）');

  // ③ 打开编辑页，等「保存草稿」按钮就绪（后续要点它，不是回放载荷）
  const wc = target.view.webContents;
  const editUrl = 'https://mms.pinduoduo.com/goods/goods_add/index?id=' + draft.commit_id +
                  '&goods_id=' + draft.goods_id + '&type=edit';
  const opsMod = require('./lib/ops');
  const ready = await withPlatform('openEdit', async () => {
    const nav = await gotoUrl(wc, editUrl, 2000);
    if (!nav.ok && !nav.aborted) return { ok: false, error: nav.error };
    for (let i = 0; i < 70; i++) {
      try {
        if (await wc.executeJavaScript(opsMod.hasSaveButton(), true)) return { ok: true };
      } catch (_) { /* ignore */ }
      await sleep(500);
    }
    return { ok: false, error: '编辑页未就绪' };
  }, 90000);
  steps.push('编辑页: ' + (ready.ok ? '就绪' : '失败 ' + (ready.error || '')));
  if (!ready.ok) {
    return { ok: false, error: '打不开草稿编辑页：' + (ready.error || ''), steps, draft };
  }

  // ④ 滚到规格区并等渲染，然后读改前状态
  const sc = await withPlatform('scrollSpec',
    () => wc.executeJavaScript(opsMod.scrollToSpec(), true), 60000);
  steps.push('规格区: ' + (sc && sc.ok
    ? '已渲染（颜色框 ' + sc.colors + ' 个）'
    : '未渲染（滚动 ' + (sc && sc.scrolled ? '成功' : '失败') + '）'));

  const before = await withPlatform('readSpec',
    () => wc.executeJavaScript(opsMod.readSpecState(), true), 30000);
  steps.push('改前: 颜色 ' + ((before && before.colors) || []).length +
             ' 个 / 尺码选项 ' + ((before && before.sizeOptions) || []).length +
             ' 个 / SKU 行 ' + ((before && before.skuRows) || 0));

  // ⑤ 用 DOM 改颜色（页面会自己生成合法 spec_id）
  //    srcColors 已在挑骨架前算好
  if (srcColors.length) {
    const cr = await withPlatform('setColors',
      () => wc.executeJavaScript(opsMod.setColors(srcColors), true), 180000);
    steps.push('设颜色 需要: ' + JSON.stringify((cr && cr.want) || srcColors));
    steps.push('设颜色 实际: ' + JSON.stringify((cr && cr.got) || null));
    if (!cr || !cr.ok) {
      // 颜色没设对就绝不往下走 —— 否则会产出一条「颜色错」的商品
      return {
        ok: false,
        error: '颜色规格没设置成功，已停止（未提交）',
        failed: 'failed_known',
        advice: (cr && cr.error ? errText(cr.error) : '页面颜色与源不一致') +
                '\n草稿仍在目标店草稿箱：commit=' + draft.commit_id +
                ' goods=' + draft.goods_id + '（可手动删除后重试）',
        steps, draft,
      };
    }
  } else {
    steps.push('源商品没有颜色规格，跳过');
  }

  // ⑥ 用 DOM 勾尺码（先扫遍所有码制，挑覆盖率最高的）
  if ((it.sizes || []).length) {
    let systems = null;
    try {
      systems = await withPlatform('scanSizeSys',
        () => wc.executeJavaScript(opsMod.scanAllSizeSystems(), true), 180000);
    } catch (_) { /* ignore */ }

    const norm = (x) => String(x || '').replace(/[（(].*?[）)]/g, '')
      .replace(/[\u4e00-\u9fa5]/g, '').replace(/\s+/g, '').toUpperCase();
    const wantSet = new Set((it.sizes || []).map(norm).filter(Boolean));

    let bestSys = null, bestCover = -1, bestHave = [];
    if (systems && typeof systems === 'object') {
      for (const name of Object.keys(systems)) {
        const have = systems[name].map(norm).filter(Boolean);
        const cover = have.filter((x) => wantSet.has(x)).length;
        steps.push('  码制「' + name + '」覆盖 ' + cover + '/' + wantSet.size);
        if (cover > bestCover) { bestCover = cover; bestSys = name; bestHave = have; }
      }
    }

    if (bestSys) {
      const sw = await withPlatform('switchSize',
        () => wc.executeJavaScript(opsMod.switchSizeSystem(bestSys), true), 60000);
      steps.push('选用码制: ' + bestSys + '（覆盖 ' + bestCover + '/' + wantSet.size + '）');
      if (!sw || !sw.ok) steps.push('⚠ 切换码制失败');
    }

    const sr = await withPlatform('setSizes',
      () => wc.executeJavaScript(opsMod.setSizes(it.sizes), true), 240000);
    if (sr && sr.ok) {
      steps.push('设尺码: 勾上 ' + sr.turnedOn + ' / 取消 ' + sr.turnedOff);
    } else {
      const missing = (sr && sr.missing) || [];
      steps.push('⚠ 尺码缺 ' + missing.length + ' 个: ' + JSON.stringify(missing).slice(0, 120));
      if (bestHave.length) {
        steps.push('   该码制可用码: ' + bestHave.slice(0, 30).join(','));
      }
      // 尺码缺了就是残品，绝不提交
      return {
        ok: false,
        error: '尺码没配齐（缺 ' + missing.length + ' 个），已停止（未提交）',
        failed: 'failed_known',
        advice: '缺的码: ' + missing.join(',') + '。草稿在目标店草稿箱：commit=' +
                draft.commit_id + ' goods=' + draft.goods_id,
        steps, draft,
      };
    }
  }

  // ⑦ 读改后规格状态
  const after = await withPlatform('readSpec2',
    () => wc.executeJavaScript(opsMod.readSpecState(), true), 30000);
  steps.push('改后: 颜色 ' + ((after && after.colors) || []).length +
             ' 个 / SKU 行 ' + ((after && after.skuRows) || 0));

  // ⑧ 点页面「保存草稿」—— 这一步让页面把规格落库并生成 spec_id
  const saveClicked = await withPlatform('clickSave', async () => {
    const r = await wc.executeJavaScript(opsMod.clickSaveDraft(), true);
    await sleep(6000);
    return r;
  }, 60000);
  steps.push('点保存: ' + JSON.stringify(saveClicked).slice(0, 80));

  // 页面自己报错就停
  let pageErrs = [];
  try { pageErrs = await wc.executeJavaScript(opsMod.readPageErrors(), true) || []; } catch (_) {}
  if (pageErrs.length) steps.push('页面提示: ' + JSON.stringify(pageErrs.slice(0, 3)));

  // ⑨ 读新 commit。页面保存通常原地更新同一个草稿，URL 里的 id 可能没变、
  //    也可能变成别的草稿（实测遇到过跳到一个已失效的旧 id → 提交报 600001）。
  //    所以：默认沿用克隆得到的 commit，只有 URL 里的 id 能通过存在性校验时才采用。
  const pg = await runInMall((o) => o.readPageCommit());
  let useCommit = draft.commit_id;
  if (pg && pg.commitId && Number(pg.commitId) !== Number(draft.commit_id)) {
    const chk = await runInMall((o) => o.draftDetail(pg.commitId));
    if (chk && chk.ok) {
      useCommit = pg.commitId;
      steps.push('commit 变化: ' + draft.commit_id + ' → ' + useCommit + '（已校验存在）');
    } else {
      steps.push('页面 commit ' + pg.commitId + ' 无效，沿用 ' + draft.commit_id);
    }
  }

  let raw2 = null;
  try { raw2 = await captureEditBody(wc, useCommit, draft.goods_id); } catch (_) {}
  if (raw2) {
    let body;
    try { body = JSON.parse(raw2); } catch (e) { body = null; }
    if (body) {
      body.goods_name = String(it.title || '').slice(0, 60);
      const gal = (it.gallery || []).filter(Boolean);
      if (gal.length) body.galleries = gal.map((u) => ({ url: u, width: 800, height: 800, type: 2 }));

      // 详情页装修楼层整体替换（源商品的详情图在里面）。
      // floor_id 是平台给每层分配的，整段搬过来即可；只把内嵌的商品引用清掉，避免指向源商品。
      const dd = Array.isArray(it.decorationDetail) ? it.decorationDetail : [];
      if (dd.length) {
        const clone = JSON.parse(JSON.stringify(dd));
        let imgCount = 0;
        for (const fl of clone) {
          for (const c of (fl.content_list || [])) {
            if (c.goods_id) c.goods_id = null;
            if (c.img_url) imgCount++;
          }
        }
        body.decorationDetail = clone;
        steps.push('详情装修: ' + clone.length + ' 层 / ' + imgCount + ' 张图');
      } else {
        steps.push('详情装修: 源无 → 保留骨架的');
      }
      // 逐 SKU 价格映射：按「规格组合」把源 SKU 的价格搬到目标 SKU
      // 键 = parent_name:spec_name 的拼接（父规格组名 + 规格值名）
      const skuKey = (spec) => (spec || [])
        .map((x) => String(x.parent_name || '') + ':' + String(x.spec_name || ''))
        .join('|');
      const srcMap = new Map();
      for (const s of (it.skus || [])) srcMap.set(skuKey(s.spec), s);

      const priceFactor = Number(factor) > 0 ? Number(factor) : 1;
      let mapped = 0, fallback = 0;
      for (const s of (body.skus || [])) {
        const src = srcMap.get(skuKey(s.spec));
        if (src && Number(src.group) > 0) {
          const g = Math.round(Number(src.group) * priceFactor);
          const single = Math.round(Math.max(Number(src.single) || 0, g + 100) * priceFactor);
          s.multi_price = g;
          s.price = Math.max(single, g + 100);
          mapped++;
        } else if (it.price) {
          s.multi_price = Math.round(Number(it.price) * priceFactor);
          s.price = Math.max(Math.round((Number(it.price) + 100) * priceFactor), s.multi_price + 100);
          fallback++;
        } else {
          continue;
        }
        s.multi_price_in_yuan = (s.multi_price / 100).toFixed(2);
        s.price_in_yuan = (s.price / 100).toFixed(2);
      }
      if (mapped || fallback) {
        steps.push('价格映射: 逐 SKU ' + mapped + ' 个' +
                   (fallback ? '，兜底 ' + fallback + ' 个' : '') +
                   (priceFactor !== 1 ? '（×' + priceFactor + '）' : ''));
      }
      // 参考价必须【严格大于】所有 SKU 的单买价，否则报 1000161
      const maxSingle = Math.max.apply(null, (body.skus || []).map((s) => Number(s.price) || 0));
      if (maxSingle > 0) {
        body.market_price = Math.max(maxSingle + 100, Number(body.market_price) || 0);
        body.market_price_in_yuan = (body.market_price / 100).toFixed(2);
      }
      if (stock) for (const s of (body.skus || [])) s.quantity_delta = Number(stock);

      // 页面新生成的 SKU 没有缩略图，平台会报「请上传规格缩略图」。
      // 统一用主图第一张兜底（源商品本来也是这么用的）。
      const fallbackThumb = (it.gallery || []).filter(Boolean)[0] || it.thumb || '';
      let thumbFilled = 0;
      if (fallbackThumb) {
        for (const s of (body.skus || [])) {
          if (!s.thumb_url) { s.thumb_url = fallbackThumb; thumbFilled++; }
        }
      }
      if (thumbFilled) steps.push('补 SKU 缩略图: ' + thumbFilled + ' 个');

      /**
       * 尺码表处理。
       * 实测结论：这个类目（登山鞋 11985）不强制要尺码表 —— 源商品 size_spec_id 为空也能在售。
       * 而骨架多半继承了一张旧尺码表，改过尺码集合后那张表就对不上了，
       * 提交时会报 10000014「尺码表参数或组别不能为空」。
       * 所以：源没有尺码表 → 把继承来的清掉（置 0）。
       *       源有尺码表   → 沿用源的引用（同品类才可能有效）。
       */
      if (!it.sizeSpecId) {
        body.size_spec_id = 0;
        body.size_parent_spec_id = 0;
        body.is_size_spec_sync_detail = 0;
        steps.push('尺码表: 源无 → 清空继承的引用');
      } else {
        body.size_spec_id = Number(it.sizeSpecId);
        body.size_parent_spec_id = Number(it.sizeParentSpecId) || body.size_parent_spec_id || 0;
        body.is_size_spec_sync_detail = 1;
        steps.push('尺码表: 沿用源 ' + it.sizeSpecId);
      }

      // 抓载荷那一步已经点过一次保存，紧接着再存会被频控（2000000），先等一会儿
      await sleep(12000);
      const sv = await runInMall((o) => o.applyEditBody(JSON.stringify(body), useCommit));
      const saveOk = !!(sv && sv.save && sv.save.ok);
      steps.push('覆盖标题/图/价格: ' + (saveOk ? 'ok' : JSON.stringify(sv && sv.save).slice(0, 120)));
      if (!saveOk) {
        return {
          ok: false,
          error: '最终保存失败，已停止（未提交）',
          failed: 'failed_unknown',
          advice: '草稿在目标店草稿箱：commit=' + useCommit + ' goods=' + draft.goods_id,
          steps, draft,
        };
      }
      steps.push('最终 SKU 数: ' + (body.skus || []).length);
    } else {
      steps.push('⚠ 没解析到最终载荷，标题/价格未覆盖（规格已保存）');
    }
  } else {
    steps.push('⚠ 没抓到最终载荷（' + (lastCaptureError || '') + '），标题/价格未覆盖');
  }

  await sleep(1500);

  // dryRun：把草稿填好就停，不提交。
  // 用途：验收时先确认标题/图/价格/规格都对，再决定要不要真上架。
  // 不传这个参数时行为完全不变（照旧提交）。
  if (dryRun) {
    steps.push('dryRun：已停在提交前，草稿在目标店草稿箱');
    return {
      ok: true,
      dryRun: true,
      steps,
      result: {
        goods_id: draft.goods_id,
        commit_id: useCommit,
        title: it.title,
        from: it.sourceMallName,
        to: target.name,
        skus: (body && body.skus) ? body.skus.length : null,
        galleries: (body && body.galleries) ? body.galleries.length : null,
        groupPrice: body ? body.group_price : null,
        marketPrice: body ? body.market_price : null,
      },
    };
  }

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
}

ipcMain.handle('pool:publish', (_e, args) => poolPublishImpl(args || {}));

// ---------------------------------------------------------------- 商品检测 + 主图水印
const inspect = require('./lib/inspect');
const imgtool = require('./lib/imgtool');

/** 检测单个采集箱条目。withImages=true 时额外下载主图做图像层检测（慢，几十秒）。 */
ipcMain.handle('inspect:item', async (_e, { id, withImages, ocr }) => {
  const it = pool.get(id);
  if (!it) return { ok: false, error: '采集箱里没有这一条' };

  let imageReport = null;
  let imageErrors = [];
  if (withImages) {
    const urls = (it.gallery || []).slice(0, 10);
    if (urls.length) {
      const tmp = path.join(DATA_DIR, 'imgtmp', id);
      const r = await imgtool.inspectUrls(urls, tmp, { ocr: !!ocr });
      if (r && r.ok) {
        imageReport = r;
        imageErrors = r.errors || [];
      } else {
        imageErrors.push((r && r.error) || '图像检测失败');
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }

  const res = inspect.inspectItem(it, { imageReport });
  return {
    ok: true,
    id, title: it.title,
    score: res.score, level: res.level,
    issues: res.issues,
    summary: res.summary,
    images: imageReport ? imageReport.images : null,
    imageErrors,
  };
});

/** 批量检测（不含图像层，纯规则，秒级） */
ipcMain.handle('inspect:pool', (_e) => {
  const items = pool.list().map((x) => pool.get(x.id)).filter(Boolean);
  const r = inspect.inspectMany(items);
  return { ok: true, ...r };
});

/** 对采集箱条目的主图加水印，输出到本地目录 */
ipcMain.handle('img:watermark', async (_e, args) => {
  const a = args || {};
  const it = pool.get(a.id);
  if (!it) return { ok: false, error: '采集箱里没有这一条' };
  const urls = (it.gallery || []).filter(Boolean);
  if (!urls.length) return { ok: false, error: '这条没有主图' };

  const useAll = a.all !== false;          // 默认全部主图
  const picked = useAll ? urls : urls.slice(0, Number(a.limit) || 5);
  const outDir = path.join(DATA_DIR, 'watermarked', a.id + '_' + Date.now());

  const r = await imgtool.watermarkUrls(picked, {
    text: a.text,
    mode: a.mode || 'corner',
    pos: a.pos || 'br',
    where: a.where || 'bottom',
    opacity: a.opacity,
    sizeRatio: a.sizeRatio,
    outDir,
    namePrefix: 'wm',
    timeoutMs: 90000,
  });
  if (!r || !r.ok) {
    return {
      ok: false,
      failed: (r && r.failed) || 'failed_known',
      error: (r && r.error) || '水印失败',
      errors: (r && r.errors) || [],
    };
  }
  log('ok', '水印完成 ' + r.count + '/' + r.total + ' 张 → ' + outDir);
  return { ok: true, count: r.count, total: r.total, outDir, files: r.files, errors: r.errors };
});

/** 用系统文件管理器打开目录（让用户直接看到成品） */
ipcMain.handle('shell:openPath', (_e, p) => {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, error: '路径不存在' };
    shell.openPath(p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 从启动参数里取调试端口（restart-app.ps1 传 --remote-debugging-port=N） */
function debugPort() {
  const a = process.argv.find((x) => /^--remote-debugging-port=/.test(x));
  const n = a ? Number(a.split('=')[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}
/**
 * 把本地文件塞进页面的 <input type="file">。
 *
 * 为什么最终用 Playwright 而不是自己拼 CDP：
 *
 * 实测了三种做法，都在同一个干净页面、同一批图（6 张有效 JPEG）上对比：
 *   ① CDP `DOM.setFileInputFiles`                → 上传计数始终 (0/10)
 *   ② 页面里 DataTransfer + new File + 派发事件  → 赋值成功（el.files.length=6），计数仍 (0/10)
 *   ③ Playwright `locator.setInputFiles(路径)`   → 计数变成 (6/10)，并真的发出了
 *      file.pinduoduo.com 的上传请求
 *
 * ② 的 File 对象尺寸/类型都正确，说明不是文件问题；差别在于 Playwright 派发事件的方式
 * （composed: true 等细节）以及它自己定位元素的方式。继续猜不如直接用能跑通的那个。
 *
 * 依赖说明：playwright-core 是纯 JS，不需要编译器，也不会下载浏览器
 * （用 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 安装）；这里只用 connectOverCDP 连本应用自己的调试端口。
 */
async function setFileInputFiles(wc, selector, filePaths) {
  const sel = selector || 'input[type=file]';
  const files = (Array.isArray(filePaths) ? filePaths : []).filter((p) => p && fs.existsSync(p));
  if (!files.length) return { ok: false, error: '没有可用的本地文件' };

  const port = debugPort();
  if (!port) {
    return { ok: false, error: '应用启动时没开调试端口（--remote-debugging-port），无法自动上传图片' };
  }
  let chromium;
  try {
    // Playwright 连上后会在系统临时目录里建 playwright-artifacts-* ，
    // 但本环境下 %TEMP% 不可写（EPERM，和当年 %APPDATA% 是同一类问题）。
    // Node 的 os.tmpdir() 读的是这几个环境变量，指到应用自己的数据目录即可。
    const tmp = path.join(DATA_DIR, 'tmp');
    try { fs.mkdirSync(tmp, { recursive: true }); } catch (_) { /* ignore */ }
    process.env.TEMP = tmp;
    process.env.TMP = tmp;
    process.env.TMPDIR = tmp;

    chromium = require('playwright-core').chromium;
  } catch (e) {
    return { ok: false, error: '没装 playwright-core，无法自动上传图片' };
  }

  // 给目标 webContents 打一个唯一标记，用来在 Playwright 里认出是哪一个页面
  // （两个店铺视图可能同时停在同一个 URL，只靠 URL 会认错）
  const marker = 'up_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try {
    await wc.executeJavaScript('window.__pddUpMarker = ' + JSON.stringify(marker) + '; 1', true);
  } catch (e) {
    return { ok: false, error: '标记目标页面失败：' + ((e && e.message) || e) };
  }

  let browser = null;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port);

    let target = null;
    for (const c of browser.contexts()) {
      for (const p of c.pages()) {
        try {
          const hit = await p.evaluate((m) => window.__pddUpMarker === m, marker);
          if (hit) { target = p; break; }
        } catch (_) { /* 跨域页面 evaluate 会抛，忽略 */ }
      }
      if (target) break;
    }
    if (!target) return { ok: false, error: '在 Playwright 里找不到对应的页面' };

    // 等控件可交互（页面刚渲染完时 file input 可能还没挂上）
    const loc = target.locator(sel).first();
    await loc.waitFor({ state: 'attached', timeout: 20000 });
    await loc.setInputFiles(files, { timeout: 40000 });

    // 清掉标记
    try { await target.evaluate(() => { try { delete window.__pddUpMarker; } catch (e) {} }); } catch (_) {}

    return { ok: true, count: files.length, via: 'playwright', files: files.map((p) => path.basename(p)) };
  } catch (e) {
    return { ok: false, error: '上传失败：' + ((e && e.message) || e) };
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* 只是断开连接，不关应用 */ } }
  }
}

/** 调试用：在当前店铺视图的主 frame 里执行任意 JS。
 *
 * 为什么需要：外部 CDP 的 Runtime.evaluate 有时会落到和 executeJavaScript 不同的
 * 执行上下文（拼多多页面里有 iframe），导致"看到的内容"和"生产代码看到的内容"
 * 不一致 —— 排查时会得出完全错误的结论。这个接口走的是与 runInMall 完全相同的
 * executeJavaScript 通道，保证上下文一致。
 *
 * 只在调试时用，不参与业务逻辑。
 */
ipcMain.handle('debug:eval', async (_e, { code, timeoutMs }) => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'code 为空' };
  const wc = m.view.webContents;
  return withPlatform('debugEval', async () => {
    const v = await wc.executeJavaScript(code, true);
    return { ok: true, value: v };
  }, timeoutMs || 60000);
});

// ---------------------------------------------------------------- 图片上传（空白新建用）
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
  viewKind = on ? 'collector' : 'mall';
  if (on) getCollector();
  detachView();
  attachView();
  return { ok: true, kind: viewKind };
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

/**
 * 骨架预分配：采集完就把「这个商品能上架到哪些店、用哪个骨架」算出来。
 *
 * 为什么提前算：上架时才找骨架有两个问题 ——
 *   ① 批量跑到第 N 个才炸，前面白做；
 *   ② 每次都要现拉 listGoods（几秒到几十秒）。
 *
 * 类目从哪来（重要）：
 *   App 端拿不到类目，类目只有网页端给。但网页登录和模拟器登录会互相踢（同一账号）。
 *   所以对「自己店铺之间搬家」这类场景，走一条更稳的路：
 *   源商品就在自己店里 → 用源店的商品清单反查 cat_id。
 *   查不到才退回用采集时记下的 catId。
 */
async function preassignSkeletons(poolId, catIdHint, colorCountHint) {
  const it = poolId ? pool.get(poolId) : null;
  if (!it) return { ok: false, error: '找不到这条采集箱条目' };

  let catId = Number(catIdHint) || Number(it.catId) || null;
  let catFrom = catId ? '采集时记录' : null;

  // 从源店反查类目 —— 自己店之间搬家时最可靠
  if (!catId && it.sourceMallId && it.sourceGoodsId) {
    try {
      const srcMall = malls.get(it.sourceMallId);
      if (srcMall) {
        let cached = skeleton.getCachedMallGoods(it.sourceMallId);
        if (!cached) {
          const prev = activeId;
          activeId = it.sourceMallId;
          attachView();
          await sleep(1800);
          const ls = await runInMall((o) => o.listGoods(50));
          if (ls && ls.ok && Array.isArray(ls.items)) skeleton.cacheMallGoods(it.sourceMallId, ls.items);
          if (prev && prev !== it.sourceMallId) { activeId = prev; attachView(); }
          cached = skeleton.getCachedMallGoods(it.sourceMallId);
        }
        const hit = cached && cached.items.find((x) => String(x.goods_id) === String(it.sourceGoodsId));
        if (hit && Number(hit.cat_id)) { catId = Number(hit.cat_id); catFrom = '从源店商品反查'; }
      }
    } catch (e) {
      log('warn', '反查源商品类目失败：' + errText(e));
    }
  }

  if (!catId) {
    const why = '这条商品没有类目信息（App 端不提供类目，网页端没登上）。' +
                '先在「采集会话」里登录网页版拼多多重采一次，或换一个自己的店之间搬家的商品';
    pool.update(poolId, { skeletonPlans: null, skeletonReady: false, skeletonAdvice: why });
    return { ok: false, error: why, plans: [] };
  }

  if (catFrom) log('info', '骨架预分配用类目 ' + catId + '（' + catFrom + '）');

  const colorCount = Number(colorCountHint) || (it.colors || []).length || 0;
  const plans = [];
  for (const m of malls.values()) {
    let p = null;
    try {
      let cached = skeleton.getCachedMallGoods(m.id);
      if (!cached && m.view && !m.view.webContents.isDestroyed()) {
        const prevActive = activeId;
        activeId = m.id;
        attachView();
        await sleep(1800);
        const ls = await runInMall((o) => o.listGoods(30));
        if (ls && ls.ok && Array.isArray(ls.items)) skeleton.cacheMallGoods(m.id, ls.items);
        if (prevActive && prevActive !== m.id) { activeId = prevActive; attachView(); }
      }
      p = skeleton.plan(m.id, catId, { colorCount });
      p.mallName = m.name;
    } catch (e) {
      p = {
        mallId: m.id, mallName: m.name, catId,
        ready: false, count: 0, candidates: [], best: null, allCooling: false,
        advice: '预分配失败：' + errText(e),
      };
    }
    plans.push(p);
  }

  const readyCount = plans.filter((x) => x.ready).length;
  pool.update(poolId, {
    catId,
    colors: (it.colors && it.colors.length) ? it.colors : (colorCount ? it.colors : it.colors),
    skeletonPlans: plans,
    skeletonReady: readyCount > 0,
    skeletonReadyCount: readyCount,
    skeletonPlannedAt: Date.now(),
    skeletonCatFrom: catFrom,
  });

  log(readyCount ? 'ok' : 'warn',
      '骨架预分配：' + readyCount + '/' + plans.length + ' 个店铺可上架（类目 ' + catId + '，' + catFrom + '）');
  return { ok: true, plans, readyCount, catId, catFrom };
}

ipcMain.handle('skeleton:preassign', async (_e, { poolId } = {}) => {
  if (!poolId) return { ok: false, error: '缺少 poolId' };
  return preassignSkeletons(poolId);
});

/** 只读查询：某个类目在某个店能不能上架（不刷新缓存） */
ipcMain.handle('skeleton:plan', async (_e, { mallId, catId, colorCount } = {}) => {
  const id = mallId || activeId;
  if (!id) return { ok: false, error: '没有指定店铺' };
  return { ok: true, plan: skeleton.plan(id, catId, { colorCount: Number(colorCount) || 0 }) };
});

/**
 * 把外部链接采集到的商品存进采集箱。
 * sourceMallId 用 '__external__' 标记，跨店上架时不会被误判为"同店"。
 */
ipcMain.handle('pool:addExternal', async (_e, pack) => {
  if (!pack || !pack.title) return { ok: false, error: '没有商品数据' };

  // 补充价格：若只有总价没有 SKU，用最低价兜底
  const skus = Array.isArray(pack.skus) ? pack.skus : [];
  const prices = skus.map((s) => Number(s.group) || 0).filter((n) => n > 0);
  const price = Number(pack.price) || (prices.length ? Math.min.apply(null, prices) : 0);

  const id = pool.add({
    title: String(pack.title).slice(0, 60),
    thumb: (pack.gallery || [])[0] || null,
    gallery: pack.gallery || [],
    price,
    marketPrice: Number(pack.marketPrice) || (price ? Math.round(price * 1.1) : 0),
    catId: Number(pack.catId) || null,
    catNames: pack.catNames || [],
    colors: pack.colors || [],
    property: pack.property || [],
    skus,
    sizes: pack.sizes || [],
    sizeSpecId: null,
    sizeParentSpecId: null,
    costTemplateId: null,
    shipmentLimitSecond: null,
    twoPiecesDiscount: 95,
    sourceGoodsId: null,
    sourceCommitId: null,
    sourceMallId: '__external__',
    sourceMallName: '外部链接',
    sourceUrl: pack.url || null,
  });
  log('ok', '已采集外部商品：' + String(pack.title).slice(0, 20) +
            '（' + (pack.gallery || []).length + ' 图 / ' + skus.length + ' SKU）');

  // 采集完立刻预分配骨架：把「能上架到哪些店、用哪个骨架」算好存进条目。
  // 失败不影响采集结果，只是这条暂时显示「未分配」。
  let skel = null;
  try {
    skel = await preassignSkeletons(id);
  } catch (e) {
    log('warn', '骨架预分配失败（不影响采集）：' + errText(e));
  }
  return { ok: true, id, skeleton: skel };
});

// ---------------------------------------------------------------- 草稿清理
/**
 * 列出当前店铺的草稿。
 * 为什么做成正式能力：跨店上架失败会留下草稿（实测积累到 34 条），
 * 手动去后台一条条删非常烦。而且草稿堆多了会干扰后续判断（哪个是有效的）。
 */
ipcMain.handle('drafts:list', async (_e, { mallId } = {}) => {
  const m = mallId ? malls.get(mallId) : currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  if (mallId) { activeId = mallId; attachView(); await sleep(2200); }
  const r = await runInMall((o) => o.listDrafts(100, 0));
  return Object.assign({ mallId: m.id, mallName: m.name }, r || { ok: false });
});

/** 删除草稿。ids: [{commit_id, goods_id}] */
ipcMain.handle('drafts:delete', async (_e, { ids }) => {
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return { ok: false, error: '没有要删的草稿' };
  const results = [];
  for (const it of list) {
    const r = await runInMall((o) => o.deleteDraft(it.commit_id, it.goods_id));
    const ok = !!(r && r.ok && (r.detail === true || r.detail === 'true' || typeof r.detail === 'boolean'));
    results.push({ commit_id: it.commit_id, goods_id: it.goods_id, ok,
                   error: ok ? null : JSON.stringify((r && r.detail) || r) });
    await sleep(700);   // 别打太密
  }
  const done = results.filter((x) => x.ok).length;
  log(done ? 'ok' : 'err', '删除草稿 ' + done + '/' + list.length);
  return { ok: done > 0, done, total: list.length, results };
});

// 初始化采集箱存储
try { pool.init(DATA_DIR); } catch (e) { trace('pool init fail: ' + e.message); }

// ---------------------------------------------------------------- 批量队列
const batch = require('./lib/batch');
try { batch.init(DATA_DIR); } catch (e) { trace('batch init fail: ' + e.message); }

// 骨架使用记账（跨店上架时按最久未用优先挑骨架）
const skeleton = require('./lib/skeleton');
try { skeleton.init(DATA_DIR); } catch (e) { trace('skeleton init fail: ' + e.message); }

let batchStopRequested = false;
let batchRunning = false;

function emitBatch(extra) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('batch', Object.assign({
      running: batchRunning,
      stats: batch.stats(),
      items: batch.getItems(),
    }, extra || {}));
  } catch (_) { /* ignore */ }
}

function randBetween(a, b) {
  const lo = Math.max(0, Number(a) || 0);
  const hi = Math.max(lo, Number(b) || lo);
  return Math.round(lo + Math.random() * (hi - lo));
}

/** 失败分类（AGENTS.md §5） */
function classifyBatchResult(r) {
  if (r && r.ok) return { state: 'done' };
  if (r && r.failed === 'failed_unknown') {
    return { state: 'failed_unknown', errorMsg: String(r.error || '状态未知') };
  }
  const det = (r && r.detail) || {};
  const code = det.error_code || det.errorCode || null;
  const msg = det.error_msg || det.errorMsg || (r && r.error) || (r && r.blocked) || '未知';
  return { state: 'failed_known', errorCode: code, errorMsg: String(msg).slice(0, 160) };
}

async function runBatchLoop(opts) {
  const o = Object.assign({ stock: 50, factor: 1, intervalMin: 15, intervalMax: 25, maxAttempts: 2 }, opts || {});
  batchRunning = true;
  batchStopRequested = false;
  batch.setRunning(true);
  emitBatch({ phase: 'start' });
  log('info', '批量开始：' + JSON.stringify(batch.stats()));

  const todo = batch.getRunnable(o.maxAttempts);
  for (let k = 0; k < todo.length; k++) {
    if (batchStopRequested) {
      log('warn', '批量被手动停止');
      break;
    }
    const { index, item } = todo[k];
    batch.update(index, {
      state: 'running', attempts: (item.attempts || 0) + 1,
      startedAt: new Date().toISOString(), errorCode: null, errorMsg: null,
    });
    log('info', '[' + (k + 1) + '/' + todo.length + '] ' + String(item.title || '').slice(0, 20) + ' ...');
    emitBatch({ phase: 'item-start', index });

    let r;
    try {
      r = await poolPublishImpl({ id: item.poolId, mallId: item.mallId, stock: o.stock, factor: o.factor });
    } catch (e) {
      // 异常 = 状态未知，绝不重试
      r = { ok: false, failed: 'failed_unknown', error: String((e && e.message) || e) };
    }

    const cls = classifyBatchResult(r);
    batch.update(index, Object.assign({
      state: cls.state,
      errorCode: cls.errorCode || null,
      errorMsg: cls.errorMsg || null,
      goodsId: (r && r.result && r.result.goods_id) || null,
      commitId: (r && r.result && r.result.commit_id) || null,
      endedAt: new Date().toISOString(),
    }, {}));

    log(cls.state === 'done' ? 'ok' : 'err',
        '[' + (k + 1) + '/' + todo.length + '] ' + cls.state +
        (cls.errorMsg ? '：' + cls.errorMsg : ''));
    emitBatch({ phase: 'item-end', index });

    if (k < todo.length - 1 && !batchStopRequested) {
      const gap = randBetween(o.intervalMin * 1000, o.intervalMax * 1000);
      log('info', '等 ' + Math.round(gap / 1000) + ' 秒再跑下一个 ...');
      const step = 1000;
      let waited = 0;
      while (waited < gap && !batchStopRequested) {
        await sleep(Math.min(step, gap - waited));
        waited += step;
      }
    }
  }

  batchRunning = false;
  batch.setRunning(false);
  emitBatch({ phase: 'end' });
  log('info', '批量结束：' + JSON.stringify(batch.stats()));
}

// ---------------------------------------------------------------- 资金限制（独立采集）
/**
 * 单独采集资金限制列表。
 * 为什么不塞进 finance:collect：采集结束时视图停在 cashier 域，
 * 从 cashier 跨回 mms 域的 loadURL 常常不生效（实测日志里完全没触发导航）。
 * 独立入口可以先把视图放回 mms 域再导航，成功率高得多。
 */
ipcMain.handle('finance:restrictions', async () => {
  const list = Array.from(malls.values());
  if (!list.length) return { ok: false, error: '还没有店铺' };
  const out = [];
  for (const mall of list) {
    const rec = { mallId: mall.id, mallName: mall.name, items: [], error: null };
    try {
      activeId = mall.id;
      attachView();
      await sleep(1200);

      const ok = await withPlatform('restrictNav', async () => {
        const wc = mall.view.webContents;
        // 若已经在 mms 域，直接去限制页；否则先回 mms 首页
        let cur = '';
        try { cur = wc.getURL() || ''; } catch (_) {}
        if (cur.indexOf('mms.pinduoduo.com') < 0) {
          try { await wc.loadURL('https://mms.pinduoduo.com/home/'); } catch (_) {}
          await sleep(3000);
        }
        try { await wc.loadURL('https://mms.pinduoduo.com/pg/restrict_list'); } catch (_) {}
        for (let i = 0; i < 40; i++) {
          await sleep(500);
          let u = '';
          try { u = wc.getURL() || ''; } catch (_) {}
          if (u.indexOf('restrict_list') >= 0) { await sleep(2000); return true; }
        }
        return false;
      }, 70000);

      if (!ok) {
        rec.error = '打不开资金限制页';
      } else {
        const rr = await runInMallView(mall, cashierOps.readRestrictions(), 45000);
        if (rr && rr.ok) rec.items = rr.items || [];
        else rec.error = (rr && rr.error) || '读取失败';
      }
    } catch (e) {
      rec.error = String((e && e.message) || e);
    }
    out.push(rec);
    await sleep(800);
  }
  const total = out.reduce((s, x) => s + (x.items ? x.items.length : 0), 0);
  return { ok: true, stores: out, total };
});

ipcMain.handle('batch:start', async (_e, { ids, options }) => {
  if (batchRunning) return { ok: false, error: '已有批量任务在跑' };
  if (!Array.isArray(ids) || !ids.length) return { ok: false, error: '没有选中商品' };
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };

  const items = [];
  for (const id of ids) {
    const it = pool.get(id);
    if (it) items.push({ poolId: it.id, title: it.title, mallId: m.id });
  }
  if (!items.length) return { ok: false, error: '采集箱里找不到这些商品' };

  batch.create(items);
  // 不 await —— 立刻返回，让界面能收进度
  runBatchLoop(options).catch((e) => {
    log('err', '批量异常终止: ' + ((e && e.message) || e));
    batchRunning = false;
    batch.setRunning(false);
    emitBatch({ phase: 'error', error: String((e && e.message) || e) });
  });
  return { ok: true, count: items.length };
});

ipcMain.handle('batch:stop', () => {
  batchStopRequested = true;
  return { ok: true, stopping: true };
});

ipcMain.handle('batch:list', () => ({
  running: batchRunning,
  stats: batch.stats(),
  items: batch.getItems(),
  createdAt: batch.list().createdAt,
}));

ipcMain.handle('batch:clear', () => {
  if (batchRunning) return { ok: false, error: '正在跑，不能清空' };
  batch.clear();
  return { ok: true };
});

ipcMain.handle('batch:retryKnown', () => {
  if (batchRunning) return { ok: false, error: '正在跑，不能重试' };
  batch.resetFailedKnown();
  return { ok: true };
});

// ---------------------------------------------------------------- 账单下载查询
ipcMain.handle('bill:lastDownload', () => lastBillDownload);
ipcMain.handle('bill:openFolder', () => {
  try {
    const dir = path.join(DATA_DIR, 'bills');
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------------------------------------------------------------- 资金复盘
const cashierOps = require('./lib/cashier');

/** 在指定店铺视图上执行一段注入脚本 */
async function runInWebContents(wc, js, timeoutMs) {
  return withPlatform('cashier', async () => {
    const deadline = Date.now() + (timeoutMs || 30000);
    while (Date.now() < deadline) {
      try {
        const r = await wc.executeJavaScript(js, true);
        if (r && r.__blocked) { await sleep(800); continue; }
        return r;
      } catch (e) {
        await sleep(600);
      }
    }
    return { ok: false, error: '页面未就绪' };
  }, (timeoutMs || 30000) + 10000);
}

async function runInMallView(mall, js, timeoutMs) {
  return runInWebContents(mall.view.webContents, js, timeoutMs);
}

/** 资金采集专用隐藏窗口：与店铺共享 partition，但不碰用户当前页面 */
function createHiddenMallWindow(mall) {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    skipTaskbar: true,
    webPreferences: {
      partition: mall.partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  try {
    const ua = win.webContents.getUserAgent().replace(/\sElectron\/[\d.]+/i, '');
    win.webContents.setUserAgent(ua);
    win.webContents.setAudioMuted(true);
  } catch (_) { /* ignore */ }
  return win;
}

/** 把某个 webContents 导航到 cashier 的资金中心（走 mms 的 ticket 跳转） */
async function gotoCashierFinance(wc) {
  const r = await withPlatform('gotoCashier', async () => {
    try {
      await wc.loadURL('https://mms.pinduoduo.com/cashier/finance/balance');
    } catch (e) { /* 跳转中断是常态 */ }
    for (let i = 0; i < 40; i++) {
      await sleep(700);
      let u = '';
      try { u = wc.getURL() || ''; } catch (_) { u = ''; }
      if (u.indexOf('cashier.pinduoduo.com') >= 0) return { ok: true, url: u };
    }
    let u = '';
    try { u = wc.getURL() || ''; } catch (_) {}
    return { ok: false, url: u };
  }, 60000);
  return r;
}

async function gotoCashierBills(wc) {
  return withPlatform('gotoBills', async () => {
    try { await wc.loadURL('https://cashier.pinduoduo.com/main/bills?__app_code=113'); } catch (_) {}
    for (let i = 0; i < 30; i++) {
      await sleep(600);
      let u = '';
      try { u = wc.getURL() || ''; } catch (_) {}
      if (u.indexOf('/main/bills') >= 0) { await sleep(1500); return { ok: true }; }
    }
    return { ok: false };
  }, 50000);
}

ipcMain.handle('finance:collect', async (_e, opts) => {
  const o = Object.assign({ withDetail: false, maxPages: 20 }, opts || {});
  const list = Array.from(malls.values());
  if (!list.length) return { ok: false, error: '还没有店铺' };

  const results = [];
  for (const mall of list) {
    const item = { mallId: mall.id, mallName: mall.name };
    let temp = null;
    try {
      // 用独立隐藏窗口采集，不劫持用户当前商品编辑页（布丁2 的 goods_add beforeunload 会拦截 loadURL）
      temp = createHiddenMallWindow(mall);
      const wc = temp.webContents;
      await sleep(500);

      // ① 资金中心 → 读余额和账号
      const nav = await gotoCashierFinance(wc);
      if (!nav.ok) {
        item.error = '打不开资金中心（' + (nav.url || '超时') + '）';
        results.push(item);
        continue;
      }
      const acc = await runInWebContents(wc, cashierOps.readAccount(), 20000);
      item.account = (acc && acc.account) || null;
      const bal = await runInWebContents(wc, cashierOps.readBalance(), 20000);
      item.balance = bal && bal.ok ? bal : null;
      // 账号名兜底：从余额页原文里再抠一次（readAccount 有时赶在渲染前）
      if (!item.account && bal && bal._raw) {
        const m2 = String(bal._raw).match(/返回商家后台\s*(\S+)\s*退出/);
        if (m2) item.account = m2[1];
      }


      // ③ 对账中心 → 月汇总
      const b2 = await gotoCashierBills(wc);
      if (!b2.ok) {
        item.error = '打不开对账中心';
        results.push(item);
        continue;
      }
      const mon = await runInWebContents(wc, cashierOps.readMonthSummary(), 40000);
      if (mon && mon.ok) item.months = mon.months;

      // ④ 可选：读货款明细（分类要用）+ 日汇总逐日（余额权威来源）
      if (o.withDetail) {
        // ④a 先切「日汇总」，设最近 30 天范围（明细页/日汇总页共用同一个日期筛选）
        const dt = await runInWebContents(wc, cashierOps.clickDailyTab(), 30000);
        if (dt && dt.ok) {
          const rg = await runInWebContents(wc, cashierOps.setRange30d(), 20000);
          const ds = await runInWebContents(wc, cashierOps.readDailySummary(), 20000);
          if (ds && ds.ok && ds.days && ds.days.length) item.daily = ds.days;
        }

        // ④b 切「货款明细」逐页读（分类明细，按入账时间归到对应日）
        const tab = await runInWebContents(wc, cashierOps.clickDetailTab(), 30000);
        if (tab && tab.ok) {
          const all = [];
          for (let p = 0; p < o.maxPages; p++) {
            const pg = await runInWebContents(wc, cashierOps.readDetailPage(), 25000);
            if (!pg || !pg.ok) break;
            if (!pg.rows || !pg.rows.length) break;
            all.push.apply(all, pg.rows);
            if (pg.total && all.length >= pg.total) break;
            const nx = await runInWebContents(wc, cashierOps.clickNextPage(), 15000);
            if (!nx || !nx.ok) break;
            await sleep(1800);
          }
          item.detail = all;

          // 按入账时间（天）+ 业务描述 code 归组：日账单分类明细
          const byDay = {};
          for (const row of all) {
            const day = (row.time || '').slice(0, 10);
            if (!day) continue;
            if (!byDay[day]) byDay[day] = { date: day, rows: [] };
            const desc = row.desc || '';
            const code = (desc.split('|')[0] || '').trim();
            const cat = cashierOps.catOf(code);
            byDay[day].rows.push({
              time: row.time, orderSn: row.orderSn,
              code, label: cat.label, group: cat.group, color: cat.color,
              bizType: row.bizType, amount: row.amount, remark: row.remark, desc,
            });
          }
          // 把 ④a 的日汇总余额合并进来（明细没有余额列，期末余额唯一来源）
          if (item.daily) {
            for (const d of item.daily) {
              if (byDay[d.date]) byDay[d.date].beginBalance = d.beginBalance;
              if (byDay[d.date]) byDay[d.date].endBalance = d.endBalance;
            }
          }
          item.days = Object.keys(byDay).sort().map(k => byDay[k]);
        }
      }
    } catch (e) {
      item.error = String((e && e.message) || e);
    } finally {
      if (temp) {
        try { if (!temp.isDestroyed()) temp.destroy(); } catch (_) { /* ignore */ }
      }
    }
    results.push(item);
    await sleep(300);
  }

  // 汇总
  const curMonth = new Date().toISOString().slice(0, 7);
  const agg = { income: 0, expense: 0, profit: 0, stores: results.length, months: {} };
  for (const r of results) {
    if (!r.months) continue;
    for (const m of r.months) {
      const k = m.month;
      if (!agg.months[k]) agg.months[k] = { month: k, income: 0, expense: 0, profit: 0 };
      agg.months[k].income += m.income || 0;
      agg.months[k].expense += m.expense || 0;
      agg.months[k].profit += m.profit || 0;
    }
    const cm = r.months.find((m) => m.month === curMonth);
    if (cm) {
      agg.income += cm.income || 0;
      agg.expense += cm.expense || 0;
      agg.profit += cm.profit || 0;
    }
  }

  const result = { ok: true, at: Date.now(), month: curMonth, aggregate: agg, stores: results };
  const saved = saveFinanceSnapshot(result);
  result.snapshot = saved.ok ? saved.index : null;
  if (!saved.ok) result.snapshotError = saved.error || '快照保存失败';
  return result;
});

/** 读取上次保存的资金快照（应用重启后仍可展示） */
ipcMain.handle('finance:last', () => readFinanceSnapshot());

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
  if (!raw) {
    return { ok: false, error: '没抓到草稿保存载荷：' + (lastCaptureError || '未知原因'), steps };
  }

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
 * 导航到 url，容忍 ERR_ABORTED。
 * 同一个 webContents 连续 loadURL 时，前一次会被打断并抛 ERR_ABORTED (-3)，
 * 但页面往往已经落到目标地址 —— 这种情况不应该让整个流程失败。
 */
async function gotoUrl(wc, url, settleMs) {
  try {
    await wc.loadURL(url);
    return { ok: true, aborted: false };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/ERR_ABORTED|ERR_FAILED\s*\(-3\)|-3\)\s*loading/i.test(msg)) {
      await sleep(settleMs || 1500);
      let cur = '';
      try { cur = wc.getURL() || ''; } catch (_) { /* ignore */ }
      if (cur.indexOf('goods_add') >= 0) {
        return { ok: true, aborted: true, url: cur };
      }
      return { ok: false, aborted: true, url: cur, error: msg.slice(0, 160) };
    }
    return { ok: false, aborted: false, error: msg.slice(0, 160) };
  }
}

/**
 * 抓编辑页「保存草稿」的 action/edit 请求体（用主进程 webContents.debugger）。
 * 走平台锁：debugger 不能两处同时 attach。
 *
 * ⚠️ 返回值必须是 string | null。withPlatform 在异常时返回 {ok:false,error,...}，
 * 如果直接透传，调用方会把错误对象当载荷字符串用（raw.length → undefined，
 * JSON.parse(对象) → 「载荷解析失败」），真实原因被吞掉。
 */
let lastCaptureError = null;
async function captureEditBody(wc, commit, goods) {
  lastCaptureError = null;
  const r = await withPlatform('captureEditBody',
                               () => captureEditBodyInner(wc, commit, goods), 120000);
  if (typeof r === 'string' && r.length) return r;
  if (r && r.error) lastCaptureError = String(r.error);
  else if (r === null || r === undefined) lastCaptureError = '没有收到 action/edit 请求';
  return null;
}

async function saveDraftAndResolveInner(wc, commit, goods, stock) {
  const ops = require('./lib/ops');
  const steps = [];
  const url = 'https://mms.pinduoduo.com/goods/goods_add/index?id=' + commit +
              '&goods_id=' + goods + '&type=edit';
  const nav = await gotoUrl(wc, url, 1800);
  if (!nav.ok && !nav.aborted) {
    steps.push('导航失败: ' + (nav.error || ''));
  } else if (nav.aborted) {
    steps.push('导航被打断但页面已在编辑页，继续');
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
// ---------------------------------------------------------------- 网络抓包（调试用）
/**
 * 主进程侧网络抓包。外部 CDP 在 WebContentsView 上抓不到 Network 事件，
 * 但主进程的 webContents.debugger 可以（captureEditBody 用的就是它）。
 * 用法：netStart → 在渲染层点按钮 → netStop 取记录。
 */
let netSession = null;

ipcMain.handle('debug:netStart', async () => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  if (netSession) { try { netSession.dbg.removeListener('message', netSession.onMsg); } catch (_) {} }

  const dbg = m.view.webContents.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
  } catch (e) {
    return { ok: false, error: '调试器附加失败: ' + e.message };
  }

  const records = [];
  const onMsg = (_evt, method, params) => {
    if (method !== 'Network.requestWillBeSent') return;
    const req = (params && params.request) || {};
    const url = req.url || '';
    if (url.indexOf('pinduoduo.com') < 0) return;
    records.push({
      url: url.split('?')[0].replace('https://mms.pinduoduo.com', ''),
      fullUrl: url,
      query: url.indexOf('?') >= 0 ? url.split('?')[1].slice(0, 200) : '',
      method: req.method,
      headers: req.headers || null,
      body: req.postData || null,
      ts: Date.now(),
    });
  };
  dbg.on('message', onMsg);

  try {
    await dbg.sendCommand('Network.enable', { maxTotalBufferSize: 300 * 1024 * 1024 });
  } catch (e) {
    try { dbg.removeListener('message', onMsg); } catch (_) {}
    return { ok: false, error: 'Network.enable 失败: ' + e.message };
  }

  netSession = { dbg, onMsg, records, attached };
  return { ok: true, started: true };
});

ipcMain.handle('debug:netStop', async () => {
  if (!netSession) return { ok: true, records: [] };
  const { dbg, onMsg, records, attached } = netSession;
  netSession = null;
  try { dbg.removeListener('message', onMsg); } catch (_) {}
  try { await dbg.sendCommand('Network.disable'); } catch (_) {}
  if (attached) { try { dbg.detach(); } catch (_) {} }
  return { ok: true, count: records.length, records };
});

/** 通用 MMS 接口调用（调试/维护用）
 *  在店铺视图里用页面自己的 __mms.fetch.sync 发请求，与页面同指纹。
 *  path 例：'/glide/v2/mms/edit/commit/delete'
 */
ipcMain.handle('debug:mmsCall', async (_e, { path: apiPath, body }) => {
  if (!apiPath || typeof apiPath !== 'string' || apiPath[0] !== '/') {
    return { ok: false, error: 'path 必须以 / 开头' };
  }
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  const payload = body && typeof body === 'object' ? body : {};
  const js = `(() => {
    const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
    if (typeof mms !== 'function') return JSON.stringify({ __blocked: true, error: '页面未就绪' });
    try {
      const r = mms('POST', location.origin + ${JSON.stringify(apiPath)}, ${JSON.stringify(payload)});
      return JSON.stringify({ ok: true, data: (r && r.result !== undefined) ? r.result : r });
    } catch (e) {
      const o = {};
      for (const k of ['error_msg', 'error_code', 'errorMsg', 'message', 'success']) {
        if (e && e[k] !== undefined) o[k] = e[k];
      }
      return JSON.stringify({ ok: false, error: Object.keys(o).length ? o : String(e).slice(0, 200) });
    }
  })()`;
  return withPlatform('mmsCall', async () => {
    const wc = m.view.webContents;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const raw = await wc.executeJavaScript(js, true);
        if (raw && raw.__blocked) { await sleep(1000); continue; }
        try { return JSON.parse(raw); } catch (_) { return { ok: false, error: String(raw).slice(0, 200) }; }
      } catch (e) {
        await sleep(800);
      }
    }
    return { ok: false, error: '页面未就绪' };
  }, 30000);
});

/** 抓取某个草稿的保存载荷（调试用，返回原始 JSON 字符串） */
ipcMain.handle('debug:captureEdit', async (_e, { commit, goods }) => {
  const m = currentMall();
  if (!m) return { ok: false, error: '还没有店铺' };
  const raw = await captureEditBody(m.view.webContents, Number(commit), Number(goods));
  if (!raw) return { ok: false, error: lastCaptureError || '没抓到' };
  return { ok: true, size: raw.length, body: raw };
});

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
    const nav = await gotoUrl(wc, url, 2000);
    if (!nav.ok) {
      log('err', '编辑页导航失败: ' + (nav.error || ''));
      return null;
    }
    // 必须确认落在【这一条】草稿上。ERR_ABORTED 容忍逻辑只看了「在 goods_add」，
    // 如果页面还停在别的草稿上，会把别人的载荷当成本条的（实测踩过）。
    let nowUrl = '';
    for (let i = 0; i < 20; i++) {
      try { nowUrl = wc.getURL() || ''; } catch (_) { nowUrl = ''; }
      if (nowUrl.indexOf('id=' + commit) >= 0 && nowUrl.indexOf('goods_id=' + goods) >= 0) break;
      await sleep(500);
    }
    if (nowUrl.indexOf('id=' + commit) < 0 || nowUrl.indexOf('goods_id=' + goods) < 0) {
      log('err', '导航后页面不是目标草稿（期望 commit=' + commit + ' goods=' + goods +
                 '，实际 ' + nowUrl.slice(0, 120) + '）');
      return null;
    }
    if (nav.aborted) log('warn', '导航被打断但页面已在目标草稿，继续');
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

/**
 * 把任意异常转成可读文本。
 *
 * 为什么需要：Electron 的 executeJavaScript 在页面抛出非 Error 值时，
 * reject 出来的就是一个普通对象。直接 String(e) 会得到 "[object Object]"，
 * 真实原因全丢（这个坑已经在 captureEditBody 上踩过一次）。
 */
function errText(e) {
  if (e === null || e === undefined) return '未知错误';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === 'object') {
    if (typeof e.error === 'string') return e.error;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.reason === 'string') return e.reason;
    try {
      const s = JSON.stringify(e);
      if (s && s !== '{}') return s;
    } catch (_) { /* ignore */ }
    return Object.prototype.toString.call(e);
  }
  return String(e);
}

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
      const msg = errText(e);
      log('err', '平台操作失败[' + label + ']: ' + msg.slice(0, 200));
      return { ok: false, error: msg.slice(0, 400), unknown: true, label };
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
  // 采集会话（买家账号）也必须 flush，否则退出后登录态丢失，网页补图会全部失败
  try {
    await session.fromPartition(COLLECTOR_PARTITION).flushStorageData();
    trace('flushed ' + COLLECTOR_PARTITION);
  } catch (e) {
    trace('flush fail ' + COLLECTOR_PARTITION + ': ' + e.message);
  }
  try { await session.defaultSession.flushStorageData(); } catch (_) { /* ignore */ }
  trace('flush done, quitting');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
