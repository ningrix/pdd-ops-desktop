'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/**
 * 只保留「当前还在店铺列表里」的店铺数据。
 *
 * 资金快照、订单快照、售后分诊都是落盘的，里面可能留着已经移除的店铺
 * （例如布丁2）。不移除的话，移除店铺后资金页仍会显示它的行和错误，
 * 用户会以为那个店还在被访问。
 */
function keepActiveStores(stores) {
  const ids = new Set((state.malls || []).map((m) => m.id));
  if (!ids.size) return stores || [];
  return (stores || []).filter((s) => !s || !s.mallId || ids.has(s.mallId));
}

// 打单中心直接落到「打单发货 · 待发货」列表；回店铺后台时切回首页。
const PRINT_LIST_URL = 'https://mms.pinduoduo.com/print/order/list';
const MMS_HOME_URL = 'https://mms.pinduoduo.com/home/';

const state = {
  malls: [],
  activeId: null,
  visible: true,
  tab: 'goods',
  // 视图当前停在哪个 URL。店铺后台与打单中心共用一个 WebContentsView，
  // 靠这个值判断切页签时要不要重新导航。
  viewUrl: null,
  goods: [],
  pool: [],
  poolSel: new Set(),
  last: null,
  sizeTpl: null,
  costs: [],
  productCosts: [],
  returnsMall: '',
  financeLastAt: 0,
  feeSettings: { platformRate: 0.006, promotionPerOrder: 0, shippingPerOrder: 0, packagingPerOrder: 0 },
  orderShowAll: false,
  returnsLimit: 0,   // 0 = 用默认页长；点「再显示」每次 +30
  appealScenes: [],
  appealTemplates: [],
  rtTab: 'list',
  triage: null,
  riskData: null,
  // 店铺在线状态缓存：id -> { online: true|false|null, reason, at, checking }
  // 列表重绘时先按缓存画，避免每次 refreshMalls 都把灯闪回灰色
  mallStatus: new Map(),
};

// ------------------------------------------------------------------ 日志
function updateLogMeta() {
  const box = $('#log');
  const count = $('#logCount');
  if (count && box) count.textContent = box.children.length ? box.children.length + ' 条' : '';
}
function addLog(line) {
  const box = $('#log');
  const el = document.createElement('div');
  el.className = 'ln ' + (line.level || 'info');
  el.innerHTML = '<span class="t"></span><span class="m"></span>';
  el.querySelector('.t').textContent = line.t || new Date().toTimeString().slice(0, 8);
  el.querySelector('.m').textContent = line.msg || '';
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 500) box.removeChild(box.firstChild);
  updateLogMeta();
  const panel = $('#logPanel');
  const badge = $('#logBadge');
  const logVisible = panel && panel.classList.contains('open') && $('#drawerLog') && $('#drawerLog').style.display !== 'none';
  if (badge && !logVisible) {
    const n = (parseInt(badge.textContent, 10) || 0) + 1;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = 'inline-block';
  }
}
const logOk = (m) => addLog({ level: 'ok', msg: m });
const logErr = (m) => addLog({ level: 'err', msg: m });
const logInfo = (m) => addLog({ level: 'info', msg: m });
const logWarn = (m) => addLog({ level: 'warn', msg: m });

function switchDrawer(kind) {
  $$('.drawer-tab').forEach((t) => t.classList.toggle('active', t.dataset.drawer === kind));
  const logBody = $('#drawerLog');
  const resultBody = $('#drawerResult');
  if (logBody) logBody.style.display = kind === 'log' ? 'flex' : 'none';
  if (resultBody) resultBody.style.display = kind === 'result' ? 'flex' : 'none';
  const count = $('#logCount');
  if (count) count.style.display = kind === 'log' ? '' : 'none';
  if (kind === 'log') {
    const box = $('#log');
    if (box) box.scrollTop = box.scrollHeight;
  }
}
function setDrawer(kind, open) {
  const panel = $('#logPanel');
  if (!panel) return;
  panel.classList.toggle('open', !!open);
  if (open) {
    switchDrawer(kind || 'log');
    if ((kind || 'log') === 'log') {
      const badge = $('#logBadge');
      if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
    }
  }
}
$('#btnLogToggle').addEventListener('click', () => {
  const panel = $('#logPanel');
  const isOpenLog = panel.classList.contains('open') && $('#drawerLog').style.display !== 'none';
  setDrawer('log', !isOpenLog);
});
$('#btnResultToggle').addEventListener('click', () => {
  const panel = $('#logPanel');
  const isOpenResult = panel.classList.contains('open') && $('#drawerResult').style.display !== 'none';
  setDrawer('result', !isOpenResult);
});
$$('.drawer-tab').forEach((t) => t.addEventListener('click', () => switchDrawer(t.dataset.drawer)));
$('#btnLogClose').addEventListener('click', () => setDrawer('log', false));

window.pdd.onLog((l) => addLog(l));
$('#btnClearLog').addEventListener('click', () => {
  $('#log').innerHTML = '';
  const badge = $('#logBadge');
  if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
  updateLogMeta();
});

const money = (fen) => (fen === undefined || fen === null ? '-' : (Number(fen) / 100).toFixed(2));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ 原生视图遮挡
// 原生 WebContentsView 一旦被点过就会持有原生键盘焦点。摘掉它之后主窗口
// 不会自动拿回焦点，表现是弹窗里 input 是 activeElement 但打不进字。
// 所以每次摘视图后都要显式 focusWindow()。
async function withViewHidden(fn) {
  let suspended = false;
  if (state.visible && state.malls.length) {
    try { await window.pdd.toggleView(false); suspended = true; } catch (_) { /* ignore */ }
  }
  try { await window.pdd.focusWindow(); } catch (_) { /* ignore */ }
  try {
    return await fn();
  } finally {
    if (suspended) {
      try { await window.pdd.toggleView(true); } catch (_) { /* ignore */ }
      scheduleSync();
    }
  }
}

/** 把焦点稳稳地打到某个输入框上：等两帧 + 重试，避免撑开后才布局完 */
function focusInput(el, selectAll) {
  if (!el) return;
  let tries = 0;
  const tick = () => {
    tries++;
    try {
      window.pdd.focusWindow();
      el.focus({ preventScroll: false });
      if (selectAll) el.select();
    } catch (_) { /* ignore */ }
    if (document.activeElement !== el && tries < 8) {
      requestAnimationFrame(() => setTimeout(tick, 40));
    }
  };
  requestAnimationFrame(() => setTimeout(tick, 30));
}

let rafPending = false;
function syncBounds() {
  // 采集会话不需要店铺，所以单独判断
  if (!state.visible) {
    window.pdd.toggleView(false);
    return;
  }
  let el = null;
  if ((state.tab === 'browser' || state.tab === 'print') && state.malls.length) {
    el = state.tab === 'print' ? ($('#pane-print') || $('#pane-browser')) : $('#pane-browser');
  } else if (state.tab === 'collect') {
    // 采集页的浏览器默认收起；只有点了「买家账号登录」才显示
    const cv = $('#collectView');
    if (cv && cv.style.display !== 'none') el = cv;
  }
  if (!el) {
    window.pdd.toggleView(false);
    return;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) {
    window.pdd.toggleView(false);
    return;
  }
  window.pdd.toggleView(true);
  window.pdd.setBounds({
    x: Math.round(r.left), y: Math.round(r.top),
    width: Math.round(r.width), height: Math.round(r.height),
  });
}
function scheduleSync() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; syncBounds(); });
}
window.addEventListener('resize', scheduleSync);

function setTab(name) {
  // 「原始结果」不再是独立页签，收进左下角抽屉里
  if (name === 'result') { setDrawer('result', true); return; }
  const prev = state.tab;
  state.tab = name;
  $$('[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
  const pb = $('#pane-browser');
  const pp = $('#pane-print');
  if (pb) pb.classList.toggle('browser-on', name === 'browser' && !!state.malls.length);
  if (pp) pp.classList.toggle('browser-on', name === 'print' && !!state.malls.length);
  // 打单中心：进页签就把当前店铺视图切到「打单发货 · 待发货」
  // 回店铺后台时切回首页，避免用户以为后台变成了打单页
  if (name === 'print' && state.malls.length && state.viewUrl !== PRINT_LIST_URL) {
    state.viewUrl = PRINT_LIST_URL;
    window.pdd.navigate(PRINT_LIST_URL).catch(() => {});
  } else if (name === 'browser' && prev === 'print' && state.viewUrl === PRINT_LIST_URL) {
    state.viewUrl = MMS_HOME_URL;
    window.pdd.navigate(MMS_HOME_URL).catch(() => {});
  }
  // 切换采集会话 / 店铺后台 视图
  if (name === 'collect') {
    window.pdd.collectorShow(true).catch(() => {});
  } else if (prev === 'collect') {
    window.pdd.collectorShow(false).catch(() => {});
  }
  scheduleSync();
  if (name === 'collect') setTimeout(scheduleSync, 300);
  // 离开售后页时把「再显示」的展开状态收回第一页：
  // 展开到 60 单时该 pane 有 1382 个节点（预算 1200），而且离开后留着也没人看。
  if (prev === 'returns' && name !== 'returns' && (state.returnsLimit || 0) > 30) {
    state.returnsLimit = 0;
    if (state.returns) renderReturns(state.returns);
  }
  if (name === 'finance') setTimeout(maybeAutoCollectFinance, 800);
  if (name === 'returns') setTimeout(() => {
    // 切页签时把滚动位置归零，否则表头会停在视野外
    const fb = document.querySelector('#pane-returns .fin-body');
    if (fb) fb.scrollTop = 0;
    loadReturns();
  }, 120);
}
$$('[data-tab]').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

function setResult(obj) {
  $('#resultBox').textContent = JSON.stringify(obj, null, 2);
}

// ------------------------------------------------------------------ 采集会话
function initCollector() {
  const input = $('#collectInput');
  const btn = $('#btnCollectApp');
  const status = $('#collectStatus');
  const result = $('#collectResult');
  const needLogin = $('#btnNeedLogin');
  const view = $('#collectView');
  if (!input || !btn) return;

  const setStatus = (t, cls) => {
    if (!status) return;
    status.textContent = t;
    status.className = 'cc-status' + (cls ? ' ' + cls : '');
  };

  const yen = (f) => (f ? '¥' + (f / 100).toFixed(2) : '—');
  const tags = (arr) => (arr || []).map((x) => '<span class="cc-tag">' + esc(x) + '</span>').join('');

  const run = async () => {
    const target = (input.value || '').trim();
    if (!target) { setStatus('先粘贴一个商品链接，或填商品ID', 'err'); input.focus(); return; }

    btn.disabled = true;
    btn.textContent = '采集中';
    result.innerHTML = '';
    setStatus('正在打开商品并读取…约 40 秒，别关窗口');
    logInfo('开始采集：' + target);

    try {
      const r = await window.pdd.collectFull(target, false);

      if (!r || !r.ok) {
        const msg = (r && r.error) || '采集失败';
        setStatus(msg, 'err');
        result.innerHTML = '<div style="color:#6b7a90">检查：模拟器是否在运行、拼多多是否登录、链接是否有效</div>';
        logErr('采集失败：' + msg);
        return;
      }

      const d = r.data;

      // 存进采集箱
      const pack = {
        title: d.title,
        url: d.url,
        gallery: d.gallery || [],
        price: d.price,
        marketPrice: d.marketPrice,
        catNames: d.catNames || [],
        catId: d.catId || null,
        property: d.property || [],
        skus: [],
        sizes: d.sizes || [],
        colors: d.colors || [],
      };
      const add = await window.pdd.poolAddExternal(pack);

      setStatus(add && add.ok
        ? '已存入采集箱 · ' + (d.gallery || []).length + ' 张图 · ' + (d.colors || []).length + ' 色 × ' + (d.sizes || []).length + ' 码'
        : '采集到了，但入库失败：' + ((add && add.error) || '未知'),
        add && add.ok ? 'ok' : 'err');

      const thumbs = (d.gallery || []).slice(0, 6)
        .map((u) => '<img src="' + esc(u) + '" loading="lazy" />').join('');

      result.innerHTML =
        '<div class="cc-name">' + esc(d.title || '(无标题)') + '</div>' +
        '<div>' +
          '<span class="cc-price">' + yen(d.price) + '</span>' +
          (d.marketPrice ? '<span class="cc-old">' + yen(d.marketPrice) + '</span>' : '') +
          (d.sold ? '<span style="color:#6b7a90;margin-left:10px">' + esc(d.sold) + '</span>' : '') +
          (d.mallName ? '<span style="color:#6b7a90;margin-left:10px">' + esc(d.mallName) + '</span>' : '') +
        '</div>' +
        (d.colors && d.colors.length ? '<div style="margin-top:6px"><span style="color:#6b7a90">颜色 </span>' + tags(d.colors) + '</div>' : '') +
        (d.sizes && d.sizes.length ? '<div style="margin-top:2px"><span style="color:#6b7a90">尺码 </span>' + tags(d.sizes) + '</div>' : '') +
        (thumbs ? '<div class="cc-thumbs">' + thumbs + '</div>' : '') +
        (d.notes && d.notes.length
          ? '<div style="margin-top:8px;color:#5c6a7e;font-size:11.5px">' + d.notes.map(esc).join('；') + '</div>'
          : '');

      logOk('采集成功：' + String(d.title || '').slice(0, 22) +
            '（' + (d.gallery || []).length + ' 图）');
      if (add && add.ok) refreshPool();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setStatus('采集异常：' + msg, 'err');
      logErr('采集异常：' + msg);
    } finally {
      btn.disabled = false;
      btn.textContent = '采集';
    }
  };

  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  // 买家账号登录：需要时才把浏览器露出来
  if (needLogin && view) {
    needLogin.addEventListener('click', () => {
      const hidden = view.style.display === 'none';
      view.style.display = hidden ? 'block' : 'none';
      needLogin.textContent = hidden ? '收起浏览器' : '买家账号登录 / 换账号';
      if (hidden) {
        setStatus('在下方浏览器里用手机号登录一次买家账号，登录后才能抓到主图');
        window.pdd.collectorShow(true).catch(() => {});
      } else {
        window.pdd.collectorShow(false).catch(() => {});
      }
      scheduleSync();
      setTimeout(scheduleSync, 300);
    });
  }
}
// ------------------------------------------------------------------ 输入弹窗
function askText({ title = '输入', placeholder = '', value = '' } = {}) {
  return withViewHidden(() => new Promise((resolve) => {
    const mask = $('#modalMask');
    const input = $('#modalInput');
    const err = $('#modalErr');
    $('#modalTitle').textContent = title;
    input.placeholder = placeholder;
    input.value = value;
    err.textContent = '';
    mask.classList.add('on');
    focusInput(input, true);

    const done = (v) => {
      mask.classList.remove('on');
      $('#modalOk').onclick = null;
      $('#modalCancel').onclick = null;
      input.onkeydown = null;
      resolve(v);
    };
    $('#modalOk').onclick = () => {
      const v = input.value.trim();
      if (!v) { err.textContent = '不能为空'; return; }
      done(v);
    };
    $('#modalCancel').onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); $('#modalOk').click(); }
      if (e.key === 'Escape') done(null);
    };
  }));
}

// ------------------------------------------------------------------ 拿货成本录入

// ------------------------------------------------------------------ 店铺
async function refreshMalls(selectId) {
  const res = await window.pdd.listMalls();
  state.malls = res.malls || [];
  state.activeId = selectId || res.activeId || (state.malls[0] && state.malls[0].id) || null;

  const ul = $('#mallList');
  ul.innerHTML = '';
  // 已经删掉的店铺，状态缓存一起清掉
  for (const id of [...state.mallStatus.keys()]) {
    if (!state.malls.some((m) => m.id === id)) state.mallStatus.delete(id);
  }
  if (!state.malls.length) {
    ul.innerHTML = '<li class="empty">还没有店铺，点右上「＋ 添加店铺」</li>';
  } else {
    for (const m of state.malls) {
      const li = document.createElement('li');
      li.className = m.id === state.activeId ? 'active' : '';
      li.dataset.id = m.id;
      li.innerHTML = '<span class="st unknown" title="未检测"></span>' +
                     '<span class="nm"></span>' +
                     '<span class="del" title="移除">✕</span>';
      li.querySelector('.nm').textContent = m.name;
      li.addEventListener('click', async (e) => {
        if (e.target.classList.contains('del')) {
          if (!window.confirm(
            '移除店铺「' + m.name + '」？\n\n' +
            '⚠️ 这会同时删除它的登录状态，下次要重新扫码。\n' +
            '只想重新登录的话不用删，直接点该店铺再扫码即可。')) return;
          await window.pdd.removeMall(m.id);
          await refreshMalls();
          return;
        }
        await window.pdd.activateMall(m.id);
        state.activeId = m.id;
        await refreshMalls(m.id);
        refreshStatus();
      });
      ul.appendChild(li);
      paintMallStatus(m.id);
    }
  }
  const pb = $('#pane-browser');
  if (pb) pb.classList.toggle('browser-on', state.tab === 'browser' && !!state.malls.length);
  const pp = $('#pane-print');
  if (pp) pp.classList.toggle('browser-on', state.tab === 'print' && !!state.malls.length);
  // 店铺增减后，落盘的快照里可能还留着已移除店铺的行，重绘一次让过滤生效
  if (state.finance) renderFinance(state.finance);
  if (state.orderData) renderOrderContribution(state.orderData);
  if (state.returns) renderReturns(state.returns);
  if (state.triage) renderTriage(state.triage);
  scheduleSync();
  scheduleStatus(60);
}

