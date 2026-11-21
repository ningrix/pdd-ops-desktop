'use strict';
/**
 * 售后域：详情读取、分诊、申诉文案库、打开售后工作台。
 *
 * 三块内容：
 *   - APPEAL_SCENES / APPEAL_BUILTIN：8 个场景的申诉文案骨架（只产出文本，绝不自动提交）
 *   - aftersale:detail / :triage / :triageLast：读售后详情页并分诊
 *   - appeal:*：文案库增删改、标记结果、打开工作台
 *
 * 文案模板落盘 app/userdata/appeal/templates.json；分诊结果落盘 app/userdata/aftersale/triage.json。
 * 依赖通过 ctx 显式注入，本文件不 require electron。
 */
module.exports = function registerAftersale(ctx) {
  const {
    ipcMain, fs, path, DATA_DIR, APPEAL_DIR, APPEAL_TEMPLATES_FILE,
    FINANCE_DIR, FINANCE_RETURNS_FILE,
    malls, currentMall, createHiddenMallWindow, withPlatform,
    sleep, trace, writeJsonAtomic,
    loadReturnTraces, readFinanceOrders, aftersaleDetail,
  } = ctx;
// ---------------------------------------------------------------- 售后文案库
/**
 * 场景表。kind 决定这条文案用在哪：
 *   reject   = 驳回退款理由（36h 窗口，第一杠杆）
 *   evidence = 举证/留言（同意退款前把凭证说清）
 *   appeal   = 维权/异常单申诉（48h 窗口）
 */
const APPEAL_SCENES = [
  { id: 'return_not_received', name: '退货未收到', kind: 'reject' },
  { id: 'return_swapped', name: '空包 / 调包', kind: 'reject' },
  { id: 'size_dispute', name: '尺码不符', kind: 'reject' },
  { id: 'quality', name: '商品质量', kind: 'evidence' },
  { id: 'logistics_damage', name: '物流破损', kind: 'evidence' },
  { id: 'arbitration', name: '判责申诉', kind: 'appeal' },
  { id: 'malicious_order', name: '恶意下单', kind: 'appeal' },
  { id: 'generic', name: '通用', kind: 'reject' },
];

/**
 * 内置骨架。写法遵循实测结论：平台判的是「规则触发」不是态度，
 * 所以正文只做四件事 —— 指出买家主张哪一项对不上、列我方履约证据、
 * 给物流事实链、提明确请求。占位符 {orderSn} {amount} {returnSn} {days} 由界面替换。
 */
const APPEAL_BUILTIN = [
  {
    scene: 'return_not_received', kind: 'reject',
    title: '驳回：退货单号无物流轨迹',
    body: '买家填写退货单号 {returnSn}，但该单号在物流方查询无任何揽收记录。\n'
      + '按平台售后规则，退货退款需以实际退回商品为退款前提；当前仅有单号、无揽收与运输轨迹，退货事实尚未成立。\n'
      + '我方已按约发货并签收（发货单号见订单物流），履约完成。\n'
      + '请求：驳回本次退款申请；买家可在补充有效物流凭证后重新申请。',
    evidence: ['退货单号在快递官网/小程序查询无记录的截图（含查询时间）', '订单发货物流轨迹完整截图', '与买家沟通记录（如有）'],
  },
  {
    scene: 'return_swapped', kind: 'reject',
    title: '驳回：退回空包 / 商品被调包',
    body: '退货签收后开箱核验，包裹内{空包/非本店商品/明显使用痕迹}，与买家申请退款的商品不一致。\n'
      + '我方发货有打包视频与称重记录，可证明发出商品与订单一致。\n'
      + '请求：驳回本次退款；如需进一步核查，可调取退货开箱视频与称重对比。',
    evidence: ['退货开箱视频（一镜到底，含面单特写）', '退货包裹称重照片/称重记录', '发货打包视频或发货称重记录', '商品对比照片（发出 vs 退回）'],
  },
  {
    scene: 'size_dispute', kind: 'reject',
    title: '驳回：尺码不符（商品页已标注尺码表）',
    body: '买家申请原因为尺码不合适。\n'
      + '商品详情页已提供尺码对照表（含衣长/胸围/建议身高体重），买家下单规格为所选尺码，属自主选择。\n'
      + '尺码不符不属于商品质量问题，且商品已签收使用。\n'
      + '请求：驳回本次退款申请；如买家坚持，建议走七天无理由退货并由买家承担退回运费。',
    evidence: ['商品详情页尺码表截图（含页面 URL 与时间）', '订单规格与买家所选尺码截图', '商品实物尺码测量照片'],
  },
  {
    scene: 'quality', kind: 'evidence',
    title: '举证：商品质量异议（附检测与对比）',
    body: '买家主张商品存在质量问题。\n'
      + '该批次商品进货凭证与质检报告齐全，同批次其他订单无同类反馈。\n'
      + '买家提供的照片{未见所述问题/无法判断为商品本身问题}。\n'
      + '请求：按凭证核定责任；如需进一步核验，我方可提供完整进货链路与检测报告。',
    evidence: ['进货凭证 / 发票', '质检报告或材质说明', '买家提供照片的原图放大对比', '同批次其他订单评价截图'],
  },
  {
    scene: 'logistics_damage', kind: 'evidence',
    title: '举证：物流破损（派件前已报备）',
    body: '买家反馈外包装破损。\n'
      + '该包裹在我方交寄时包装完好（有交寄照片/打包视频），破损发生在运输环节。\n'
      + '我方已在发现异常时向快递方报备，报备单号见附件。\n'
      + '请求：责任按运输环节认定；我方可配合买家向快递方索赔。',
    evidence: ['交寄时包装照片或打包视频', '快递方报备记录 / 工单号', '物流轨迹异常节点截图', '买家提供的破损照片'],
  },
  {
    scene: 'arbitration', kind: 'appeal',
    title: '申诉：平台判责与事实不符',
    body: '平台判定退款 {amount} 元。\n'
      + '该判定与以下事实不符：{具体指出是「事实认定」「适用理由」还是「规则依据」哪一项对不上}。\n'
      + '我方履约证据：{发货凭证 / 签收记录 / 沟通记录}。\n'
      + '请求：复核本次判责并撤销退款；相关凭证已随附。',
    evidence: ['平台判责结果页截图（含判定理由原文）', '能直接反驳该理由的凭证', '订单全链路截图（下单→发货→签收）'],
  },
  {
    scene: 'malicious_order', kind: 'appeal',
    title: '申诉：异常订单不发货（恶意下单）',
    body: '买家{下单后即申请退款 / 收货信息异常 / 历史多单异常退款}，存在非正常消费目的迹象。\n'
      + '该订单如发货将产生实际物流成本与货损风险。\n'
      + '请求：按「异常订单不发货」通过申诉，本单无需发货且不计入店铺销量。',
    evidence: ['买家下单与申请退款时间线截图', '该买家历史订单异常记录（如有）', '收货信息异常截图'],
  },
  {
    scene: 'generic', kind: 'reject',
    title: '通用驳回骨架',
    body: '退款金额 {amount} 元。\n'
      + '买家主张：{原样摘录买家申请原因}。\n'
      + '该主张不成立，理由：{对应规则条款或事实}。\n'
      + '我方履约证据：{列 1~3 项}。\n'
      + '请求：驳回本次退款申请。',
    evidence: ['订单与物流全链路截图', '能反驳买家主张的关键凭证', '沟通记录（如有）'],
  },
];

function seedAppealTemplates() {
  const now = Date.now();
  return APPEAL_BUILTIN.map((t, i) => ({
    id: 'tpl_builtin_' + (i + 1),
    scene: t.scene,
    kind: t.kind,
    title: t.title,
    body: t.body,
    evidence: t.evidence,
    builtin: true,
    uses: 0,
    won: 0,
    lost: 0,
    createdAt: now,
    updatedAt: now,
  }));
}

function loadAppealTemplates() {
  try {
    if (!fs.existsSync(APPEAL_TEMPLATES_FILE)) {
      const seed = seedAppealTemplates();
      writeJsonAtomic(APPEAL_TEMPLATES_FILE, seed);
      return seed;
    }
    const arr = JSON.parse(fs.readFileSync(APPEAL_TEMPLATES_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    // 迁移：内置骨架的开头不再带「订单 {orderSn}，」——粘贴到申诉框时订单号由页面自带，
    // 文案里再写一遍既啰嗦又容易贴错单号。只动内置模板，用户自己写的不碰。
    let changed = false;
    for (const t of arr) {
      if (!t || !t.builtin) continue;
      const b = String(t.body || '');
      const nb = b.replace(/^订单 \{orderSn\}[，,、]?\s*/, '');
      if (nb !== b) { t.body = nb; t.updatedAt = Date.now(); changed = true; }
    }
    if (changed) writeJsonAtomic(APPEAL_TEMPLATES_FILE, arr);
    return arr;
  } catch (e) {
    trace('loadAppealTemplates FAIL: ' + ((e && e.message) || e));
    return seedAppealTemplates();
  }
}

function saveAppealTemplates(arr) {
  writeJsonAtomic(APPEAL_TEMPLATES_FILE, arr);
}

/**
 * 读一张售后单详情（隐藏窗口 + 深链），返回解析后的字段。
 * 只读，不点任何业务按钮。
 */
async function readAftersaleDetail(mallId, afterSalesId, orderSn) {
  const mall = malls.get(mallId);
  if (!mall) return { ok: false, error: '店铺不存在' };
  let temp = null;
  try {
    temp = createHiddenMallWindow(mall);
    try { temp.setPosition(-10000, -10000); temp.showInactive(); } catch (_) { /* ignore */ }
    const wc = temp.webContents;
    const url = 'https://mms.pinduoduo.com/aftersales-ssr/detail?id=' +
      encodeURIComponent(String(afterSalesId)) + '&orderSn=' + encodeURIComponent(String(orderSn));
    try { await wc.loadURL(url); } catch (_) { /* 跳转中断是常态 */ }
    let text = '';
    for (let k = 0; k < 14; k++) {
      await sleep(900);
      try {
        text = await wc.executeJavaScript(
          "(document.body.innerText||'').replace(/\\s+/g,' ')", true);
      } catch (_) { text = ''; }
      if (text && text.indexOf('售后编码') >= 0) break;
    }
    if (!text || text.indexOf('售后编码') < 0) {
      return { ok: false, error: '详情页没加载出来（登录态或页面改版）' };
    }
    const d = aftersaleDetail.parseDetail(text);
    return { ok: true, data: d, at: Date.now() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    if (temp) { try { if (!temp.isDestroyed()) temp.destroy(); } catch (_) { /* ignore */ } }
  }
}

ipcMain.handle('aftersale:detail', async (_e, p) => {
  const { mallId, afterSalesId, orderSn } = p || {};
  if (!mallId || !afterSalesId || !orderSn) return { ok: false, error: '缺少参数' };
  return readAftersaleDetail(mallId, afterSalesId, orderSn);
});

/**
 * 分诊：逐单读在途/待处理售后详情，算建议动作，落盘。
 * 只在用户点「分诊」时跑，不自动轮询。
 */
ipcMain.handle('aftersale:triage', async (_e, opts) => {
  const o = Object.assign({ maxItems: 15, mallId: null }, opts || {});
  const snap = readFinanceOrders();
  if (!snap.ok || !snap.data) return { ok: false, error: '还没有订单数据，先点「商品贡献」读取' };
  const nowSec = Math.floor(Date.now() / 1000);
  const targets = [];
  for (const s of (snap.data.stores || [])) {
    if (o.mallId && s.mallId !== o.mallId) continue;
    for (const a of (s.afterSales || [])) {
      if (!a.id || !a.orderSn) continue;
      // 只看还需要处理的：10 待消费者寄货 / 11 待商家确认收货
      if (a.status !== 10 && a.status !== 11) continue;
      targets.push({
        mallId: s.mallId, mallName: s.mallName, afterSalesId: String(a.id),
        orderSn: a.orderSn, goodsName: a.goodsName || '', thumbUrl: a.thumbUrl || '',
        typeName: a.typeName || '', platformStatus: a.status,
        refundAmount: Number(a.refundAmount) || 0,
        days: a.createdAt ? Math.max(0, Math.floor((nowSec - Number(a.createdAt)) / 86400)) : null,
        needReturn: /退货/.test(String(a.typeName || '')),
      });
    }
  }
  const limit = Math.min(targets.length, Math.max(1, Number(o.maxItems) || 15));
  const traces = loadReturnTraces();
  const rows = [];
  for (let i = 0; i < limit; i++) {
    const t = targets[i];
    const r = await readAftersaleDetail(t.mallId, t.afterSalesId, t.orderSn);
    const d = (r && r.ok && r.data) || {};
    const tr = traces[t.orderSn] || null;
    const ctx = Object.assign({}, t, { signed: tr ? tr.signed : null });
    const adv = aftersaleDetail.triage(d, ctx);
    rows.push(Object.assign({}, t, {
      detailOk: !!(r && r.ok),
      detailError: (r && r.error) || null,
      statusText: d.statusText || '',
      reason: d.reason || '',
      countdownSec: d.countdownSec == null ? null : d.countdownSec,
      signedDeadlineHours: d.signedDeadlineHours == null ? null : d.signedDeadlineHours,
      protectLeft: d.protectLeft == null ? null : d.protectLeft,
      hasChatImages: !!d.hasChatImages,
      returnSn: d.returnSn || '',
      shipCarrier: d.shipCarrier || '',
      advice: adv.code,
      adviceText: adv.text,
      adviceLevel: adv.level,
    }));
    await sleep(250);
  }
  // 没读到的单也要露出来，否则用户以为它们不存在
  for (let i = limit; i < targets.length; i++) {
    const t = targets[i];
    rows.push(Object.assign({}, t, {
      detailOk: false, detailError: '本次未读取（超出上限）',
      advice: 'unknown', adviceText: '未读，下次再分诊', adviceLevel: 'wait',
    }));
  }
  rows.sort((a, b) => {
    const ka = a.countdownSec == null ? Infinity : a.countdownSec;
    const kb = b.countdownSec == null ? Infinity : b.countdownSec;
    return ka - kb;
  });
  const out = { ok: true, at: Date.now(), total: rows.length, read: limit, rows };
  try {
    writeJsonAtomic(path.join(DATA_DIR, 'aftersale', 'triage.json'), out);
  } catch (_) { /* ignore */ }
  return out;
});

ipcMain.handle('aftersale:triageLast', () => {
  try {
    const f = path.join(DATA_DIR, 'aftersale', 'triage.json');
    if (!fs.existsSync(f)) return { ok: false, error: '还没有分诊记录' };
    return Object.assign({ ok: true, fromCache: true }, JSON.parse(fs.readFileSync(f, 'utf8')));
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('appeal:scenes', () => ({ ok: true, items: APPEAL_SCENES }));

ipcMain.handle('appeal:templates', () => {
  const items = loadAppealTemplates();
  // 按场景分组顺序返回，同场景内按胜率降序（没打过的按更新时间）
  const order = new Map(APPEAL_SCENES.map((s, i) => [s.id, i]));
  items.sort((a, b) => {
    const d = (order.get(a.scene) ?? 99) - (order.get(b.scene) ?? 99);
    if (d) return d;
    const ra = a.uses ? a.won / a.uses : -1;
    const rb = b.uses ? b.won / b.uses : -1;
    if (rb !== ra) return rb - ra;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
  return { ok: true, items };
});

ipcMain.handle('appeal:templateSave', (_e, tpl) => {
  try {
    const t = tpl || {};
    const title = String(t.title || '').trim().slice(0, 80);
    const body = String(t.body || '').trim().slice(0, 4000);
    if (!title) return { ok: false, error: '标题不能为空' };
    if (!body) return { ok: false, error: '正文不能为空' };
    const scene = APPEAL_SCENES.some((s) => s.id === t.scene) ? t.scene : 'generic';
    const kind = ['reject', 'evidence', 'appeal'].includes(t.kind) ? t.kind : 'reject';
    const evidence = Array.isArray(t.evidence)
      ? t.evidence.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
      : String(t.evidence || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 12);
    const rows = loadAppealTemplates();
    const now = Date.now();
    if (t.id) {
      const i = rows.findIndex((x) => x.id === t.id);
      if (i < 0) return { ok: false, error: '模板不存在' };
      rows[i] = Object.assign({}, rows[i], { scene, kind, title, body, evidence, updatedAt: now });
      saveAppealTemplates(rows);
      return { ok: true, item: rows[i] };
    }
    const item = {
      id: 'tpl_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      scene, kind, title, body, evidence,
      builtin: false, uses: 0, won: 0, lost: 0,
      createdAt: now, updatedAt: now,
    };
    rows.push(item);
    saveAppealTemplates(rows);
    return { ok: true, item };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

ipcMain.handle('appeal:templateDelete', (_e, id) => {
  try {
    const rows = loadAppealTemplates();
    const next = rows.filter((x) => x.id !== id);
    saveAppealTemplates(next);
    return { ok: true, removed: rows.length - next.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/** 记录一次使用结果（win / lose / used），用于按胜率排序 */
ipcMain.handle('appeal:templateMark', (_e, payload) => {
  try {
    const p = payload || {};
    const rows = loadAppealTemplates();
    const i = rows.findIndex((x) => x.id === p.id);
    if (i < 0) return { ok: false, error: '模板不存在' };
    const r = rows[i];
    r.uses = (r.uses || 0) + 1;
    if (p.result === 'won') r.won = (r.won || 0) + 1;
    if (p.result === 'lost') r.lost = (r.lost || 0) + 1;
    r.lastUsedAt = Date.now();
    saveAppealTemplates(rows);
    return { ok: true, item: r };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

/**
 * 在当前店铺视图里打开售后工作台。
 * 不能直接 loadURL：/aftersales/aftersale_list 有客户端路由守卫，会被打回 setup。
 * 正确路径 = 先开 setup，再点「退款/售后」标签。
 */
ipcMain.handle('appeal:openWorkbench', async () => {
  const m = currentMall();
  if (!m || !m.view) return { ok: false, error: '还没有店铺，先添加店铺' };
  const wc = m.view.webContents;
  if (/goods_add/.test(wc.getURL() || '')) {
    return { ok: false, error: '当前店铺视图停在商品编辑页，会拦截跳转；先切到别的页签再打开售后' };
  }
  return withPlatform('openAftersale', async () => {
    try { await wc.loadURL('https://mms.pinduoduo.com/aftersales/setup?tab=3'); } catch (_) { /* 跳转中断是常态 */ }
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      ready = await wc.executeJavaScript("(document.body.innerText||'').includes('售后设置')", true).catch(() => false);
      if (ready) break;
    }
    if (!ready) return { ok: false, error: '售后设置页没加载出来（可能是登录态或网络）' };
    const clicked = await wc.executeJavaScript(`(() => {
      const el = [...document.querySelectorAll('*')].find(e => (e.innerText || '').trim() === '退款/售后' && e.children.length === 0);
      if (!el) return false;
      (el.closest('a,button,li,div') || el).click();
      return true;
    })()`, true).catch(() => false);
    if (!clicked) return { ok: false, error: '找不到「退款/售后」标签，页面可能改版' };
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const u = wc.getURL();
      if (u.includes('/aftersales/aftersale_list')) return { ok: true, url: u };
    }
    return { ok: false, error: '点了标签但没跳到售后列表，当前：' + wc.getURL() };
  }, 90000);
});

function loadReturnsManual() {  try {
    if (!fs.existsSync(FINANCE_RETURNS_FILE)) return {};
    const o = JSON.parse(fs.readFileSync(FINANCE_RETURNS_FILE, 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch (_) { return {}; }
}

function saveReturnsManual(o) {
  fs.mkdirSync(FINANCE_DIR, { recursive: true });
  writeJsonAtomic(FINANCE_RETURNS_FILE, o);
}

  return { APPEAL_SCENES, APPEAL_BUILTIN, loadAppealTemplates, saveAppealTemplates, readAftersaleDetail };
};
