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
async function poolPublishImpl({ id, mallId, stock, factor }) {
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
  // ② 骨架必须【同类目】—— 跨类目骨架的尺码表是另一套体系（鞋码 39-45 vs 服装 150/72A），
  //    硬套只会得到一条规格错乱的商品。宁可拒绝，不产废品。
  const srcCat = Number(it.catId) || null;
  let cands = ls.items.slice();
  if (srcCat) {
    cands = cands.filter((x) => Number(x.cat_id) === srcCat);
    if (!cands.length) {
      return {
        ok: false,
        error: '目标店铺没有同品类商品可作骨架',
        advice: '目标店需要一个和源商品同类的商品（源类目 ' + srcCat + '）。' +
                '跨类目的规格体系完全不同（鞋码 vs 服装码），套不过去。' +
                '办法：先在目标店手动上架一个同类商品当骨架，再回来跑。',
        steps,
      };
    }
  }
  steps.push('同品类骨架候选: ' + cands.length + ' 个');

  let draft = null;
  let base = null;
  let lastErr = null;
  for (const cand of cands) {
    const cp = await runInMall((o) => o.copyGoods({
      index: cand.idx,
      goodsId: cand.goods_id,          // 按 goods_id 精确认商品，不用下标
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
  const srcColors = [];
  {
    const seen = {};
    for (const s of (it.skus || [])) {
      for (const sp of (s.spec || [])) {
        if (!/颜色|color/i.test(sp.parent_name || '')) continue;
        if (!seen[sp.spec_name]) { seen[sp.spec_name] = 1; srcColors.push(sp.spec_name); }
      }
    }
  }
  if (srcColors.length) {
    const cr = await withPlatform('setColors',
      () => wc.executeJavaScript(opsMod.setColors(srcColors), true), 180000);
    steps.push('设颜色: ' + JSON.stringify((cr && cr.got) || cr).slice(0, 160));
    if (!cr || !cr.ok) {
      // 颜色没设对就绝不往下走 —— 否则会产出一条「颜色错」的商品
      return {
        ok: false,
        error: '颜色规格没设置成功，已停止（未提交）',
        failed: 'failed_known',
        advice: (cr && cr.error) || '页面颜色与源不一致。草稿在目标店草稿箱：commit=' +
                draft.commit_id + ' goods=' + draft.goods_id,
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

// 初始化采集箱存储
try { pool.init(DATA_DIR); } catch (e) { trace('pool init fail: ' + e.message); }

// ---------------------------------------------------------------- 批量队列
const batch = require('./lib/batch');
try { batch.init(DATA_DIR); } catch (e) { trace('batch init fail: ' + e.message); }

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
      query: url.indexOf('?') >= 0 ? url.split('?')[1].slice(0, 200) : '',
      method: req.method,
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
    if (nav.aborted) log('warn', '导航被打断但页面已在编辑页，继续');
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