// ------------------------------------------------------------------ 店铺在线指示灯
// 旧实现：串行 await + 单店无 try/catch。只要有一个店铺在改价/加载，
// ping 抛错就会中断整轮，后面的灯永远停在灰色；而且 refreshMalls 重绘
// 列表会把所有灯重置成 unknown，看起来就是「指示灯坏了」。
// 现在：所有店铺并发检测，单店失败不影响其他店，结果写进缓存并带时间戳。
function paintMallStatus(id) {
  const dot = document.querySelector('#mallList li[data-id="' + id + '"] .st');
  if (!dot) return;
  const s = state.mallStatus.get(id) || { online: null, reason: '未检测', at: 0, checking: false };
  const known = s.online === true || s.online === false;
  const cls = (!known && s.checking) ? 'checking'
    : (s.online === true ? 'on' : (s.online === false ? 'off' : 'unknown'));
  dot.className = 'st ' + cls;
  let txt;
  if (s.checking) {
    txt = known
      ? (s.online === true ? '在线（已登录）' : ('离线：' + (s.reason || '未登录'))) + '（检测中…）'
      : '检测中…';
  } else if (s.online === true) txt = '在线（已登录）';
  else if (s.online === false) txt = '离线：' + (s.reason || '未登录');
  else txt = s.reason ? ('待确认：' + s.reason) : '未检测';
  if (s.at) txt += '  ·  ' + new Date(s.at).toLocaleTimeString();
  dot.title = txt;
}

let statusSeq = 0;
let statusTimer = 0;
function scheduleStatus(delay) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { refreshStatus(); }, delay || 0);
}

async function refreshStatus() {
  if (!state.malls.length) { state.mallStatus.clear(); return; }
  const seq = ++statusSeq;
  const list = state.malls.slice();

  for (const m of list) {
    const prev = state.mallStatus.get(m.id) || { online: null, reason: '未检测', at: 0 };
    state.mallStatus.set(m.id, { ...prev, checking: true });
    paintMallStatus(m.id);
  }

  await Promise.all(list.map(async (m) => {
    let r = null, err = null;
    try {
      r = await window.pdd.pingMall(m.id);
    } catch (e) {
      err = e;
    }
    if (seq !== statusSeq) return; // 已有更新的一轮，丢弃这一轮的旧结果

    const prev = state.mallStatus.get(m.id) || { online: null, reason: '' };
    let online = null;
    let reason = '';
    if (err) {
      reason = '检测异常：' + ((err && err.message) || err);
    } else if (r && typeof r.online === 'boolean') {
      online = r.online;
      reason = r.reason || '';
    } else {
      reason = '接口没有返回结果';
    }

    // 页面导航 / 加载 / 未就绪属于「暂时测不到」，不是真的离线，
    // 不能把健康店铺误报成红色。之前测到在线就保持绿色。
    if (online === false && /未就绪|加载|超时|navigat|destroyed|Render frame|context/i.test(String(reason))) {
      reason = '检测暂不可用（' + reason + '）';
      online = prev.online === true ? true : null;
    }

    state.mallStatus.set(m.id, { online, reason, at: Date.now(), checking: false });
    paintMallStatus(m.id);
  }));
}
setInterval(() => { refreshStatus(); }, 25000);

async function addMall() {
  const name = await askText({
    title: '给这个店铺起个名字',
    placeholder: '例如：A店-羽绒服',
    value: '店铺' + (state.malls.length + 1),
  });
  if (!name) return;
  logInfo('正在创建店铺「' + name + '」...');
  try {
    const info = await window.pdd.addMall(name);
    await refreshMalls(info.id);
    setTab('browser');
    logOk('店铺「' + name + '」已创建');
    logInfo('在右侧浏览器里扫码登录，登录后左侧指示灯会变绿');
  } catch (e) {
    logErr('创建失败：' + (e && e.message ? e.message : e));
  }
}
$('#btnAddMall').addEventListener('click', addMall);

$('#btnReload').addEventListener('click', async () => {
  await window.pdd.reload();
  logInfo('已刷新页面');
});

// ------------------------------------------------------------------ 商品列表
function renderGoods(items) {
  state.goods = items || [];
  const tb = $('#goodsBody');
  tb.innerHTML = '';
  if (!state.goods.length) {
    $('#goodsTable').style.display = 'none';
    $('#goodsEmpty').style.display = 'flex';
    return;
  }
  $('#goodsEmpty').style.display = 'none';
  $('#goodsTable').style.display = 'table';

  for (const g of state.goods) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (g.thumb ? '<img src="' + esc(g.thumb) + '" />' : '') + '</td>' +
      '<td class="ttl" title="' + esc(g.title) + '">' + esc(g.title) + '</td>' +
      '<td class="price">' + money(g.group_price) + '</td>' +
      '<td class="price">' + money(g.single_price) + '</td>' +
      '<td>' + (g.sku_count == null ? '-' : g.sku_count) + '</td>' +
      '<td class="' + (g.stock ? '' : 'warn') + '">' + (g.stock == null ? '-' : g.stock) + '</td>' +
      '<td>' +
        '<button class="btn mini primary" data-act="collect">采集</button> ' +
        '<button class="btn mini" data-act="copy" title="同店复制会在本店再建一条重复链接">复制</button>' +
      '</td>';
    tr.querySelector('[data-act="collect"]').addEventListener('click', () => collectOne(g));
    tr.querySelector('[data-act="copy"]').addEventListener('click', () => openCopyDialog(g));
    tb.appendChild(tr);
  }
}

$('#btnList').addEventListener('click', async () => {
  const btn = $('#btnList');
  btn.disabled = true;
  btn.textContent = '读取中 ...';
  logInfo('正在读取本店在售商品 ...');
  try {
    const r = await window.pdd.listGoods();
    if (r && r.ok) {
      logOk('读到 ' + r.count + ' 个在售商品');
      renderGoods(r.items);
      setTab('goods');
      if ($('#goodsNote')) {
        $('#goodsNote').textContent = r.count + ' 个在售' +
          (r.total && r.total > r.count ? '（共 ' + r.total + '，仅取前 ' + r.count + '）' : '');
      }
      logInfo('点某一行的「采集」把商品存进采集箱；「复制」是同店复制，会产生重复链接');
    } else {
      logErr('读取失败：' + JSON.stringify(r && (r.error || r)));
    }
    setResult(r);
  } finally {
    btn.disabled = false;
    btn.textContent = '读取本店在售商品';
  }
});

// ------------------------------------------------------------------ 采集箱
async function collectOne(g) {
  logInfo('正在采集「' + String(g.title || '').slice(0, 18) + '」到采集箱 ...');
  try {
    const r = await window.pdd.poolCollect(g.idx, g.goods_id);
    if (r && r.ok) {
      logOk('已采集：' + r.pack.skus + ' 个 SKU / ' + r.pack.images + ' 张图 → 采集箱');
      await refreshPool();
      setTab('pool');
    } else {
      logErr('采集失败：' + JSON.stringify((r && (r.error || r.detail)) || r));
      setResult(r);
    }
  } catch (e) {
    logErr('采集异常：' + (e && e.message ? e.message : e));
  }
}

async function refreshPool() {
  const items = await window.pdd.poolList();
  const tb = $('#poolBody');
  const tbl = $('#poolTable');
  const empty = $('#poolEmpty');
  state.pool = items || [];
  if (!items || !items.length) {
    tbl.style.display = 'none';
    empty.style.display = 'flex';
    updateSelCount();
    return;
  }
  empty.style.display = 'none';
  tbl.style.display = 'table';
  tb.innerHTML = '';
  for (const it of items) {
    // 骨架预分配状态：采集时就算了「能不能上架、用哪个骨架」
    const plans = it.skeletonPlans || null;
    let skelCell = '<span style="color:#5c6a7e" title="这条商品还没算过。点上架会自动补算">— 未算</span>';
    if (plans && plans.length) {
      const ok = plans.filter((p) => p.ready);
      const detail = plans.map((p) => {
        const head = (p.mallName || '店铺') + '：';
        if (p.ready) return head + p.count + ' 个骨架可用';
        if (p.allCooling) return head + '骨架都在冷却期，要等';
        if (!p.count) return head + '没有同类目的商品';
        return head + (p.advice || '不可用');
      }).join('\n');
      if (ok.length) {
        skelCell = '<span style="color:#3ddc84" title="' + esc(detail) + '">✓ 可上</span>';
      } else if (plans.every((p) => p.allCooling)) {
        skelCell = '<span style="color:#ffb454" title="' + esc(detail) + '">⏳ 冷却中</span>';
      } else {
        skelCell = '<span style="color:#ff8080" title="' + esc(detail) + '">✗ 缺同类</span>';
      }
    } else if (it.skeletonAdvice) {
      skelCell = '<span style="color:#ff8080" title="' + esc(it.skeletonAdvice) + '">✗ 无类目</span>';
    }

    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="checkbox" data-sel="' + esc(it.id) + '"' +
        (state.poolSel.has(it.id) ? ' checked' : '') + ' /></td>' +
      '<td>' + (it.thumb ? '<img src="' + esc(it.thumb) + '" />' : '') + '</td>' +
      '<td class="ttl" title="' + esc(it.title) + '">' + esc(it.title) + '</td>' +
      '<td>' + esc(it.sourceMallName || '-') + '</td>' +
      '<td class="price">' + money(it.price) + '</td>' +
      '<td>' + (it.skus == null ? '-' : it.skus) + '</td>' +
      '<td>' + (it.images == null ? '-' : it.images) + '</td>' +
      '<td class="skel">' + skelCell + '</td>' +
      '<td>' +
        '<button class="btn mini" data-act="chk" title="检测标题/价格/主图/规格">检测</button> ' +
        '<button class="btn mini" data-act="wm" title="给主图加水印，输出到本地">水印</button> ' +
        '<button class="btn mini primary" data-act="pub">上架</button> ' +
        '<button class="btn mini" data-act="del">移除</button>' +
      '</td>';
    const cb = tr.querySelector('[data-sel]');
    cb.addEventListener('change', () => {
      if (cb.checked) state.poolSel.add(it.id); else state.poolSel.delete(it.id);
      updateSelCount();
    });
    tr.querySelector('[data-act="chk"]').addEventListener('click', () => openInspect(it));
    tr.querySelector('[data-act="wm"]').addEventListener('click', () => openWatermark(it));
    tr.querySelector('[data-act="pub"]').addEventListener('click', () => {
      if (!plans) {
        // 老条目没有预分配，点了上架先补算一次（不阻塞，出错也不影响上架）
        window.pdd.skeletonPreassign(it.id).then(() => refreshPool()).catch(() => {});
      }
      publishFromPool(it);
    });
    tr.querySelector('[data-act="del"]').addEventListener('click', async () => {
      await window.pdd.poolRemove(it.id);
      state.poolSel.delete(it.id);
      await refreshPool();
      logInfo('已从采集箱移除');
    });
    tb.appendChild(tr);
  }
  updateSelCount();
  if (state.orderData) renderOrderContribution(state.orderData);
}

// ---------------------------------------------------------------- 商品检测
const LEVEL_TXT = { error: '必修', warn: '建议改', info: '参考' };

function renderInsp(res, deepNote) {
  const box = $('#inspBody');
  const cls = res.level === 'ok' ? 'ok' : (res.level === 'error' ? 'error' : 'warn');
  const grade = res.level === 'ok' ? '通过' : (res.level === 'error' ? '有问题' : '基本可用');

  let html = '<div class="insp-score">' +
    '<div class="insp-num ' + cls + '">' + res.score + '</div>' +
    '<div><b>' + grade + '</b><div class="insp-meta">' +
    '必修 ' + res.summary.error + ' 项 ｜ 建议 ' + res.summary.warn + ' 项 ｜ 参考 ' + res.summary.info + ' 项<br>' +
    '标题 ' + res.summary.titleLen + ' 字 ｜ SKU ' + res.summary.skuCount +
    ' 个 ｜ 主图 ' + res.summary.galleryCount + ' 张</div></div></div>';

  if (deepNote) {
    html += '<div class="insp-item info"><div class="t">' + esc(deepNote) + '</div></div>';
  }

  if (!res.issues.length) {
    html += '<div class="insp-item info"><div class="t">没发现问题</div></div>';
  }
  for (const s of res.issues) {
    html += '<div class="insp-item ' + esc(s.level) + '">' +
      '<div class="t"><span class="insp-tag ' + esc(s.level) + '">' + LEVEL_TXT[s.level] + '</span>' +
      esc(s.msg) +
      (s.unconfirmed ? '<span class="insp-unc" title="这条阈值没有官方依据，只是经验值">未确认</span>' : '') +
      '</div>' +
      (s.fix ? '<div class="f">→ ' + esc(s.fix) + '</div>' : '') +
      '</div>';
  }

  if (res.images && res.images.length) {
    html += '<div class="insp-meta" style="margin-top:12px">主图逐张测量</div><div class="insp-imgs">';
    for (const im of res.images) {
      const bad = im.level === 'warn' || im.level === 'error' || im.error;
      const cap = im.error ? '下载失败'
        : (im.w + '×' + im.h + '<br>' + (im.bytes ? (im.bytes / 1024).toFixed(0) + 'KB' : ''));
      html += '<div class="insp-img ' + (bad ? 'bad' : '') + '" title="' +
        esc((im.issues || []).map((x) => x.msg).join('\n') || '正常') + '">' +
        '<img src="' + esc(im.url) + '" />' + cap + '</div>';
    }
    html += '</div>';
  }
  if (res.imageErrors && res.imageErrors.length) {
    html += '<div class="hint" style="color:#f5a623">' + esc(res.imageErrors.join('；')) + '</div>';
  }

  box.innerHTML = html;
}

async function openInspect(it) {
  await withViewHidden(async () => {
    const mask = $('#inspMask');
    $('#inspTitle').textContent = String(it.title || '').slice(0, 22);
    $('#inspBody').innerHTML = '<div class="insp-meta">检测中…</div>';
    $('#inspErr').textContent = '';
    mask.classList.add('on');
    $('#inspDeep').disabled = true;
    $('#inspClose').onclick = () => { mask.classList.remove('on'); };

    // 先跑规则层（快）
    const r = await window.pdd.inspectItem({ id: it.id, withImages: false });
    $('#inspDeep').disabled = false;
    if (!r || !r.ok) {
      $('#inspErr').textContent = (r && r.error) || '检测失败';
      $('#inspBody').innerHTML = '';
      return;
    }
    state.lastInsp = it;
    renderInsp(r);

    // 图像层：按需触发
    $('#inspDeep').textContent = '连主图一起查';
    $('#inspDeep').onclick = async () => {
      $('#inspDeep').disabled = true;
      $('#inspDeep').textContent = '正在下载主图…';
      const r2 = await window.pdd.inspectItem({ id: it.id, withImages: true });
      $('#inspDeep').disabled = false;
      $('#inspDeep').textContent = '重新查主图';
      if (r2 && r2.ok) {
        renderInsp(r2, '已合并主图检测（' + ((r2.images || []).length) + ' 张）');
        logOk('主图检测完成：' + (r2.images || []).length + ' 张');
      } else {
        $('#inspErr').textContent = (r2 && r2.error) || '主图检测失败';
      }
    };
  });
}

// ---------------------------------------------------------------- 主图水印
const WM_DEFAULT_TEXT = {
  mall: '',
};

async function openWatermark(it) {
  await withViewHidden(async () => {
    const mask = $('#wmMask');
    $('#wmTitle').textContent = String(it.title || '').slice(0, 20) + ' · ' + (it.images || 0) + ' 张';
    $('#wmErr').textContent = '';
    $('#wmSteps').innerHTML = '';
    $('#wmProgress').style.display = 'none';
    if (!$('#wmText').value) {
      $('#wmText').value = (it.sourceMallName || '') + ' 严选';
    }
    const syncPos = () => {
      $('#wmPosWrap').style.display = ($('#wmMode').value === 'corner') ? 'block' : 'none';
    };
    const syncOpacity = () => {
      $('#wmOpacityVal').textContent = Math.round(Number($('#wmOpacity').value) * 100) + '%';
    };
    syncPos(); syncOpacity();
    $('#wmMode').onchange = () => {
      syncPos();
      // 平铺默认更淡
      if ($('#wmMode').value === 'tile') {
        $('#wmOpacity').value = '0.20';
      } else if ($('#wmMode').value === 'band') {
        $('#wmOpacity').value = '0.50';
      } else {
        $('#wmOpacity').value = '0.55';
      }
      syncOpacity();
    };
    $('#wmOpacity').oninput = syncOpacity;

    mask.classList.add('on');
    $('#wmCancel').onclick = () => mask.classList.remove('on');
    $('#wmOk').disabled = false;
    $('#wmOk').textContent = '生成水印图';
    $('#wmOk').onclick = async () => {
      const text = $('#wmText').value.trim();
      if (!text) { $('#wmErr').textContent = '请填水印文字'; return; }
      $('#wmOk').disabled = true;
      $('#wmOk').textContent = '处理中…';
      $('#wmErr').textContent = '';
      $('#wmProgress').style.display = 'block';
      $('#wmSteps').innerHTML = '<div>正在下载主图并加水印（' + (it.images || 0) + ' 张）…</div>';

      const r = await window.pdd.watermarkItem({
        id: it.id,
        text,
        mode: $('#wmMode').value,
        pos: $('#wmPos').value,
        opacity: Number($('#wmOpacity').value),
      });

      $('#wmOk').disabled = false;
      $('#wmOk').textContent = '重新生成';
      if (r && r.ok) {
        logOk('水印完成 ' + r.count + '/' + r.total + ' 张');
        $('#wmSteps').innerHTML =
          '<div class="s-ok">已生成 ' + r.count + ' 张</div>' +
          '<div style="color:#8fa3c0;font-size:11px;word-break:break-all">' + esc(r.outDir) + '</div>';
        $('#wmHint').innerHTML = '生成好了。<b>不会动平台上的图</b>——需要你自己上传替换。';
        // 加一个打开目录按钮
        if (!$('#wmOpen')) {
          const b = document.createElement('button');
          b.className = 'btn mini primary';
          b.id = 'wmOpen';
          b.textContent = '打开文件夹';
          b.style.marginTop = '8px';
          b.onclick = () => window.pdd.openPath(r.outDir);
          $('#wmSteps').appendChild(b);
        } else {
          $('#wmOpen').onclick = () => window.pdd.openPath(r.outDir);
        }
        if (r.errors && r.errors.length) {
          $('#wmSteps').innerHTML += '<div style="color:#f5a623">' + esc(r.errors.join('；')) + '</div>';
        }
      } else {
        $('#wmErr').textContent = (r && r.error) || '生成失败';
        logErr('水印失败：' + ((r && r.error) || '未知'));
      }
    };
  });
}

// ---------------------------------------------------------------- 批量队列
function updateSelCount() {
  const n = state.poolSel.size;
  const el = $('#poolSelCount');
  if (el) el.textContent = '已选 ' + n + ' 个';
  const all = $('#poolAll');
  const all2 = $('#poolAll2');
  const total = (state.pool || []).length;
  const on = n > 0 && n === total;
  if (all) all.checked = on;
  if (all2) all2.checked = on;
}

function toggleSelectAll(checked) {
  state.poolSel.clear();
  if (checked) for (const it of (state.pool || [])) state.poolSel.add(it.id);
  document.querySelectorAll('#poolBody [data-sel]').forEach((cb) => {
    cb.checked = !!checked;
  });
  updateSelCount();
}

const BATCH_STATE_TEXT = {
  queued: '排队中', running: '执行中', done: '成功',
  failed_known: '失败', failed_unknown: '状态未知',
};

function renderBatch(payload) {
  if (!payload) return;
  const s = payload.stats || {};
  const running = !!payload.running;

  const stat = $('#batchStat');
  if (stat) {
    if (s.total) {
      stat.style.display = 'block';
      stat.textContent = '共 ' + s.total + ' 项 ｜ 成功 ' + (s.done || 0) +
        ' ｜ 失败 ' + (s.failed_known || 0) +
        ' ｜ 状态未知 ' + (s.failed_unknown || 0) +
        ' ｜ 排队 ' + (s.queued || 0) + (running ? ' ｜ 运行中…' : '');
    } else {
      stat.style.display = 'none';
    }
  }

  const btnStart = $('#btnBatchStart');
  const btnStop = $('#btnBatchStop');
  if (btnStart) btnStart.style.display = running ? 'none' : '';
  if (btnStop) btnStop.style.display = running ? '' : 'none';

  const items = payload.items || [];
  const panel = $('#batchPanel');
  const tb = $('#batchBody');
  if (!items.length) {
    if (panel) panel.style.display = 'none';
    return;
  }
  if (panel) panel.style.display = 'block';
  if (tb) {
    tb.innerHTML = '';
    items.forEach((it, i) => {
      const tr = document.createElement('tr');
      const cls = 'st-' + it.state;
      tr.innerHTML =
        '<td>' + (i + 1) + '</td>' +
        '<td>' + esc(String(it.title || '').slice(0, 26)) + '</td>' +
        '<td class="' + cls + '">' + (BATCH_STATE_TEXT[it.state] || it.state) + '</td>' +
        '<td>' + (it.attempts || 0) + '</td>' +
        '<td>' + esc(it.errorMsg || '') +
          (it.state === 'failed_unknown'
            ? '<br><span style="color:#ef5b5b">⚠ 状态未知，请去后台核对，不要直接重试</span>'
            : '') + '</td>';
      tb.appendChild(tr);
    });
  }
  const sum = $('#batchSummary');
  if (sum) sum.textContent = '成功 ' + (s.done || 0) + ' / 共 ' + (s.total || 0);
}

async function startBatch() {
  const ids = [...state.poolSel];
  if (!ids.length) { logWarn('先在左边勾选要上架的商品'); return; }
  const stock = Number($('#batchStock').value) || 50;
  const factor = Number($('#batchFactor').value) || 1;
  const gmin = Number($('#batchGapMin').value) || 15;
  const gmax = Number($('#batchGapMax').value) || 25;
  logInfo('批量上架 ' + ids.length + ' 个商品，库存 ' + stock +
          '，加价 ×' + factor + '，间隔 ' + gmin + '~' + gmax + ' 秒 ...');
  const r = await window.pdd.batchStart(ids, {
    stock, factor, intervalMin: gmin, intervalMax: gmax, maxAttempts: 2,
  });
  if (!r || !r.ok) { logErr('批量启动失败：' + ((r && r.error) || '未知')); return; }
  setTab('pool');
}

$('#poolAll') && $('#poolAll').addEventListener('change', (e) => toggleSelectAll(e.target.checked));
$('#poolAll2') && $('#poolAll2').addEventListener('change', (e) => toggleSelectAll(e.target.checked));
$('#btnBatchStart') && $('#btnBatchStart').addEventListener('click', startBatch);
$('#btnBatchStop') && $('#btnBatchStop').addEventListener('click', async () => {
  await window.pdd.batchStop();
  logWarn('已请求停止，当前这一件跑完就停');
});
$('#btnBatchRetry') && $('#btnBatchRetry').addEventListener('click', async () => {
  const r = await window.pdd.batchRetryKnown();
  if (r && r.ok) { logInfo('已把「失败」项重置为排队，点「批量上架」继续'); await refreshBatch(); }
});
$('#btnBatchClear') && $('#btnBatchClear').addEventListener('click', async () => {
  const r = await window.pdd.batchClear();
  if (r && r.ok) { logInfo('批量记录已清空'); await refreshBatch(); }
  else logWarn((r && r.error) || '清空失败');
});

async function refreshBatch() {
  try {
    const p = await window.pdd.batchList();
    renderBatch(p);
  } catch (_) { /* ignore */ }
}

window.pdd.onBatch((p) => renderBatch(p));


async function publishFromPool(it) {
  logInfo('从采集箱上架：' + String(it.title || '').slice(0, 18) + ' → 当前店铺 ...');
  const r = await window.pdd.poolPublish({ id: it.id });
  if (r && r.ok) logOk('已上架');
  else {
    logWarn((r && r.error) || '上架失败');
    if (r && r.advice) logInfo('建议：' + r.advice);
  }
  setResult(r);
  setTab('result');
}

// ------------------------------------------------------------------ 复制（同店）
let currentItem = null;

function suggestTitle(t) {
  const s = String(t || '');
  return s.length > 56 ? s.slice(0, 56) + '-新款' : s + '-新款';
}

function updatePreview() {
  const f = Number($('#copyFactor').value);
  const box = $('#copyPreview');
  if (!currentItem || !f || f <= 0) { box.textContent = '填一个大于 0 的倍数，例如 1.05'; return; }
  const g = Number(currentItem.group_price) || 0;
  const s = Number(currentItem.single_price) || 0;
  const ng = Math.round(g * f);
  const ns = Math.round(s * f);
  box.innerHTML = '拼单价 <b>' + money(g) + '</b> → <b>' + money(ng) + '</b>（+' +
                  ((ng - g) / 100).toFixed(2) + ' 元）<br>单买价 <b>' + money(s) +
                  '</b> → <b>' + money(ns) + '</b>';
}

// 改倍数时实时更新价格预览。
// 之前 updatePreview() 只在开窗时算一次，用户改完看不见自己设了什么价 —— 批量下会放大成 50 条错价。
(function bindFactorPreview() {
  const el = document.getElementById('copyFactor');
  if (!el) return;
  const onEdit = () => updatePreview();
  el.addEventListener('input', onEdit);
  el.addEventListener('change', onEdit);
  el.addEventListener('keyup', onEdit);
})();

function openCopyDialog(item) {
  currentItem = item;
  $('#copyErr').textContent = '';
  $('#copyProgress').style.display = 'none';
  $('#copyBar').style.width = '0';
  $('#copySteps').innerHTML = '';
  $('#copyTitle').value = suggestTitle(item.title);
  $('#copyFactor').value = '1.05';
  $('#copyDoPrice').checked = true;
  $('#copyPublish').checked = false;
  $('#copyThumb').src = item.thumb || '';
  $('#copySrcTitle').textContent = item.title || '';
  $('#copySrcMeta').textContent = '拼单价 ' + money(item.group_price) + ' ｜ 单买价 ' +
    money(item.single_price) + ' ｜ ' + (item.sku_count || 0) + ' 个 SKU ｜ 库存 ' + (item.stock || 0);
  updatePreview();
  renderSizeBox(item);

  withViewHidden(() => new Promise((resolve) => {
    const mask = $('#copyMask');
    mask.classList.add('on');
    focusInput($('#copyTitle'), true);   // 标题框自动获得焦点并全选，方便直接改
    $('#copyCancel').textContent = '取消';
    $('#copyOk').textContent = '开始复制';

    const close = () => {
      mask.classList.remove('on');
      $('#copyCancel').onclick = null;
      $('#copyOk').onclick = null;
      resolve(null);
    };
    $('#copyCancel').onclick = close;
    $('#copyOk').onclick = async () => {
      const title = $('#copyTitle').value.trim();
      const factor = Number($('#copyFactor').value);
      const doPrice = $('#copyDoPrice').checked;
      const publish = $('#copyPublish').checked;
      if (!title) { $('#copyErr').textContent = '标题不能为空'; return; }
      if (!factor || factor <= 0) { $('#copyErr').textContent = '倍数不合法'; return; }

      $('#copyOk').disabled = true;
      $('#copyCancel').disabled = true;
      $('#copyProgress').style.display = 'block';
      await runCopy(item, title, factor, doPrice, publish, (pct, text, cls) => {
        $('#copyBar').style.width = Math.round(pct) + '%';
        const d = document.createElement('div');
        d.className = cls || '';
        d.textContent = text;
        $('#copySteps').appendChild(d);
      });
      $('#copyOk').disabled = false;
      $('#copyCancel').disabled = false;
      $('#copyCancel').textContent = '关闭';
      $('#copyOk').textContent = '再复制一条';
      $('#copyOk').onclick = close;
    };
  }));
}

// ------------------------------------------------------------------ 尺码表匹配
async function renderSizeBox(item) {
  const box = $('#copySizeBody');
  if (!box) return;
  box.textContent = '按尺码标签匹配中 ...';
  let tpl = null;
  try {
    tpl = await window.pdd.sizeMatch({ catNames: item.catNames || [], sizes: item.sizes || [] });
  } catch (e) {
    box.innerHTML = '<span class="no">匹配失败：' + esc(e && e.message ? e.message : e) + '</span>';
    return;
  }
  if (!tpl) {
    box.innerHTML = '<span class="no">没有匹配到模板</span><br>' +
      '<span style="color:#7d8aa3">类目：' + esc((item.catNames || []).join(' / ') || '（无）') + '</span><br>' +
      '<span style="color:#7d8aa3">商品尺码：' + esc((item.sizes || []).join(', ') || '（未读到）') + '</span>';
    return;
  }
  const chips = tpl.sizes.map((s) => '<span class="chip">' + esc(s) + '</span>').join('');
  const how = tpl.bySizes
    ? ('尺码标签匹配 · ' + tpl.rowCount + ' 个尺码')
    : ('类目关键词 · ' + esc(tpl.matchedBy || ''));
  box.innerHTML = '<span class="ok">已匹配：' + esc(tpl.name) + '</span><br>' +
    '<span style="color:#7d8aa3">' + how + '</span>' +
    '<div class="chips">' + chips + '</div>' +
    '<div style="margin-top:6px;color:#f5a623;font-size:11px">自动写入尚未接入</div>';
  state.sizeTpl = tpl;
}

// ------------------------------------------------------------------ 执行复制
async function runCopy(item, title, factor, doPrice, doPublish, progress) {
  progress(8, '正在复制商品 ...');
  let r;
  try {
    r = await window.pdd.copyGoods({ index: item.idx, goodsId: item.goods_id, title, submit: false, allowSameStore: true });
  } catch (e) {
    progress(100, '出错：' + (e && e.message ? e.message : e), 's-err');
    logErr('复制异常：' + (e && e.message ? e.message : e));
    return;
  }
  if (!r || !r.ok) {
    const raw = (r && r.detail && (r.detail.error_msg || r.detail.errorMsg)) || (r && r.error) || '未知';
    let human = raw;
    if (r && r.detail && r.detail.error_code === 600102) {
      human = '这个商品之前已经复制过一次，平台限制不能连续新建。换一个商品试试。';
    }
    progress(100, '复制失败：' + human, 's-err');
    logErr('复制失败：' + human);
    setResult(r);
    state.last = { ok: false, title: item.title, error: human, code: r && r.detail && r.detail.error_code };
    renderLastCard();
    return;
  }

  const d = r.result;
  progress(45, '草稿已建：图 ' + d.images + ' 张，SKU ' + d.skus + ' 个', 's-ok');
  logOk('草稿已建 commit=' + d.commit_id + ' goods=' + d.goods_id);
  if (d.stock_warning && d.stock_warning !== 'ok') logWarn(d.stock_warning);

  let priceInfo = null;
  if (doPrice) {
    progress(55, '正在改价（约 15 秒）...');
    try {
      const pr = await window.pdd.changePrice({ commit: d.commit_id, goods: d.goods_id, factor });
      if (pr && pr.ok) {
        priceInfo = pr.after;
        progress(95, '改价成功：拼单价 ' + money(pr.after && pr.after.min_group_price), 's-ok');
      } else {
        progress(95, '改价失败：' + JSON.stringify((pr && pr.save) || pr), 's-err');
      }
    } catch (e) {
      progress(95, '改价异常：' + (e && e.message ? e.message : e), 's-err');
    }
  }

  state.last = { ok: true, result: d, priceInfo, published: false };

  if (doPublish) {
    progress(97, '正在提交上架 ...');
    try {
      const sr = await window.pdd.publish({ commit: d.commit_id, goods: d.goods_id, stock: 50 });
      (sr.steps || []).forEach((s) => logInfo('  ' + s));
      if (sr && sr.ok) {
        state.last.published = true;
        progress(100, '已提交上架，等审核', 's-ok');
        logOk('已提交上架 —— 审核通过后才出现在在售列表');
      } else {
        if (sr && sr.advice) logWarn('建议：' + sr.advice);
        progress(100, '提交失败：' + ((sr && sr.error) || '未知'), 's-err');
      }
    } catch (e) {
      progress(100, '提交异常：' + (e && e.message ? e.message : e), 's-err');
    }
  } else {
    progress(100, '完成（已存草稿，未上架）', 's-ok');
  }

  setResult(r);
  renderLastCard();
}

// ------------------------------------------------------------------ 结果卡片
function renderLastCard() {
  const box = $('#lastCard');
  const L = state.last;
  if (!L) return;
  if (!L.ok) {
    box.className = 'card fail';
    box.innerHTML =
      '<div class="title">操作失败 <span class="badge fail">失败</span></div>' +
      '<div class="row"><span class="k">商品</span><span class="v">' +
      esc(String(L.title || '').slice(0, 26)) + '</span></div>' +
      '<div class="row"><span class="k">原因</span><span class="v">' + esc(L.error || '') + '</span></div>';
    return;
  }
  const d = L.result;
  box.className = 'card ok';
  box.innerHTML =
    '<div class="title">草稿已创建 ' +
    (L.published ? '<span class="badge ok">已提交上架</span>' : '<span class="badge wait">未上架</span>') +
    '</div>' +
    '<div class="row"><span class="k">标题</span><span class="v">' + esc(String(d.title || '').slice(0, 24)) + '</span></div>' +
    '<div class="row"><span class="k">图片 / SKU</span><span class="v">' + d.images + ' 张 / ' + d.skus + ' 个</span></div>' +
    '<div class="row"><span class="k">拼单价</span><span class="v">' +
    money((L.priceInfo && L.priceInfo.min_group_price) || d.min_group_price) + '</span></div>' +
    '<div class="row"><span class="k">草稿号</span><span class="v">' + d.commit_id + '</span></div>' +
    (L.published ? '' : '<button class="btn primary block" id="btnPublish">提交上架到店铺</button>');

  const btn = $('#btnPublish');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = '准备并提交 ...';
      logInfo('提交上架 ' + d.commit_id + ' ...');
      try {
        const sr = await window.pdd.publish({ commit: d.commit_id, goods: d.goods_id, stock: 50 });
        (sr.steps || []).forEach((s) => logInfo('  ' + s));
        if (sr && sr.ok) {
          state.last.published = true;
          logOk('已提交上架 —— 审核通过后才出现在在售列表');
        } else {
          if (sr && sr.advice) logWarn('建议：' + sr.advice);
          logErr('提交失败：' + ((sr && sr.error) || JSON.stringify(sr && sr.submit) || ''));
        }
      } catch (e) {
        logErr('提交异常：' + (e && e.message ? e.message : e));
      }
      renderLastCard();
    };
  }
}

// ------------------------------------------------------------------ 资金复盘
const fmtYuan = (fen) => {
  if (fen === null || fen === undefined) return '—';
  const v = Number(fen) / 100;
  const s = Math.abs(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-' : '') + s;
};

function localDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 金额滚动：从上一个值滚到新值（360ms）。首次赋值直接到位，不滚。
 * prefers-reduced-motion 时全部直接到位。只动 textContent，不改布局。
 */
const _moneyPrev = new Map();
function setMoney(el, value) {
  if (!el) return;
  const to = Number.isFinite(Number(value)) ? Number(value) : null;
  if (to === null) { el.textContent = '—'; _moneyPrev.delete(el); return; }
  const key = el.id || el;
  const from = _moneyPrev.has(key) ? _moneyPrev.get(key) : null;
  _moneyPrev.set(key, to);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (from === null || reduce || from === to) { el.textContent = fmtYuan(to); return; }
  if (el._moneyRaf) cancelAnimationFrame(el._moneyRaf);
  const t0 = performance.now();
  const DUR = 360;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / DUR);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtYuan(Math.round(from + (to - from) * eased));
    if (k < 1) el._moneyRaf = requestAnimationFrame(step);
    else { el._moneyRaf = null; el.textContent = fmtYuan(to); }
  };
  el._moneyRaf = requestAnimationFrame(step);
  // 兜底：窗口在后台时 rAF 可能被节流到不触发，必须保证终值一定落下
  if (el._moneyTimer) clearTimeout(el._moneyTimer);
  el._moneyTimer = setTimeout(() => {
    el._moneyTimer = null;
    if (el._moneyRaf) { cancelAnimationFrame(el._moneyRaf); el._moneyRaf = null; }
    el.textContent = fmtYuan(to);
  }, DUR + 80);
}

function renderFinance(data, month) {
  const body = $('#finBody');
  const empty = $('#finEmpty');
  const content = $('#finContent');
  // 快照可能含已移除的店铺，渲染前统一过滤，避免移除后仍显示它的行
  if (data && Array.isArray(data.stores)) {
    data = Object.assign({}, data, { stores: keepActiveStores(data.stores) });
  }
  if (!data || !data.stores || !data.stores.length) {
    empty.style.display = 'flex';
    content.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  content.style.display = 'block';

  const agg = data.aggregate || {};
  const cur = month || data.month;

  // 选月份：优先用当前月的分店汇总
  let inc = 0, exp = 0, profit = 0;
  if (cur === data.month) {
    inc = agg.income || 0; exp = agg.expense || 0; profit = agg.profit || 0;
  } else {
    const mm = (agg.months || {})[cur] || {};
    inc = mm.income || 0; exp = mm.expense || 0; profit = mm.profit || 0;
  }

  // 四张卡：待到账 / 本月毛利 / 待退货金额 / 拿货成本（累计）
  const today = localDateStr(new Date());
  const cashDailyRows = [];
  for (const s of (data.stores || [])) {
    for (const d of (s.daily || [])) {
      if (d && d.date) cashDailyRows.push({ date: String(d.date).slice(0, 10), income: d.income || 0 });
    }
  }
  cashDailyRows.sort((a, b) => b.date.localeCompare(a.date));
  const lastCashDaily = cashDailyRows[0] || null;

  // ① 待到账 = 各店（货款余额 − 可提现余额）。余额都是「分」。
  let pending = 0, pendingOk = false;
  for (const s of (data.stores || [])) {
    const b = s.balance;
    if (b && b.cash != null && b.cashAvailable != null) {
      pending += Math.max(0, (Number(b.cash) || 0) - (Number(b.cashAvailable) || 0));
      pendingOk = true;
    }
  }
  setMoney($('#fcPending'), pendingOk ? pending : null);
  $('#fcPendingSub').textContent = pendingOk ? '货款已入账 · 未到可提现' : '采集余额后显示';

  // ②③ 本月毛利 / 待退货金额：都从订单明细算，和商品贡献表同一套口径
  buildOrderThumbIndex(state.orderData);
  const contrib = computeContribution(state.orderData);
  const monthPrefix = cur + '-';
  let monthRevenue = 0, monthCost = 0, grossOk = false;
  let pendingRefund = 0, pendingRefundCount = 0;
  for (const r of contrib.rows) {
    if (r.excluded) {
      if (r.pendingReturn) {
        pendingRefund += r.orderAmount;
        pendingRefundCount += 1;
      }
      continue;
    }
    if (!r.orderTime) continue;
    if (localDateStr(new Date(Number(r.orderTime) * 1000)).slice(0, 7) !== cur) continue;
    monthRevenue += r.orderAmount;
    if (r.unit != null) monthCost += Math.round(r.unit * r.quantity);
    grossOk = true;
  }
  const monthGross = grossOk ? monthRevenue - monthCost : null;
  setMoney($('#fcMonthGross'), monthGross);
  $('#fcMonthGross').className = 'fc-value ' + (monthGross !== null && monthGross < 0 ? 'expense' : 'income');
  $('#fcMonthGrossSub').textContent = grossOk
    ? ('实收 ' + fmtYuan(monthRevenue) + ' − 成本 ' + fmtYuan(monthCost))
    : '需要订单与商品成本';
  setMoney($('#fcPendingRefund'), pendingRefund);
  $('#fcPendingRefundSub').textContent = pendingRefundCount
    ? (pendingRefundCount + ' 单退货退款中')
    : '当前没有在途退货';

  // ④ 拿货成本：按日总额账本，卡片显示累计
  const costTotal = Number.isFinite(Number(state.costTotal))
    ? Number(state.costTotal)
    : (state.costs || []).reduce((n, c) => n + (Number(c.amount) || 0), 0);
  setMoney($('#fcCostTotal'), costTotal);
  $('#fcCostTotalSub').textContent = (state.costs || []).length + ' 笔 · 累计进货';

  renderCostBlock();

  // 分店铺
  const sb = $('#finStoreBody');
  sb.innerHTML = '';
  for (const s of data.stores) {
    const m = (s.months || []).find((x) => x.month === cur);
    const tr = document.createElement('tr');
    if (s.error) {
      tr.innerHTML = '<td>' + esc(s.mallName) + '</td><td colspan="7" style="color:#ef5b5b">' + esc(s.error) + '</td>';
    } else {
      tr.innerHTML =
        '<td>' + esc(s.mallName) + '</td>' +
        '<td style="color:#7d8aa3">' + esc(s.account || '—') + '</td>' +
        '<td class="r income">' + fmtYuan(m ? m.income : null) + '</td>' +
        '<td class="r expense">' + fmtYuan(m ? m.expense : null) + '</td>' +
        '<td class="r ' + ((m && m.profit >= 0) ? 'income' : 'expense') + '">' + fmtYuan(m ? m.profit : null) + '</td>' +
        '<td class="r">' + (s.balance ? fmtYuan((s.balance.cash || 0) + (s.balance.market || 0)) : '—') + '</td>' +
        '<td class="r">' + (s.balance ? fmtYuan(s.balance.deposit) : '—') + '</td>';
    }
    sb.appendChild(tr);
  }

  // 日账单（核心视图：逐日收支与余额，点行展开当日逐笔分类）
  const dsec = $('#finDailySec');
  const db = $('#finDailyBody');
  const dnote = $('#finDailyNote');
  const dailyRows = [];
  for (const s of data.stores) {
    for (const day of (Array.isArray(s.days) ? s.days : [])) dailyRows.push({ mall: s.mallName, day });
  }
  if (dailyRows.length) {
    dsec.style.display = 'block';
    db.innerHTML = '';
    // 日期倒序（同日保持店铺顺序）
    dailyRows.sort((a, b) => (a.day.date < b.day.date ? 1 : -1));
    for (const { mall, day } of dailyRows) {
      let inc = 0, exp = 0, n = 0;
      for (const row of (day.rows || [])) {
        const amt = row.amount || 0;
        if (amt >= 0) inc += amt; else exp += amt;
        n += 1;
      }
      const net = inc + exp;
      const tr = document.createElement('tr');
      tr.className = 'fin-day-hd';
      tr.innerHTML =
        '<td style="color:#7d8aa3">' + esc(mall) + '</td>' +
        '<td>' + esc(day.date || '') + '</td>' +
        '<td class="r income">' + fmtYuan(inc) + '</td>' +
        '<td class="r expense">' + fmtYuan(exp) + '</td>' +
        '<td class="r ' + (net >= 0 ? 'income' : 'expense') + '">' + fmtYuan(net) + '</td>' +
        '<td class="r">' + fmtYuan(day.beginBalance) + '</td>' +
        '<td class="r">' + fmtYuan(day.endBalance) + '</td>' +
        '<td class="r fin-day-caret">▸ ' + n + ' 笔</td>';
      // 展开明细行（整行点击切换）
      const sub = document.createElement('tr');
      sub.className = 'fin-day-sub';
      sub.style.display = 'none';
      const subTd = document.createElement('td');
      subTd.colSpan = 8;
      const rows = day.rows || [];
      if (rows.length) {
        let html = '<table class="fin-table fin-day-detail"><thead><tr>' +
          '<th>入账时间</th><th>商户订单号</th><th>类型</th>' +
          '<th class="r">金额</th><th>备注</th></tr></thead><tbody>';
        for (const r of rows) {
          const dot = '<span class="cat-dot" style="background:' + (r.color || '#b0b8c8') + '"></span>';
          html +=
            '<tr><td>' + esc(r.time || '') + '</td>' +
            '<td>' + esc(r.orderSn || '') + '</td>' +
            '<td>' + dot + '<span class="cat-name">' + esc(r.label || r.bizType || '—') + '</span></td>' +
            '<td class="r ' + ((r.amount || 0) >= 0 ? 'income' : 'expense') + '">' + fmtYuan(r.amount) + '</td>' +
            '<td style="color:#7d8aa3">' + esc(r.remark || '—') + '</td></tr>';
        }
        html += '</tbody></table>';
        subTd.innerHTML = html;
      } else {
        subTd.innerHTML = '<div style="color:#7d8aa3;padding:4px 2px">无明细</div>';
      }
      sub.appendChild(subTd);
      tr.addEventListener('click', () => {
        const open = sub.style.display === 'none';
        sub.style.display = open ? '' : 'none';
        const c = tr.querySelector('.fin-day-caret');
        if (c) c.textContent = (open ? '▾ ' : '▸ ') + n + ' 笔';
      });
      db.appendChild(tr);
      db.appendChild(sub);
    }
  } else {
    dsec.style.display = 'none';
  }

  // 月度趋势：优先由日账单逐笔派生（日账单优先原则），缺失时回退月度汇总
  const mb = $('#finMonthBody');
  mb.innerHTML = '';
  const mnote = $('#finMonthNote');
  const aggMonths = Object.values(agg.months || {}).sort((a, b) => (a.month < b.month ? 1 : -1));
  let months = aggMonths.slice(0, 12);
  if (dailyRows.length) {
    const byMon = new Map();
    for (const { day } of dailyRows) {
      for (const row of (day.rows || [])) {
        const ym = String(row.time || day.date || '').slice(0, 7);
        if (!ym) continue;
        if (!byMon.has(ym)) byMon.set(ym, { month: ym, income: 0, expense: 0, profit: 0 });
        const b = byMon.get(ym);
        const amt = row.amount || 0;
        if (amt >= 0) b.income += amt; else b.expense += amt;
      }
    }
    months = [...byMon.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
    for (const m of months) m.profit = m.income + m.expense;
    mnote.textContent = '近 30 天';
  } else {
    mnote.textContent = '来自月度汇总';
  }
  const maxAbs = Math.max(1, ...months.map((m) => Math.abs(m.income || 0)));
  for (const m of months) {
    const pct = Math.round((Math.abs(m.income || 0) / maxAbs) * 100);
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + esc(m.month) + '</td>' +
      '<td class="r income">' + fmtYuan(m.income) + '</td>' +
      '<td class="r expense">' + fmtYuan(m.expense) + '</td>' +
      '<td class="r ' + ((m.profit || 0) >= 0 ? 'income' : 'expense') + '">' + fmtYuan(m.profit) + '</td>' +
      '<td><span class="fin-bar-pct" style="width:' + pct + 'px"></span>' + pct + '%</td>';
    mb.appendChild(tr);
  }

  // 资金去向（有明细才显示）——按 main.js 已归类的 group 汇总，与日账单同一套分类
  const catSec = $('#finCatSec');
  const allCats = [];
  for (const s of data.stores) {
    if (Array.isArray(s.days)) {
      for (const day of s.days) for (const row of (day.rows || [])) allCats.push(row);
    } else if (Array.isArray(s.detail)) {
      // 旧数据兜底：按业务描述 code 猜分组
      for (const d of s.detail) {
        const parts = String(d.desc || '').split('|');
        const code = (parts[0] || '').trim();
        const name = (parts[1] || '').trim() || d.bizType || '其他';
        allCats.push({ code, group: code ? name.split('-')[0] : '其他', color: '#b0b8c8', amount: d.amount });
      }
    }
  }
  if (allCats.length) {
    const buckets = new Map();
    for (const d of allCats) {
      const key = d.group || '其他';
      if (!buckets.has(key)) buckets.set(key, { name: key, amount: 0, count: 0, color: d.color || '#b0b8c8' });
      const b = buckets.get(key);
      b.amount += d.amount || 0;
      b.count += 1;
    }
    const arr = [...buckets.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    const totalAbs = Math.max(1, arr.reduce((s, x) => s + Math.abs(x.amount), 0));
    const cb = $('#finCatBody');
    cb.innerHTML = '';
    for (const c of arr) {
      const pct = Math.round((Math.abs(c.amount) / totalAbs) * 100);
      const tr = document.createElement('tr');
      const dot = '<span class="cat-dot" style="background:' + c.color + '"></span>';
      tr.innerHTML =
        '<td>' + dot + '<span class="cat-name">' + esc(c.name) + '</span></td>' +
        '<td class="r ' + (c.amount >= 0 ? 'income' : 'expense') + '">' + fmtYuan(c.amount) + '</td>' +
        '<td class="r">' + c.count + '</td>' +
        '<td><span class="fin-bar-pct" style="width:' + pct + 'px"></span>' + pct + '%</td>';
      cb.appendChild(tr);
    }
    catSec.style.display = 'block';
  } else {
    catSec.style.display = 'none';
  }

  // 月份下拉
  const sel = $('#finMonth');
  const curVal = sel.value || data.month;
  sel.innerHTML = '';
  for (const m of aggMonths) {
    const o = document.createElement('option');
    o.value = m.month;
    o.textContent = m.month;
    sel.appendChild(o);
  }
  if (aggMonths.some((m) => m.month === curVal)) sel.value = curVal;
  else if (aggMonths.length) sel.value = aggMonths[0].month;
}

let financeBusy = false;

function financeStamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes());
}

async function loadFinanceCosts() {
  if (!window.pdd.financeCostList) return;
  try {
    const r = await window.pdd.financeCostList();
    if (r && r.ok) {
      state.costs = r.items || [];
      state.costTotal = Number.isFinite(Number(r.total))
        ? Number(r.total)
        : (state.costs || []).reduce((n, c) => n + (Number(c.amount) || 0), 0);
      if (state.finance) renderFinance(state.finance);
    }
  } catch (_) { /* ignore */ }
}

async function loadFinanceLast() {
  if (!window.pdd.financeLast) return;
  try {
    const r = await window.pdd.financeLast();
    if (!r || !r.ok || !r.data) return;
    state.finance = r.data;
    state.financeLastAt = Number((r.index && r.index.lastCollectedAt) || r.data.collectedAt || 0);
    const at = (r.index && r.index.lastCollectedAt) || r.data.collectedAt;
    const dd = (r.index && r.index.dataDate) || null;
    const dm = (r.index && r.index.dataMonth) || r.data.month || null;
    $('#finSub').textContent = '上次采集 ' + financeStamp(at) +
      ' ｜ 数据' + (dd ? ('截至 ' + dd) : (dm ? ('月份 ' + dm) : '—'));
    renderFinance(r.data);
  } catch (_) { /* ignore */ }
}

async function loadFinanceOrderLast() {
  if (!window.pdd.financeOrdersLast) return;
  try {
    const r = await window.pdd.financeOrdersLast();
    if (r && r.ok && r.data) {
      state.orderData = r.data;
      renderOrderContribution(r.data);
      // 顶部「本月毛利 / 待退货金额」也算自订单，订单到位后要把卡片重画一次
      if (state.finance) renderFinance(state.finance);
    }
  } catch (_) { /* ignore */ }
}

async function loadFinanceProductCosts() {
  if (!window.pdd.financeProductCostList) return;
  try {
    const r = await window.pdd.financeProductCostList();
    if (r && r.ok) {
      state.productCosts = r.items || [];
      if (state.orderData) renderOrderContribution(state.orderData);
    }
  } catch (_) { /* ignore */ }
}

function productCostUnit(goodsId, name) {
  const n = String(name || '').replace(/\s+/g, '');
  for (const p of (state.productCosts || [])) {
    if (goodsId && String(p.goodsId || '') === String(goodsId)) return Number(p.unitCost);
    const pn = String(p.productName || p.productTitle || '').replace(/\s+/g, '');
    if (pn && n && (pn === n || n.indexOf(pn) >= 0 || pn.indexOf(n) >= 0)) return Number(p.unitCost);
  }
  return null;
}

/**
 * 订单快照里每单都带 thumbUrl（平台 CDN）。商品贡献表优先用采集箱图，
 * 采集箱没有（比如没采过、或采的是同款别的链接）就退到订单图，
 * 再没有才显示首字占位。索引按 goodsId 建，name 兜底。
 */
function buildOrderThumbIndex(data) {
  const byId = new Map();
  const byName = new Map();
  for (const s of (data && data.stores) || []) {
    for (const o of (s.orders || [])) {
      const u = o && o.thumbUrl;
      if (!u) continue;
      const id = String(o.goodsId || '');
      if (id && !byId.has(id)) byId.set(id, u);
      const n = String(o.goodsName || '').replace(/\s+/g, '');
      if (n && !byName.has(n)) byName.set(n, u);
    }
  }
  state._orderThumbs = { byId, byName };
}

function poolThumbFor(goodsId, name) {
  const id = String(goodsId || '');
  const n = String(name || '').replace(/\s+/g, '');
  let hit = (state.pool || []).find((it) => id && String(it.sourceGoodsId || '') === id);
  if (!hit) {
    hit = (state.pool || []).find((it) => {
      const t = String(it.title || '').replace(/\s+/g, '');
      return n && t && (t === n || n.indexOf(t) >= 0 || t.indexOf(n) >= 0);
    });
  }
  if (hit) {
    const u = hit.thumb || (hit.gallery && hit.gallery[0]) || '';
    if (u) return u;
  }
  const idx = state._orderThumbs;
  if (idx) {
    if (id && idx.byId.has(id)) return idx.byId.get(id);
    if (n && idx.byName.has(n)) return idx.byName.get(n);
  }
  return '';
}

function actualPlatformFee(data) {
  let sum = 0;
  let found = false;
  const dates = new Set();
  for (const s of (data && data.stores) || []) {
    for (const day of (s.days || [])) {
      for (const row of (day.rows || [])) {
        if (row.group === '技术服务费' || row.group === '其他服务') {
          const n = -Number(row.amount) || 0;
          if (n) { sum += n; found = true; if (day.date) dates.add(String(day.date)); }
        }
      }
    }
  }
  return found ? { sum, dates } : null;
}

async function loadFinanceFeeSettings() {
  if (!window.pdd.financeFeeGet) return;
  try {
    const r = await window.pdd.financeFeeGet();
    if (r && r.ok && r.data) {
      state.feeSettings = r.data;
      if (state.orderData) renderOrderContribution(state.orderData);
    }
  } catch (_) { /* ignore */ }
}

function costUnitMap() {
  const m = new Map();
  for (const c of (state.costs || [])) {
    const key = String(c.productTitle || '').trim();
    if (!key) continue;
    if (!m.has(key)) m.set(key, { qty: 0, cost: 0 });
    const x = m.get(key);
    x.qty += Number(c.quantity) || 0;
    x.cost += Number(c.totalCost) || 0;
  }
  const out = new Map();
  for (const [k, v] of m) out.set(k, v.qty > 0 ? v.cost / v.qty : null);
  return out;
}

function findCostUnit(name, map) {
  const n = String(name || '').replace(/\s+/g, '');
  if (!n) return null;
  for (const [k, v] of map) {
    if (String(k).replace(/\s+/g, '') === n) return v;
  }
  for (const [k, v] of map) {
    const kn = String(k).replace(/\s+/g, '');
    if (kn && (n.indexOf(kn) >= 0 || kn.indexOf(n) >= 0)) return v;
  }
  return null;
}

/**
 * 订单归类。商品贡献表、顶部「本月毛利」「待退货金额」必须用同一套判断，
 * 否则卡片和表里的数会对不上。改这里等于同时改三处口径。
 */
function classifyOrder(o, asMap) {
  const asList = asMap.get(o.orderSn) || [];
  const asType = asList.map((a) => String(a.typeName || '')).join(' ');
  const statusText = String(o.status || '');
  const refunded = /退款成功/.test(statusText);
  const cancelled = /已取消/.test(statusText);
  const isExchange = /换货/.test(asType);
  const isOnly = /仅退款/.test(asType);
  const isReturn = /退货/.test(asType);
  return {
    asList, asType, statusText, refunded, cancelled, isExchange, isOnly, isReturn,
    excluded: refunded || cancelled || isReturn || isOnly,
    pendingReturn: isReturn && !refunded,
  };
}

/** orderSn -> 售后记录[]（接口只能取到待处理，已完成退款靠订单状态判断） */
function buildAfterSaleIndex(data) {
  const asMap = new Map();
  for (const s of (data.stores || [])) {
    for (const a of (s.afterSales || [])) {
      if (!a || !a.orderSn) continue;
      if (!asMap.has(a.orderSn)) asMap.set(a.orderSn, []);
      asMap.get(a.orderSn).push(a);
    }
  }
  return asMap;
}

/**
 * 只算顶部卡片要的三个数：本月实收、本月成本、在途退货金额。
 * 不走整张贡献表（那张表还要算账单分摊、退货率、DOM 渲染，卡片用不着）。
 * 归类谓词复用 classifyOrder，保证口径一致。
 */
function computeContribution(data) {
  if (data && Array.isArray(data.stores)) {
    data = Object.assign({}, data, { stores: keepActiveStores(data.stores) });
  }
  const asMap = buildAfterSaleIndex(data);
  const rows = [];
  for (const s of (data.stores || [])) {
    for (const o of (s.orders || [])) {
      const f = classifyOrder(o, asMap);
      const unit = productCostUnit(o.goodsId, o.goodsName);
      rows.push({
        unit,
        orderTime: o.orderTime,
        orderAmount: Number(o.orderAmount) || 0,
        quantity: Number(o.quantity) || 0,
        excluded: f.excluded,
        pendingReturn: f.pendingReturn,
      });
    }
  }
  return { rows };
}

function renderCostBlock() {
  const body = $('#finCostBody');
  const totalEl = $('#costTotalInline');
  if (!body) return;
  const rows = (state.costs || [])
    .slice()
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const total = rows.reduce((n, c) => n + (Number(c.amount) || 0), 0);
  if (totalEl) totalEl.textContent = fmtYuan(total);
  body.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" style="color:#7d8aa3">还没有进货记录。填上面的日期和金额，点「记一笔」。</td>';
    body.appendChild(tr);
    return;
  }
  for (const c of rows) {
    const tr = document.createElement('tr');
    const yi = document.createElement('input');
    yi.type = 'number';
    yi.className = 'fin-cost-input cost-inline-wide';
    yi.min = '0';
    yi.step = '0.01';
    yi.value = (Number(c.amount) || 0) / 100;
    yi.dataset.costId = c.id;
    yi.dataset.orig = String((Number(c.amount) || 0) / 100);
    yi.title = '改完失焦即保存';
    const note = document.createElement('input');
    note.type = 'text';
    note.className = 'fin-cost-input';
    note.value = c.note || '';
    note.placeholder = '备注';
    note.dataset.costNoteId = c.id;
    note.dataset.orig = c.note || '';
    note.title = '改完失焦即保存';
    const tdDate = document.createElement('td');
    tdDate.textContent = c.date || '';
    const tdAmt = document.createElement('td');
    tdAmt.className = 'r';
    tdAmt.appendChild(yi);
    const tdNote = document.createElement('td');
    tdNote.appendChild(note);
    const tdOp = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'cost-del';
    del.textContent = '删除';
    del.dataset.costDel = c.id;
    tdOp.appendChild(del);
    tr.append(tdDate, tdAmt, tdNote, tdOp);
    body.appendChild(tr);
  }
}

function renderOrderContribution(data) {
  // 先建订单缩略图索引，否则首屏会渲染成首字占位（索引此前是在 renderFinance 里才建的）
  buildOrderThumbIndex(data);
  const sec = $('#finOrderSec');
  const body = $('#finOrderBody');
  const note = $('#finOrderNote');
  if (!sec || !body) return;
  // 同上：订单快照也可能含已移除店铺
  if (data && Array.isArray(data.stores)) {
    data = Object.assign({}, data, { stores: keepActiveStores(data.stores) });
  }
  // 账单平台费只覆盖账单里出现的日期。先算出来，供下面按日期分段使用。
  const billFee = actualPlatformFee(state.finance);
  const billDates = billFee ? billFee.dates : null;
  // 售后单索引：orderSn -> 售后记录（接口只能取到待处理，已完成退款靠订单状态判断）
  const asMap = new Map();
  for (const s of (data.stores || [])) {
    for (const a of (s.afterSales || [])) {
      if (!a || !a.orderSn) continue;
      if (!asMap.has(a.orderSn)) asMap.set(a.orderSn, []);
      asMap.get(a.orderSn).push(a);
    }
  }
  const groups = new Map();
  for (const s of (data.stores || [])) {
    for (const o of (s.orders || [])) {
      const key = s.mallId + '|' + (o.goodsId || o.goodsName);
      if (!groups.has(key)) groups.set(key, {
        mallName: s.mallName, goodsId: o.goodsId, name: o.goodsName || '(未命名商品)',
        orders: 0, qty: 0, costQty: 0, lossQty: 0, revenue: 0, afterSale: 0, lastSaleAt: 0,
        totalQty: 0, totalOrders: 0,
        billValidOrders: 0, nonBillRevenue: 0,
        refundedOrders: 0, pendingReturn: 0, cancelledCount: 0, excludedOrders: 0, returnCount: 0, onlyRefundCount: 0, exchangeCount: 0, refundAmount: 0, pendingRefundAmount: 0, returnEvents: 0,
      });
      const g = groups.get(key);
      const f = classifyOrder(o, asMap);

      g.orders += 1;
      if (f.isExchange) g.exchangeCount += 1;
      if (f.isOnly) g.onlyRefundCount += 1;
      else if (f.isReturn) g.returnCount += 1;
      if (f.refunded) g.refundedOrders += 1;
      if (f.cancelled) g.cancelledCount += 1;
      if (f.pendingReturn) g.pendingReturn += 1;
      // 退货事件：一单只记一次（退款/在途退货/仅退款 可能同时命中多个标记，不能相加）
      if (f.refunded || f.isReturn || f.isOnly) g.returnEvents += 1;
      // 总销量/总成交单：剔除取消单（未成交），退款单仍算进总销量，用来算退货率
      if (!f.cancelled) {
        g.totalQty += Number(o.quantity) || 0;
        g.totalOrders += 1;
      }
      if (f.excluded) {
        g.excludedOrders += 1;
        g.refundAmount += Number(o.orderAmount) || 0;
        if (f.pendingReturn) g.pendingRefundAmount += Number(o.orderAmount) || 0;
      } else {
        g.qty += Number(o.quantity) || 0;
        g.revenue += Number(o.orderAmount) || 0;
        // 账单覆盖到的日期用账单口径；其余日期只能回退到费率估算
        const dayKey = o.orderTime ? localDateStr(new Date(Number(o.orderTime) * 1000)) : '';
        if (billDates && dayKey && billDates.has(dayKey)) g.billValidOrders += 1;
        else g.nonBillRevenue += Number(o.orderAmount) || 0;
        if (Number(o.quantity) > 0 && o.orderTime) g.lastSaleAt = Math.max(g.lastSaleAt, Number(o.orderTime));
      }
      // 仅退款：钱退了但货没回来，拿货成本按货损计入；其余退款/取消不计成本
      if (!f.excluded) g.costQty += Number(o.quantity) || 0;
      else if (f.isOnly) { g.costQty += Number(o.quantity) || 0; g.lossQty += Number(o.quantity) || 0; }
      if (o.afterSaleStatus !== null && o.afterSaleStatus !== undefined) g.afterSale += 1;
    }
  }
  // 把采集箱中尚未出单的商品并入折叠区，保证“其他商品”可展开
  const knownGoods = new Set([...groups.values()].map((g) => String(g.goodsId || '')));
  const knownNames = new Set([...groups.values()].map((g) => String(g.name || '').replace(/\s+/g, '')));
  for (const it of (state.pool || [])) {
    const gid = String(it.sourceGoodsId || '');
    const nm = String(it.title || '').replace(/\s+/g, '');
    if (!gid && !nm) continue;
    if ((gid && knownGoods.has(gid)) || (!gid && knownNames.has(nm))) continue;
    const key = 'pool|' + (gid || nm);
    if (groups.has(key)) continue;
    groups.set(key, {
      mallName: '采集箱', goodsId: gid, name: it.title || '(未命名商品)',
      // 采集箱行没有订单，计数器必须全部初始化，否则 tooltip 会显示 undefined
      orders: 0, qty: 0, costQty: 0, lossQty: 0, revenue: 0, afterSale: 0, lastSaleAt: 0,
      totalQty: 0, totalOrders: 0,
      refundedOrders: 0, pendingReturn: 0, cancelledCount: 0, excludedOrders: 0,
      returnCount: 0, onlyRefundCount: 0, exchangeCount: 0, refundAmount: 0, returnEvents: 0,
      catalog: true,
    });
  }
  // 采集箱行没有订单，账单相关计数也要初始化
  const unitCosts = costUnitMap();
  let orderCount = 0;
  let totalRevenue = 0;
  let platformFeeTotal = 0;
  const fs = state.feeSettings || {};
  const platformRate = Number(fs.platformRate) || 0;
  for (const s of (data.stores || [])) {
    for (const o of (s.orders || [])) {
      orderCount += 1;
      totalRevenue += Number(o.orderAmount) || 0;
      platformFeeTotal += Math.round((Number(o.orderAmount) || 0) * platformRate);
    }
  }
  // 账单日期内的订单数与实收（含退款单，因为费用是下单时收的）
  let billOrderCount = 0;
  let billRevenue = 0;
  if (billDates) {
    for (const s of (data.stores || [])) {
      for (const o of (s.orders || [])) {
        if (!o.orderTime) continue;
        const d = localDateStr(new Date(Number(o.orderTime) * 1000));
        if (billDates.has(d)) { billOrderCount += 1; billRevenue += Number(o.orderAmount) || 0; }
      }
    }
  }
  const useBillFee = !!billFee && billFee.sum > 0 && billOrderCount > 0;
  // 账单日期内的每单平均费；只用于账单日期内的订单，不外推到其它日期
  const avgBillFee = useBillFee ? Math.round(billFee.sum / billOrderCount) : 0;
  // 全店平台费合计 = 账单日期内按账单均值 + 其余日期按费率估。显示必须用合计，否则会低估。
  const platformFeeSum = useBillFee
    ? avgBillFee * billOrderCount + Math.round(Math.max(0, totalRevenue - billRevenue) * platformRate)
    : platformFeeTotal;
  const avgPlatform = orderCount ? Math.round(platformFeeSum / orderCount) : 0;
  const avgPromo = Number(fs.promotionPerOrder) || 0;
  const avgShip = Number(fs.shippingPerOrder) || 0;
  const avgPack = Number(fs.packagingPerOrder) || 0;
  const avgFee = orderCount ? avgPlatform + avgPromo + avgShip + avgPack : null;
  if ($('#feePlatform')) $('#feePlatform').value = (platformRate * 100).toFixed(2);
  if ($('#feePromo')) $('#feePromo').value = (avgPromo / 100).toFixed(2);
  if ($('#feeShip')) $('#feeShip').value = (avgShip / 100).toFixed(2);
  if ($('#feePack')) $('#feePack').value = (avgPack / 100).toFixed(2);
  if ($('#feeAvg')) $('#feeAvg').textContent = avgFee == null ? '—' : fmtYuan(avgFee);
  // 口径提示：账单只覆盖部分日期时，其余日期是费率估算，必须写清楚
  const billDays = billDates ? billDates.size : 0;
  const feeBasis = !useBillFee
    ? ' 估'
    : (billOrderCount >= orderCount ? ' 账单' : ' 账单 ' + billDays + ' 天 + 其余按费率估');
  if ($('#feeDetail')) $('#feeDetail').textContent = orderCount
    ? ('平台 ' + fmtYuan(avgPlatform) + feeBasis + ' · 推广 ' + fmtYuan(avgPromo) + ' · 快递 ' + fmtYuan(avgShip) + ' · 包装 ' + fmtYuan(avgPack))
    : '';

  const rows = [...groups.values()].map((g) => {
    const pUnit = productCostUnit(g.goodsId, g.name);
    const unit = pUnit == null ? findCostUnit(g.name, unitCosts) : pUnit;
    const cost = unit == null ? null : Math.round(unit * g.costQty);
    const gross = cost == null ? null : g.revenue - cost;
    const validOrders = Math.max(0, g.orders - g.excludedOrders);
    // 账单日期内的有效单用账单均值；账单外的日期回退到费率估算。两者相加，不互相外推。
    const platformFee = useBillFee
      ? avgBillFee * g.billValidOrders + Math.round(g.nonBillRevenue * platformRate)
      : Math.round(g.revenue * platformRate);
    const fixedFees = (avgPromo + avgShip + avgPack) * validOrders;
    const net = gross == null ? null : gross - platformFee - fixedFees;
    const margin = cost == null || !g.revenue ? null : gross / g.revenue;
    const loss = unit == null || !g.lossQty ? null : Math.round(unit * g.lossQty);
    // 退货率：退货事件 / 成交单（已剔除取消单）；分子按单去重，不叠加各类标记
    const returnOrders = g.returnEvents;
    const returnRate = g.totalOrders > 0 ? returnOrders / g.totalOrders : null;
    return { ...g, unit, cost, gross, net, platformFee, fixedFees, margin, validOrders, loss, returnOrders, returnRate, hasCost: unit != null };
  }).sort((a, b) => b.revenue - a.revenue);
  sec.style.display = 'block';
  note.textContent = '近 ' + ((data.range && data.range.days) || 90) + ' 天 · 退款订单不计获利 · 单价可直接改'
    + (data.truncated ? ' · 已达上限，数据可能不全' : '');
  body.innerHTML = '';
  const otherBody = $('#finOrderOtherBody');
  if (otherBody) otherBody.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="8" style="color:#7d8aa3">没有读到订单</td></tr>';
    return;
  }
  const activeRows = rows.filter((r) => r.qty > 0 && r.revenue > 0 && r.lastSaleAt && (Date.now() / 1000 - r.lastSaleAt <= 21 * 86400));
  const otherRows = rows.filter((r) => !activeRows.includes(r));
  const appendRow = (target, r, i) => {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', String(Math.min(i == null ? 0 : i, 12)));
    const thumb = poolThumbFor(r.goodsId, r.name);
    const thumbHtml = thumb
      ? '<img class="order-thumb" loading="lazy" src="' + esc(thumb) + '" alt="" />'
      : '<span class="order-thumb order-thumb-empty">' + esc(String(r.name || '?').slice(0, 1)) + '</span>';
    const rateTitle = '退款 ' + r.refundedOrders + ' · 在途 ' + r.pendingReturn + ' · 仅退 ' + r.onlyRefundCount +
      ' · 取消 ' + r.cancelledCount + '（取消不计入退货率）';
    const rateCls = r.returnRate == null ? '' : (r.returnRate >= 0.6 ? ' expense' : (r.returnRate >= 0.3 ? ' fin-rate-warn' : ''));
    tr.innerHTML =
      '<td><div class="order-product">' + thumbHtml +
        '<div class="order-main">' +
          '<span class="order-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span>' +
          (r.goodsId ? '<span class="order-id">' + esc(r.goodsId) + '</span>' : '') +
        '</div></div></td>' +
      '<td class="fin-store" title="' + esc(r.mallName) + '">' + esc(r.mallName) + '</td>' +
      '<td class="r">' + r.qty + '<span class="fin-sub-in">/' + r.totalQty + '</span></td>' +
      '<td class="r' + rateCls + '" title="' + esc(rateTitle) + '">' +
        (r.returnRate == null ? '—' : (r.returnRate * 100).toFixed(1) + '%') +
        '<span class="fin-sub-in">' + r.returnOrders + '/' + r.totalOrders + '</span></td>' +
      '<td class="r income">' + fmtYuan(r.revenue) +
        (r.refundAmount
          ? '<div class="fin-sub">−' + fmtYuan(r.refundAmount) + '</div>'
          : '') + '</td>' +
      '<td class="r cost-cell">' +
        '<span class="cost-inline-wrap"><input class="cost-inline" type="number" min="0" step="0.01" ' +
          'data-goods-id="' + esc(r.goodsId || '') + '" data-name="' + esc(r.name) + '" ' +
          'value="' + (r.unit == null ? '' : (r.unit / 100).toFixed(2)) + '" placeholder="单价" /></span>' +
        '<div class="cost-total ' + (r.hasCost ? '' : 'muted') + '">' + (r.hasCost ? fmtYuan(r.cost) : '未填') +
          (r.loss != null ? ' <span class="expense">货损 ' + fmtYuan(r.loss) + '</span>' : '') + '</div>' +
      '</td>' +
      '<td class="r ' + (r.gross != null && r.gross < 0 ? 'expense' : 'income') + '">' +
        (r.gross == null ? '—' : fmtYuan(r.gross)) +
        (r.margin == null ? '' : '<span class="fin-sub-in">' + (r.margin * 100).toFixed(1) + '%</span>') + '</td>' +
      '<td class="r ' + (r.net != null && r.net < 0 ? 'expense' : 'income') + '">' + (r.net == null ? '—' : fmtYuan(r.net)) + '</td>';
    target.appendChild(tr);
  };
  activeRows.forEach((r, i) => appendRow(body, r, i));
  if (!activeRows.length) {
    body.innerHTML = '<tr><td colspan="8" style="color:#7d8aa3">暂无近 21 天动销商品</td></tr>';
  }
  if (otherBody) {
    // 懒渲染：收起时不建 DOM。折叠区曾有 59 行 × 20 节点 = 1170 个隐藏节点，
    // 占整页 DOM 的 42%，display:none 只省绘制、不省内存与样式重算。
    if (state.orderShowAll) {
      for (const r of otherRows) appendRow(otherBody, r);
      otherBody.style.display = '';
    } else {
      otherBody.innerHTML = '';
      otherBody.style.display = 'none';
    }
  }
  const more = $('#finOrderMore');
  if (more) {
    more.style.display = otherRows.length ? 'inline-block' : 'none';
    more.textContent = (state.orderShowAll ? '收起其他商品' : '展开 21 天前/未动销 ' + otherRows.length + ' 个商品');
  }
}

function renderReturns(data) {
  const sec = $('#finReturnSec');
  const body = $('#finReturnBody');
  const note = $('#finReturnNote');
  const empty = $('#returnEmpty');
  if (!sec || !body) return;
  // 退货清单是落盘的，可能含已移除店铺
  const activeIds = new Set((state.malls || []).map((m) => m.id));
  const all = ((data && data.rows) || []).filter((r) => !r || !r.mallId || !activeIds.size || activeIds.has(r.mallId));
  // 店铺筛选下拉：选项从数据里生成，保留当前选择
  const sel = $('#rtMallFilter');
  if (sel) {
    const names = [...new Set(all.map((r) => r.mallName).filter(Boolean))].sort();
    const cur = state.returnsMall || '';
    const want = ['<option value="">全部店铺</option>'].concat(
      names.map((n) => '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>')
    ).join('');
    if (sel.innerHTML !== want) sel.innerHTML = want;
    if (cur && !names.includes(cur)) { state.returnsMall = ''; sel.value = ''; }
  }
  const byMall = state.returnsMall ? all.filter((r) => r.mallName === state.returnsMall) : all;
  const onlyRecent = $('#rtWithin21') ? $('#rtWithin21').checked : true;
  const filtered = onlyRecent ? byMall.filter((r) => r.within21) : byMall;
  // 导出用「过滤后的全集」，不是分页渲染出来的那一截
  state.returnsFiltered = filtered;
  // 懒渲染：110 行 × 18 节点 ≈ 1980，占满整页 DOM 预算。
  // 默认只渲染前 30 行，其余点「显示更多」再插入。
  const RETURNS_PAGE = 30;
  const limit = Math.max(RETURNS_PAGE, state.returnsLimit || RETURNS_PAGE);
  const rows = filtered.slice(0, limit);
  if (!filtered.length) {
    sec.style.display = 'none';
    body.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    if (note) note.textContent = all.length ? '21 天内没有退货单' : '还没读取';
    const more0 = $('#finReturnMore');
    if (more0) more0.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  sec.style.display = 'block';
  // 统计按「过滤后的全集」算，不能按分页渲染出来的那一截算。
  // 口径按可操作性排：已签收（货回来了）→ 风险（钱退了、货没确认回）→ 无需退货。
  const hidden = all.length - filtered.length;
  const rest = filtered.length - rows.length;
  const signedCount = filtered.filter((r) => r.signed === true).length;
  const noReturn = filtered.filter((r) => r.signedText === '无退货包裹').length;
  // 风险 = 已完成退款 + 需要退货 + 没确认签收（含在途、无轨迹、未知）
  const risk = filtered.filter((r) =>
    r.stage === 'done' && r.needReturn !== false && r.signed !== true).length;
  const inTransit = filtered.filter((r) =>
    r.stage !== 'done' && r.signedText !== '无退货包裹').length;
  const parts = [filtered.length + ' 单', '已签收 ' + signedCount];
  if (risk) parts.push('待确认收货 ' + risk);
  if (inTransit) parts.push('在途 ' + inTransit);
  if (noReturn) parts.push('无退货包裹 ' + noReturn);
  if (hidden) parts.push('已隐藏 ' + hidden + ' 单');
  if (note) note.textContent = parts.join(' · ');
  const more = $('#finReturnMore');
  if (more) {
    if (rest > 0) {
      more.style.display = 'inline-block';
      more.textContent = '再显示 ' + Math.min(RETURNS_PAGE, rest) + ' 单（还有 ' + rest + ' 单）';
    } else if (limit > RETURNS_PAGE) {
      more.style.display = 'inline-block';
      more.textContent = '收起，只显示前 ' + RETURNS_PAGE + ' 单';
    } else {
      more.style.display = 'none';
    }
  }
  body.innerHTML = '';
  let _ri = 0;
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.style.setProperty('--i', String(Math.min(_ri++, 12)));
    const signCls = r.signed === true ? 'ok'
      : (r.signed === false ? 'wait'
      : (r.signedText === '无退货包裹' ? 'na' : 'unknown'));
    const thumb = r.thumbUrl
      ? '<img class="order-thumb" loading="lazy" src="' + esc(r.thumbUrl) + '" alt="" />'
      : '<span class="order-thumb order-thumb-empty">' + esc(String(r.goodsName || '?').slice(0, 1)) + '</span>';
    tr.innerHTML =
      '<td><div class="order-product">' + thumb +
        '<div style="min-width:0"><div class="order-name" title="' + esc(r.goodsName || '') + '">' +
          esc(String(r.goodsName || '—').slice(0, 18)) + '</div>' +
          '<div class="fin-sub">' + esc(r.orderSn) + ' · ' + (r.days == null ? '—' : r.days + ' 天前') + '</div></div></div></td>' +
      '<td class="fin-store" title="' + esc(r.mallName || '') + '">' + esc(r.mallName || '—') + '</td>' +
      '<td><span class="rt-stage rt-stage-' + esc(r.stage || 'pending') + '">' + esc(r.stageText || '—') + '</span>' +
        '<div class="rt-sign rt-sign-' + signCls + '"' +
          (r.traceNode ? ' title="' + esc((r.traceNode || '') + (r.traceTime ? ' · ' + r.traceTime : '')) + '"' : '') + '>' +
          esc(r.signedText || '未知') +
        '</div></td>' +
      '<td><input class="rt-sn' + (r.returnSn ? '' : ' empty') + '" value="' + esc(r.returnSn || '') + '" placeholder="填退货单号" ' +
        'data-order-sn="' + esc(r.orderSn) + '" /></td>' +
      '<td><input class="rt-carrier" value="' + esc(r.carrier || '') + '" placeholder="填快递" ' +
        'data-order-sn="' + esc(r.orderSn) + '" data-carrier-id="' + (r.carrierId || '') + '" /></td>' +
      '<td class="r expense">' + fmtYuan(r.refundAmount) + '</td>' +
      '<td class="r rt-check-cell"><button class="rt-check' + (r.done ? ' done' : '') + '" ' +
        'data-order-sn="' + esc(r.orderSn) + '" data-done="' + (r.done ? '1' : '0') + '" ' +
        'title="' + (r.done ? '已退货完成' : '点一下标记已退货完成') + '">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>' +
      '</button></td>';
    body.appendChild(tr);
  }
}

let returnsBusy = false;
async function loadReturns() {
  if (!window.pdd.financeReturns) return;
  try {
    const r = await window.pdd.financeReturns();
    if (r && r.ok) { state.returns = r; renderReturns(r); }
  } catch (_) { /* ignore */ }
}

// ------------------------------------------------------------------ 申诉文案库
const TPL_KIND_TEXT = { reject: '驳回', evidence: '举证', appeal: '申诉' };

async function loadAppealScenes() {
  if (!window.pdd.appealScenes) return;
  try {
    const r = await window.pdd.appealScenes();
    if (r && r.ok) {
      state.appealScenes = r.items || [];
      const sel = $('#tplScene');
      if (sel) {
        sel.innerHTML = '';
        for (const s of state.appealScenes) {
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = s.name;
          sel.appendChild(o);
        }
      }
    }
  } catch (_) { /* ignore */ }
}

async function loadAppealTemplates() {
  if (!window.pdd.appealTemplates) return;
  try {
    const r = await window.pdd.appealTemplates();
    if (r && r.ok) {
      state.appealTemplates = r.items || [];
      renderTemplates();
    }
  } catch (_) { /* ignore */ }
}

function sceneName(id) {
  const s = (state.appealScenes || []).find((x) => x.id === id);
  return s ? s.name : '其他';
}

function renderTemplates() {
  const box = $('#rtTplList');
  if (!box) return;
  const kw = String(($('#rtTplSearch') && $('#rtTplSearch').value) || '').trim().toLowerCase();
  let items = state.appealTemplates || [];
  if (kw) {
    items = items.filter((t) =>
      String(t.title || '').toLowerCase().includes(kw) ||
      String(t.body || '').toLowerCase().includes(kw));
  }
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<div class="big-empty" style="display:flex"><div class="be-icon">📝</div>'
      + '<p>' + (kw ? '没有匹配的文案' : '还没有文案') + '</p>'
      + '<p class="be-sub">点右上「＋ 新建文案」自己攒，或清空搜索看内置骨架</p></div>';
    return;
  }
  // 按场景分组
  const groups = new Map();
  for (const t of items) {
    const k = t.scene || 'generic';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const order = (state.appealScenes || []).map((s) => s.id);
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  // 每组默认只渲染 3 条：一条文案 ≈80 节点，全量渲染 20 条就会顶破 DOM 预算。
  const PER_GROUP = 3;
  const expand = state.tplExpand || (state.tplExpand = new Set());
  for (const k of keys) {
    const all = groups.get(k);
    const shown = expand.has(k) ? all : all.slice(0, PER_GROUP);
    const h = document.createElement('div');
    h.className = 'tpl-group-h';
    h.textContent = sceneName(k) + '（' + all.length + '）';
    box.appendChild(h);
    for (const t of shown) {
      const card = document.createElement('div');
      card.className = 'tpl-card';
      card.innerHTML =
        '<div class="tpl-card-h">'
          + '<span class="tpl-title" title="' + esc(t.title) + '">' + esc(t.title) + '</span>'
          + '<span class="tpl-kind ' + esc(t.kind || 'reject') + '">' + esc(TPL_KIND_TEXT[t.kind] || '驳回') + '</span>'
        + '</div>'
        + '<div class="tpl-body" data-body>' + esc(t.body || '') + '</div>'
        + ((t.evidence || []).length
          ? '<div class="tpl-ev"><b>举证清单</b><ol>'
            + (t.evidence || []).map((e) => '<li>' + esc(e) + '</li>').join('')
            + '</ol></div>'
          : '')
        + '<div class="tpl-actions">'
          + '<button class="btn primary" data-act="copy">复制正文</button>'
          + '<button class="btn" data-act="edit">编辑</button>'
          + '<button class="btn ghost" data-act="del">删除</button>'
        + '</div>';
      card.querySelector('[data-body]').addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('open');
      });
      card.querySelectorAll('[data-act]').forEach((b) => {
        b.addEventListener('click', () => onTplAction(b.dataset.act, t));
      });
      box.appendChild(card);
    }
    if (all.length > shown.length) {
      const more = document.createElement('button');
      more.className = 'fin-order-more';
      more.textContent = '展开该场景其余 ' + (all.length - shown.length) + ' 条';
      more.addEventListener('click', () => {
        expand.add(k);
        renderTemplates();
      });
      box.appendChild(more);
    } else if (expand.has(k) && all.length > PER_GROUP) {
      const less = document.createElement('button');
      less.className = 'fin-order-more';
      less.textContent = '收起';
      less.addEventListener('click', () => {
        expand.delete(k);
        renderTemplates();
      });
      box.appendChild(less);
    }
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch (e) {
      return false;
    }
  }
}

async function onTplAction(act, t) {
  if (act === 'copy') {
    const text = String(t.body || '');
    if (!text.trim()) { logWarn('这条没有内容可复制'); return; }
    const ok = await copyText(text);
    if (ok) logOk('已复制正文：' + String(t.title || '').slice(0, 20));
    else logErr('复制失败，请手动选中文本复制');
    return;
  }
  if (act === 'edit') { openTplDialog(t); return; }
  if (act === 'del') {
    if (!window.confirm('删除这条文案？\n\n' + String(t.title || ''))) return;
    const r = await window.pdd.appealTemplateDelete(t.id);
    if (r && r.ok) { logOk('已删除'); await loadAppealTemplates(); }
    else logErr('删除失败：' + ((r && r.error) || '未知'));
  }
}

function openTplDialog(tpl) {
  return withViewHidden(() => new Promise((resolve) => {
    const mask = $('#tplMask');
    const err = $('#tplErr');
    const isEdit = !!tpl;
    $('#tplModalTitle').textContent = isEdit ? '编辑申诉文案' : '新建申诉文案';
    $('#tplTitle').value = isEdit ? (tpl.title || '') : '';
    $('#tplScene').value = isEdit ? (tpl.scene || 'generic') : 'generic';
    $('#tplKind').value = isEdit ? (tpl.kind || 'reject') : 'reject';
    $('#tplBody').value = isEdit ? (tpl.body || '') : '';
    $('#tplEvidence').value = isEdit ? (tpl.evidence || []).join('\n') : '';
    err.textContent = '';
    mask.classList.add('on');
    setTimeout(() => { try { $('#tplTitle').focus(); } catch (_) { /* ignore */ } }, 80);

    const done = (v) => {
      mask.classList.remove('on');
      $('#tplSave').onclick = null;
      $('#tplCancel').onclick = null;
      resolve(v);
    };
    $('#tplCancel').onclick = () => done(null);
    $('#tplSave').onclick = async () => {
      const payload = {
        id: isEdit ? tpl.id : null,
        title: $('#tplTitle').value.trim(),
        scene: $('#tplScene').value,
        kind: $('#tplKind').value,
        body: $('#tplBody').value,
        evidence: $('#tplEvidence').value.split('\n').map((x) => x.trim()).filter(Boolean),
      };
      if (!payload.title) { err.textContent = '标题不能为空'; return; }
      if (!payload.body.trim()) { err.textContent = '正文不能为空'; return; }
      try {
        const r = await window.pdd.appealTemplateSave(payload);
        if (!r || !r.ok) { err.textContent = (r && r.error) || '保存失败'; return; }
        logOk((isEdit ? '已更新' : '已新建') + '文案：' + payload.title.slice(0, 20));
        await loadAppealTemplates();
        done(true);
      } catch (e) {
        err.textContent = (e && e.message) || String(e);
      }
    };
  }));
}

function setRtTab(name) {
  state.rtTab = name;
  $$('.rt-tab').forEach((b) => b.classList.toggle('active', b.dataset.rt === name));
  const map = { list: '#rtViewList', triage: '#rtViewTriage', tpl: '#rtViewTpl' };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel);
    if (el) el.style.display = k === name ? '' : 'none';
  }
  // 三个 Tab 的内容不能同时留在 DOM：加起来会顶破预算（实测 1260 > 1200）。
  // 切走时清空、切回时按 state 重建。
  if (name !== 'triage') {
    const tb = $('#triageBody');
    if (tb) tb.innerHTML = '';
  } else if (state.triage) {
    renderTriage(state.triage);
  }
  if (name !== 'tpl') {
    const tl = $('#rtTplList');
    if (tl) tl.innerHTML = '';
  } else if ((state.appealTemplates || []).length) {
    renderTemplates();
  }
  if (name !== 'list' && state.returns) {
    const rb = $('#finReturnBody');
    if (rb) rb.innerHTML = '';
  } else if (name === 'list' && state.returns) {
    renderReturns(state.returns);
  }
}

// ------------------------------------------------------------------ 待处理分诊
const ADVICE_TEXT = {
  urgent: '先处理', check: '核对后同意', wait_trace: '等物流',
  chase: '催寄', agree: '建议同意', evidence: '需举证',
  refund_only: '仅退款', normal: '按流程', unknown: '待确认',
};

function fmtCountdown(sec) {
  if (sec == null) return '—';
  if (sec <= 0) return '已到期';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + '天' + h + '时';
  if (h > 0) return h + '时' + m + '分';
  return m + '分';
}

function renderTriage(data) {
  const body = $('#triageBody');
  const sec = $('#triageSec');
  const empty = $('#triageEmpty');
  const note = $('#rtTriageNote');
  if (!body || !sec) return;
  // 分诊结果是落盘的，可能含已移除店铺
  const activeIds = new Set((state.malls || []).map((m) => m.id));
  const rows = ((data && data.rows) || []).filter((r) => !r || !r.mallId || !activeIds.size || activeIds.has(r.mallId));
  if (note) {
    const when = data && data.at
      ? (data.fromCache ? '上次分诊 ' : '分诊于 ') + financeStamp(data.at)
      : '还没分诊';
    note.textContent = rows.length ? (rows.length + ' 单 · ' + when) : when;
  }
  if (!rows.length) {
    sec.style.display = 'none';
    body.innerHTML = '';
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';
  sec.style.display = 'block';
  body.innerHTML = '';
  // 一单 ≈ 20 节点，全量渲染会顶破 DOM 预算；先渲染 20 条，多的提示用上限调小
  const TRIAGE_PAGE = 20;
  const shown = rows.slice(0, TRIAGE_PAGE);
  for (const r of shown) {
    const tr = document.createElement('tr');
    const thumb = r.thumbUrl
      ? '<img class="order-thumb" loading="lazy" src="' + esc(r.thumbUrl) + '" alt="" />'
      : '<span class="order-thumb order-thumb-empty">' + esc(String(r.goodsName || '?').slice(0, 1)) + '</span>';
    const urgent = r.countdownSec != null && r.countdownSec <= 86400;
    tr.innerHTML =
      '<td><div class="order-product">' + thumb +
        '<div style="min-width:0"><div class="order-name" title="' + esc(r.goodsName || '') + '">' +
          esc(String(r.goodsName || '—').slice(0, 16)) + '</div>' +
          '<div class="fin-sub">' + esc(r.orderSn) + (r.days == null ? '' : ' · ' + r.days + ' 天前') + '</div>' +
        '</div></div></td>' +
      '<td class="fin-store" title="' + esc(r.mallName || '') + '">' + esc(r.mallName || '—') + '</td>' +
      '<td class="rt-type">' + esc(r.typeName || '—') + '</td>' +
      '<td class="r expense">' + fmtYuan(r.refundAmount) + '</td>' +
      '<td><div class="fin-sub" style="margin:0">' + esc(r.statusText || (r.detailOk ? '—' : '未读')) + '</div>' +
        (r.reason ? '<div class="fin-sub">' + esc(r.reason) + '</div>' : '') + '</td>' +
      '<td class="r ' + (urgent ? 'expense' : '') + '">' + fmtCountdown(r.countdownSec) + '</td>' +
      '<td><span class="triage-badge lv-' + esc(r.adviceLevel || 'wait') + '">' +
        esc(ADVICE_TEXT[r.advice] || r.adviceText || '—') + '</span>' +
        '<div class="fin-sub">' + esc(r.adviceText || '') + '</div></td>' +
      '<td class="r rt-check-cell"><button class="btn" data-open="' + esc(r.orderSn) + '" ' +
        'data-asid="' + esc(r.afterSalesId || '') + '" data-mall="' + esc(r.mallId || '') + '" ' +
        'title="在店铺视图打开这单售后详情">详情</button></td>';
    body.appendChild(tr);
  }
  body.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => openAftersaleDetail(b.dataset.mall, b.dataset.asid, b.dataset.open));
  });
}

let triageBusy = false;
async function runTriage() {
  if (triageBusy) { logWarn('正在分诊，请稍候'); return; }
  const btn = $('#btnTriageRun');
  if (!btn) return;
  const limit = Number(($('#rtTriageLimit') && $('#rtTriageLimit').value) || 15);
  triageBusy = true;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '分诊中…';
  if ($('#rtTriageNote')) $('#rtTriageNote').textContent = '正在逐单读详情，约 ' + Math.ceil(limit * 8 / 60) + ' 分钟…';
  logInfo('开始售后分诊，本次读 ' + limit + ' 单 ...');
  try {
    const r = await window.pdd.aftersaleTriage({ maxItems: limit });
    if (!r || !r.ok) { logErr('分诊失败：' + ((r && r.error) || '未知')); return; }
    state.triage = r;
    renderTriage(r);
    const urgent = (r.rows || []).filter((x) => x.adviceLevel === 'urgent').length;
    logOk('分诊完成：' + r.total + ' 单' + (urgent ? '，其中 ' + urgent + ' 单 24 小时内到期' : ''));
  } catch (e) {
    logErr('分诊异常：' + (e && e.message ? e.message : e));
  } finally {
    triageBusy = false; btn.disabled = false; btn.textContent = old;
  }
}

async function loadTriageLast() {
  if (!window.pdd.aftersaleTriageLast) return;
  try {
    const r = await window.pdd.aftersaleTriageLast();
    if (r && r.ok && r.rows && r.rows.length) { state.triage = r; renderTriage(r); }
  } catch (_) { /* ignore */ }
}

/** 在店铺视图打开这单售后详情（用户自己看、自己点） */
async function openAftersaleDetail(mallId, afterSalesId, orderSn) {
  if (!afterSalesId) { logWarn('这单没有售后编码，打不开详情'); return; }
  if (!window.pdd.aftersaleDetail) return;
  logInfo('打开售后详情 ' + orderSn + ' ...');
  try {
    const r = await window.pdd.aftersaleDetail({ mallId, afterSalesId, orderSn });
    if (r && r.ok) {
      logOk('已读取详情：' + (r.data && r.data.statusText ? r.data.statusText : '成功'));
    } else {
      logWarn('详情读取失败：' + ((r && r.error) || '未知'));
    }
  } catch (e) {
    logErr('详情异常：' + (e && e.message ? e.message : e));
  }
  // 无论读没读到，都把用户送到后台那单，让 ta 自己操作
  await window.pdd.appealOpenWorkbench().catch(() => {});
  setTab('browser');
}

async function openAftersaleWorkbench() {
  const btn = $('#btnAftersaleOpen');
  if (!btn || !window.pdd.appealOpenWorkbench) return;
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '打开中…';
  logInfo('正在打开售后工作台 ...');
  try {
    const r = await window.pdd.appealOpenWorkbench();
    if (r && r.ok) {
      logOk('售后工作台已打开');
      setTab('browser');
    } else {
      logErr('打开失败：' + ((r && r.error) || '未知'));
    }
  } catch (e) {
    logErr('打开异常：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

let orderBusy = false;
async function collectOrderContribution() {
  if (orderBusy) { logWarn('正在读取订单，请稍候'); return; }
  orderBusy = true;
  const btn = $('#btnFinOrders');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '读取订单中…';
  logInfo('开始读取近90天订单 ...');
  try {
    const r = await window.pdd.financeOrders({ days: 90, maxPages: 20 });
    if (!r || !r.ok) { logErr('订单读取失败：' + ((r && r.error) || '未知')); return; }
    state.orderData = r;
    renderOrderContribution(r);
    await loadReturns();
    const n = (r.stores || []).reduce((a, s) => a + (s.orders || []).length, 0);
    logOk('订单读取完成：' + n + ' 条');
    (r.stores || []).filter((s) => s.error).forEach((s) => logWarn(s.mallName + '：' + s.error));
  } catch (e) {
    logErr('订单读取异常：' + (e && e.message ? e.message : e));
  } finally {
    orderBusy = false; btn.disabled = false; btn.textContent = old;
  }
}

/**
 * 采集进度环：done/total 由 main 的 finance:progress 推过来。
 * total 为 0 时隐藏。周长按 r=8 算（2πr ≈ 50.27），用 dashoffset 表示进度。
 */
const RING_C = 2 * Math.PI * 8;
function setRing(done, total) {
  const ring = $('#finRing');
  const fg = $('#finRingFg');
  const txt = $('#finRingTxt');
  if (!ring) return;
  if (!total) { ring.hidden = true; return; }
  ring.hidden = false;
  if (fg) {
    fg.style.strokeDasharray = String(RING_C);
    fg.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, done / total)));
  }
  if (txt) txt.textContent = done + '/' + total;
}

/** 采集期间用骨架屏占位，别让页面看着像卡死 */
function showSkeleton(on) {
  const sk = $('#finSkeleton');
  const content = $('#finContent');
  const empty = $('#finEmpty');
  if (!sk) return;
  sk.hidden = !on;
  if (on) {
    if (content) content.style.display = 'none';
    if (empty) empty.style.display = 'none';
    return;
  }
  // 收起骨架：有旧数据必须把内容区放回来，否则采集失败后会是一片空白
  if (state.finance) {
    if (content) content.style.display = 'block';
    if (empty) empty.style.display = 'none';
  } else {
    if (content) content.style.display = 'none';
    if (empty) empty.style.display = 'flex';
  }
}

if (window.pdd && window.pdd.onFinanceProgress) {
  window.pdd.onFinanceProgress((d) => setRing((d && d.done) || 0, (d && d.total) || 0));
}

async function collectFinance() {
  if (financeBusy) { logWarn('正在采集，请稍候'); return; }
  financeBusy = true;
  const btn = $('#btnFinCollect');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '采集中…';
  $('#finSub').textContent = '正在逐个店铺读取资金数据，请勿切换页签…';
  setRing(0, (state.malls || []).length);
  showSkeleton(true);
  logInfo('开始采集资金数据（含日汇总/明细） ...');
  try {
    const r = await window.pdd.financeCollect({ withDetail: true, withDaily: true, maxPages: 20 });
    if (r && r.ok) {
      state.finance = r;
      state.financeLastAt = Date.now();
      renderFinance(r);
      const okN = r.stores.filter((s) => !s.error).length;
      const at = (r.snapshot && r.snapshot.lastCollectedAt) || r.at;
      const dd = (r.snapshot && r.snapshot.dataDate) || null;
      const dm = (r.snapshot && r.snapshot.dataMonth) || r.month || null;
      $('#finSub').textContent = '采集于 ' + financeStamp(at) +
        (dd ? (' ｜ 数据截至 ' + dd) : (dm ? (' ｜ 数据月份 ' + dm) : '')) +
        ' ｜ ' + okN + '/' + r.stores.length + ' 个店铺成功';
      logOk('资金数据采集完成：' + okN + '/' + r.stores.length + ' 个店铺');
      r.stores.filter((s) => s.error).forEach((s) => logWarn(s.mallName + '：' + s.error));
    } else {
      logErr('采集失败：' + ((r && r.error) || '未知'));
      $('#finSub').textContent = '采集失败';
    }
  } catch (e) {
    logErr('采集异常：' + (e && e.message ? e.message : e));
    $('#finSub').textContent = '采集异常';
  } finally {
    financeBusy = false;
    btn.disabled = false;
    btn.textContent = old;
    showSkeleton(false);
    // 先亮满格再收：2/2 只存在几毫秒的话肉眼根本看不到
    const totalMalls = (state.malls || []).length;
    if (totalMalls) setRing(totalMalls, totalMalls);
    if (window._ringHoldTimer) clearTimeout(window._ringHoldTimer);
    window._ringHoldTimer = setTimeout(() => setRing(0, 0), 600);
  }
}

const FINANCE_AUTO_MS = 24 * 60 * 60 * 1000;
let financeAutoAttemptAt = 0;

async function maybeAutoCollectFinance() {
  if (financeBusy) return;
  if (!state.financeLastAt) return;
  const age = Date.now() - state.financeLastAt;
  if (age < FINANCE_AUTO_MS) return;
  if (Date.now() - financeAutoAttemptAt < 10 * 60 * 1000) return;
  financeAutoAttemptAt = Date.now();
  logInfo('资金数据已超过 24 小时，自动刷新一次...');
  await collectFinance();
}

setInterval(maybeAutoCollectFinance, 30 * 60 * 1000);

$('#btnFinCollect') && $('#btnFinCollect').addEventListener('click', () => collectFinance());

// ---- 拿货成本：记一笔 / 改金额 / 改备注 / 删 ----
const costAddBtn = $('#costAddBtn');
if (costAddBtn) {
  const d = $('#costAddDate');
  if (d && !d.value) d.value = localDateStr(new Date());
  costAddBtn.addEventListener('click', async () => {
    const date = String(($('#costAddDate') || {}).value || '').slice(0, 10);
    const yuan = Number(($('#costAddAmount') || {}).value);
    const note = String(($('#costAddNote') || {}).value || '').trim();
    if (!date) return logWarn('请选择日期');
    if (!Number.isFinite(yuan) || yuan <= 0) return logWarn('金额必须大于 0');
    const r = await window.pdd.financeCostAdd({ date, amount: Math.round(yuan * 100), note });
    if (!r || !r.ok) return logWarn('记账失败：' + ((r && r.error) || '未知'));
    logOk('已记一笔拿货成本 ' + date + ' ' + fmtYuan(Math.round(yuan * 100)));
    if ($('#costAddAmount')) $('#costAddAmount').value = '';
    if ($('#costAddNote')) $('#costAddNote').value = '';
    await loadFinanceCosts();
  });
}

// 改金额 / 改备注：失焦即保存。事件委托到 tbody，重渲染后不用重新绑。
const costBodyEl = $('#finCostBody');
if (costBodyEl) {
  const saveCost = async (el, patch) => {
    const id = el.dataset.costId || el.dataset.costNoteId;
    if (!id) return;
    const r = await window.pdd.financeCostUpdate(Object.assign({ id }, patch));
    if (!r || !r.ok) {
      logWarn('保存失败：' + ((r && r.error) || '未知'));
      el.value = el.dataset.orig || '';
      return;
    }
    await loadFinanceCosts();
  };
  costBodyEl.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.costId) {
      const yuan = Number(el.value);
      if (!Number.isFinite(yuan) || yuan <= 0) {
        logWarn('金额必须大于 0');
        el.value = el.dataset.orig || '';
        return;
      }
      if (String(yuan) === String(el.dataset.orig)) return;
      saveCost(el, { amount: Math.round(yuan * 100) });
    } else if (el.dataset && el.dataset.costNoteId) {
      if (String(el.value) === String(el.dataset.orig || '')) return;
      saveCost(el, { note: String(el.value || '').trim() });
    }
  });
  costBodyEl.addEventListener('click', async (ev) => {
    const id = ev.target && ev.target.dataset && ev.target.dataset.costDel;
    if (!id) return;
    const r = await window.pdd.financeCostDelete(id);
    if (!r || !r.ok) return logWarn('删除失败：' + ((r && r.error) || '未知'));
    logOk('已删除一条拿货成本记录');
    await loadFinanceCosts();
  });
}
$('#finReturnBody') && $('#finReturnBody').addEventListener('change', async (e) => {
  const el = e.target;
  if (!el || !el.dataset || !el.dataset.orderSn) return;
  const orderSn = el.dataset.orderSn;
  try {
    if (el.classList.contains('rt-sn')) {
      const r = await window.pdd.financeReturnSet({ orderSn, returnSn: el.value });
      if (!r || !r.ok) { logErr('保存退货单号失败：' + ((r && r.error) || '未知')); return; }
    } else if (el.classList.contains('rt-carrier')) {
      const carrierId = Number(el.dataset.carrierId) || null;
      const r = await window.pdd.financeReturnSet({ orderSn, carrier: el.value, carrierId });
      if (!r || !r.ok) { logErr('保存快递失败：' + ((r && r.error) || '未知')); return; }
    }
    await loadReturns();
  } catch (err) {
    logErr('保存失败：' + (err && err.message ? err.message : err));
  }
});

$('#finReturnBody') && $('#finReturnBody').addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.rt-check') : null;
  if (!btn) return;
  const orderSn = btn.dataset.orderSn;
  const nextDone = btn.dataset.done !== '1';
  // 先就地播放动画，再落盘刷新
  btn.classList.toggle('done', nextDone);
  btn.dataset.done = nextDone ? '1' : '0';
  btn.classList.remove('pop');
  void btn.offsetWidth;
  btn.classList.add('pop');
  try {
    const r = await window.pdd.financeReturnSet({ orderSn, done: nextDone });
    if (!r || !r.ok) { logErr('更新状态失败：' + ((r && r.error) || '未知')); return; }
    logOk(orderSn + ' 标记为' + (nextDone ? '已完成' : '未完成'));
    setTimeout(() => { loadReturns(); }, 260);
  } catch (err) {
    logErr('更新状态异常：' + (err && err.message ? err.message : err));
  }
});

$('#btnFinOrders') && $('#btnFinOrders').addEventListener('click', () => collectOrderContribution());
$('#btnReturnRefresh') && $('#btnReturnRefresh').addEventListener('click', () => loadReturns());

// 导出当前筛选结果（不是只导当前渲染的 30 行）
$('#btnReturnExport') && $('#btnReturnExport').addEventListener('click', async () => {
  const btn = $('#btnReturnExport');
  const hint = $('#rtExportHint');
  const rows = state.returnsFiltered || [];
  const say = (html, isErr) => {
    if (!hint) return;
    hint.className = 'rt-export-hint' + (isErr ? ' err' : '');
    hint.innerHTML = html;
    hint.style.display = 'flex';
    // 统一走 shell.openPath（实测能成）。不用 showItemInFolder：
    // 它内部是 explorer /select,，在这个工作区目录上会被权限挡掉。
    hint.querySelectorAll('[data-open]').forEach((b) => {
      b.addEventListener('click', async () => {
        const r = await window.pdd.openPath(b.getAttribute('data-open')).catch((e) => ({ ok: false, error: String(e) }));
        if (r && r.ok === false) say('打不开：' + esc(r.error || '未知原因') + '<br><span class="path">' + esc(b.getAttribute('data-open')) + '</span>', true);
      });
    });
  };
  if (!rows.length) { say('没有可导出的退货行', true); return; }
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const r = await window.pdd.returnsExport({ rows });
    if (r && r.ok) {
      // 文件落在应用目录里，用户很难自己找；给出完整路径 + 两个打开入口
      say('已导出 ' + r.count + ' 行 · <span class="path">' + esc(r.file) + '</span>' +
          '<button class="btn" data-open="' + esc(r.file) + '">打开文件</button>' +
          '<button class="btn" data-open="' + esc(r.dir || '') + '">打开文件夹</button>');
      addLog('已导出 ' + r.count + ' 行 → ' + r.file);
    } else if (r && r.canceled) {
      say('已取消导出');
    } else {
      say('导出失败：' + esc((r && r.error) || '未知错误'), true);
      logErr('导出失败：' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    say('导出失败：' + esc((e && e.message) || e), true);
    logErr('导出失败：' + ((e && e.message) || e));
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});
      $('#finReturnMore') && $('#finReturnMore').addEventListener('click', () => {
        const total = (state.returnsFiltered || []).length;
  const cur = Math.max(30, state.returnsLimit || 30);
  state.returnsLimit = (cur >= total) ? 0 : (cur + 30);
        if (state.returns) renderReturns(state.returns);
      });
$('#rtWithin21') && $('#rtWithin21').addEventListener('change', () => {
  if (state.returns) renderReturns(state.returns);
});
$('#rtMallFilter') && $('#rtMallFilter').addEventListener('change', (e) => {
  state.returnsMall = e.target.value || '';
  if (state.returns) renderReturns(state.returns);
});

// 售后：页签 + 文案库
$$('.rt-tab').forEach((b) => b.addEventListener('click', () => setRtTab(b.dataset.rt)));
$('#btnAftersaleOpen') && $('#btnAftersaleOpen').addEventListener('click', () => openAftersaleWorkbench());
$('#btnTplNew') && $('#btnTplNew').addEventListener('click', () => openTplDialog(null));
$('#rtTplSearch') && $('#rtTplSearch').addEventListener('input', () => renderTemplates());
$('#btnTriageRun') && $('#btnTriageRun').addEventListener('click', () => runTriage());
$('#btnReturnTrace') && $('#btnReturnTrace').addEventListener('click', async () => {
  const btn = $('#btnReturnTrace');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '抓取中…';
  logInfo('开始抓在途退货物流轨迹（每单约 1~2 秒）...');
  try {
    const r = await window.pdd.financeReturnTrace({ maxItems: 60 });
    if (!r || !r.ok) { logErr('抓取失败：' + ((r && r.error) || '未知')); return; }
    logOk('抓取完成：查 ' + r.checked + ' 单，已签收 ' + r.signed +
      '，无轨迹 ' + r.noTrace + (r.failed ? '，失败 ' + r.failed : ''));
    await loadReturns();
  } catch (e) {
    logErr('抓取异常：' + (e && e.message ? e.message : e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
});
$('#finOrderMore') && $('#finOrderMore').addEventListener('click', () => {
  state.orderShowAll = !state.orderShowAll;
  if (state.orderData) renderOrderContribution(state.orderData);
});
$('#finOrderBody') && $('#finOrderBody').addEventListener('change', async (e) => {
  const input = e.target;
  if (!input || !input.classList || !input.classList.contains('cost-inline')) return;
  const raw = String(input.value || '').trim();
  const goodsId = input.dataset.goodsId || '';
  const productName = input.dataset.name || '';
  try {
    if (!raw) {
      await window.pdd.financeProductCostDelete({ goodsId, productName });
    } else {
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) { logWarn('成本单价必须是非负数字'); return; }
      const r = await window.pdd.financeProductCostSet({ goodsId, productName, unitCost: Math.round(v * 100) });
      if (!r || !r.ok) { logErr('保存成本失败：' + ((r && r.error) || '未知')); return; }
    }
    await loadFinanceProductCosts();
  } catch (err) {
    logErr('保存成本异常：' + (err && err.message ? err.message : err));
  }
});

$$('.fin-fee-bar input').forEach((input) => input.addEventListener('change', async () => {
  const data = {
    platformRate: Number($('#feePlatform').value || 0) / 100,
    promotionPerOrder: Math.round(Number($('#feePromo').value || 0) * 100),
    shippingPerOrder: Math.round(Number($('#feeShip').value || 0) * 100),
    packagingPerOrder: Math.round(Number($('#feePack').value || 0) * 100),
  };
  try {
    const r = await window.pdd.financeFeeSet(data);
    if (r && r.ok) {
      state.feeSettings = r.data;
      if (state.orderData) renderOrderContribution(state.orderData);
    }
  } catch (_) { /* ignore */ }
}));

$('#finMonth') && $('#finMonth').addEventListener('change', (e) => {
  if (state.finance) renderFinance(state.finance, e.target.value);
});

// ------------------------------------------------------------------ 商品检测（按店铺分组）
let goodsCheckBusy = false;

function renderRiskTable(r) {
  const body = $('#riskBody');
  const empty = $('#riskEmpty');
  const sec = $('#riskSec');
  if (!body || !sec) return;
  // 每个店铺都出一组（0 个被判定也要显示），这样「按店铺分类的商品包」才完整
  const stores = (r.stores || []);
  const hasAny = stores.length > 0;
  const note = $('#riskNote');
  if (note) {
    const when = (r.fromCache ? '上次检测 ' : '检测于 ') + financeStamp(r.at);
    note.textContent = (r.flagged ? (r.flagged + ' / ' + r.total + ' 个商品被判定') : '全部正常') + ' · ' + when;
  }
  if (!hasAny) {
    empty.style.display = 'flex';
    sec.style.display = 'none';
    body.innerHTML = '';
    return;
  }
  empty.style.display = 'none';
  sec.style.display = 'block';
  body.innerHTML = '';
  for (const s of stores) {
    const head = document.createElement('tr');
    head.className = 'risk-group';
    const cnt = s.error ? '读取失败' : ((s.flagged || []).length + ' / ' + (s.total || 0) + ' 个被判定');
    head.innerHTML = '<td colspan="4">' + esc(s.mallName) +
      '<span class="cnt">' + esc(cnt) + (s.stale ? ' · 旧数据' : '') + '</span></td>';
    body.appendChild(head);
    if (s.error) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4" style="color:#f5a623">' + esc(s.error) + '</td>';
      body.appendChild(tr);
      continue;
    }
    for (const g of (s.flagged || [])) {
      const tr = document.createElement('tr');
      const img = g.thumb
        ? '<img class="risk-thumb" loading="lazy" src="' + esc(g.thumb) + '" alt="" />'
        : '<span class="risk-thumb"></span>';
      const shortReason = String(g.reason || '').split('。')[0];
      tr.innerHTML =
        '<td>' + img + '</td>' +
        '<td class="risk-id">' + esc(g.goodsId || '—') + '</td>' +
        '<td><div class="risk-name" title="' + esc(g.goodsName) + '">' + esc(g.goodsName || '—') + '</div></td>' +
        '<td><div class="risk-reason" title="' + esc(g.reason) + '">' + esc(shortReason) + '</div></td>';
      body.appendChild(tr);
    }
  }
}

/** 打开应用时读回上次的商品检测结果（按店铺商品包），不用重新跑一遍 */
async function loadRiskLast() {
  if (!window.pdd.riskLast) return;
  try {
    const r = await window.pdd.riskLast();
    if (!r || !r.ok || !r.stores || !r.stores.length) return;
    state.riskData = r;
    renderRiskTable(r);
  } catch (_) { /* ignore */ }
}

async function runGoodsCheck() {
  if (goodsCheckBusy) return;
  const btn = $('#btnRiskRun');
  if (!btn) return;
  goodsCheckBusy = true;
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '检测中…';
  if ($('#riskNote')) $('#riskNote').textContent = '正在逐个店铺读取商品判定…';
  logInfo('开始检测店铺商品 ...');
  try {
    const r = await window.pdd.riskGoodsCheck({});
    if (!r || !r.ok) {
      if ($('#riskNote')) $('#riskNote').textContent = '检测失败：' + ((r && r.error) || '未知');
      logErr('商品检测失败：' + ((r && r.error) || '未知'));
      return;
    }
    state.riskData = r;
    renderRiskTable(r);
    setTab('risk');
    logOk('商品检测完成：' + (r.flagged || 0) + '/' + (r.total || 0) + ' 个商品被判定');
    (r.stores || []).filter((s) => s.flagged.length).forEach((s) =>
      logWarn(s.mallName + '：' + s.flagged.length + ' 个商品被判定'));
  } catch (e) {
    if ($('#riskNote')) $('#riskNote').textContent = '检测异常：' + (e && e.message ? e.message : String(e));
    logErr('商品检测异常：' + (e && e.message ? e.message : e));
  } finally {
    goodsCheckBusy = false;
    btn.disabled = false;
    btn.textContent = old || '开始检测';
  }
}
$('#btnRiskRun') && $('#btnRiskRun').addEventListener('click', () => runGoodsCheck());

// ------------------------------------------------------------------ 深色 / 浅色主题
// 主题直接切换，不做整页颜色过渡（软渲染下容易看起来一块块跳）。
// 只在主题按钮内部做一个小圆圈扩散，视觉有反馈但不会影响页面内容。
const THEME_KEY = 'pdd.theme';
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function updateThemeButton() {
  const btn = $('#btnTheme');
  if (!btn) return;
  const light = currentTheme() === 'light';
  btn.title = light ? '切换到深色模式' : '切换到浅色模式';
  btn.setAttribute('aria-label', btn.title);
  const label = btn.querySelector('.theme-label');
  if (label) label.textContent = light ? '深色' : '浅色';
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* ignore */ }
  updateThemeButton();
}
function switchTheme(theme, originEl) {
  if (theme === currentTheme()) return;
  applyTheme(theme);
  const btn = originEl || $('#btnTheme') || document.body;
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!reduce && btn && btn.classList) {
    btn.classList.remove('ripple');
    void btn.offsetWidth;
    btn.classList.add('ripple');
    setTimeout(() => btn.classList.remove('ripple'), 480);
  }
}
updateThemeButton();
$('#btnTheme') && $('#btnTheme').addEventListener('click', (e) => {
  switchTheme(currentTheme() === 'light' ? 'dark' : 'light', e.currentTarget);
});

// 自绘窗口按钮
function winAction(action) {
  if (window.pdd && typeof window.pdd.windowAction === 'function') {
    window.pdd.windowAction(action);
  }
}
$('#btnWinMin') && $('#btnWinMin').addEventListener('click', () => winAction('minimize'));
$('#btnWinMax') && $('#btnWinMax').addEventListener('click', () => winAction('maximize'));
$('#btnWinClose') && $('#btnWinClose').addEventListener('click', () => winAction('close'));

// ------------------------------------------------------------------ 启动
(async () => {
  initCollector();
  logInfo('界面已就绪');
  await refreshMalls();
  await refreshPool();
  await refreshBatch();
  await loadFinanceCosts();
  await loadFinanceProductCosts();
  await loadFinanceFeeSettings();
  await loadFinanceLast();
  await loadFinanceOrderLast();
  await loadReturns();
  await loadRiskLast();
  await loadAppealScenes();
  await loadAppealTemplates();
  await loadTriageLast();
  // 三个子页签的内容不同时留在 DOM（否则 1260 节点超预算），启动后按当前页签清一遍
  setRtTab(state.rtTab || 'list');
  setTab('goods');
  if (!state.malls.length) logInfo('第一步：点左上「＋ 添加店铺」，在右侧浏览器里扫码登录');
})();
