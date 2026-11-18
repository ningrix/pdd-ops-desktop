'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdd', {
  // 店铺
  listMalls: () => ipcRenderer.invoke('malls:list'),
  addMall: (name) => ipcRenderer.invoke('malls:add', name),
  removeMall: (id) => ipcRenderer.invoke('malls:remove', id),
  activateMall: (id) => ipcRenderer.invoke('malls:activate', id),

  // 内置浏览器
  toggleView: (visible) => ipcRenderer.invoke('view:toggle', visible),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  setBounds: (b) => ipcRenderer.invoke('view:bounds', b),
  navigate: (url) => ipcRenderer.invoke('view:navigate', url),
  reload: () => ipcRenderer.invoke('view:reload'),

  // 业务
  ping: () => ipcRenderer.invoke('ops:ping'),
  listGoods: () => ipcRenderer.invoke('ops:list'),
  copyGoods: (args) => ipcRenderer.invoke('ops:copy', args),
  draft: (commit) => ipcRenderer.invoke('ops:draft', commit),
  submit: (goods, commit) => ipcRenderer.invoke('ops:submit', { goods, commit }),
  publish: (args) => ipcRenderer.invoke('ops:publish', args),
  changePrice: (args) => ipcRenderer.invoke('ops:changePrice', args),

  // 采集箱
  poolList: () => ipcRenderer.invoke('pool:list'),
  poolCollect: (index, goodsId) => ipcRenderer.invoke('pool:collect', { index, goodsId }),
  poolRemove: (id) => ipcRenderer.invoke('pool:remove', id),
  poolDetail: (id) => ipcRenderer.invoke('pool:detail', id),
  poolPublish: (args) => ipcRenderer.invoke('pool:publish', args),
  // 批量队列
  batchStart: (ids, options) => ipcRenderer.invoke('batch:start', { ids, options }),
  batchStop: () => ipcRenderer.invoke('batch:stop'),
  batchList: () => ipcRenderer.invoke('batch:list'),
  batchClear: () => ipcRenderer.invoke('batch:clear'),
  batchRetryKnown: () => ipcRenderer.invoke('batch:retryKnown'),
  onBatch: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('batch', h);
    return () => ipcRenderer.removeListener('batch', h);
  },

  // 商品检测
  inspectItem: (args) => ipcRenderer.invoke('inspect:item', args),
  inspectPool: () => ipcRenderer.invoke('inspect:pool'),

  // 主图水印
  watermarkItem: (args) => ipcRenderer.invoke('img:watermark', args),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  // 草稿清理
  draftsList: (args) => ipcRenderer.invoke('drafts:list', args || {}),
  draftsDelete: (ids) => ipcRenderer.invoke('drafts:delete', { ids }),

  // 采集会话（买家账号登录，读别人的商品链接）
  collectorShow: (on) => ipcRenderer.invoke('collector:show', on),
  collectorNavigate: (url) => ipcRenderer.invoke('collector:navigate', url),
  collectorEval: (code) => ipcRenderer.invoke('collector:eval', { code }),
  collectorRead: () => ipcRenderer.invoke('collector:read'),
  poolAddExternal: (pack) => ipcRenderer.invoke('pool:addExternal', pack),

  // 从安卓 App 采集（价格/颜色/尺码，网页端拿不到）
  appCollect: (target, deep) => ipcRenderer.invoke('app:collect', { target, deep }),
  collectFull: (target, deep) => ipcRenderer.invoke('collect:full', { target, deep }),
  // 账单下载
  billLastDownload: () => ipcRenderer.invoke('bill:lastDownload'),
  billOpenFolder: () => ipcRenderer.invoke('bill:openFolder'),
  onBillDownloaded: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('bill:downloaded', h);
    return () => ipcRenderer.removeListener('bill:downloaded', h);
  },
  // 资金复盘
  financeCollect: (opts) => ipcRenderer.invoke('finance:collect', opts),
  financeRestrictions: () => ipcRenderer.invoke('finance:restrictions'),

  // 状态与诊断
  pingMall: (id) => ipcRenderer.invoke('ops:pingMall', id),
  debugInfo: () => ipcRenderer.invoke('debug:info'),
  netStart: () => ipcRenderer.invoke('debug:netStart'),
  netStop: () => ipcRenderer.invoke('debug:netStop'),
  debugEval: (code, timeoutMs) => ipcRenderer.invoke('debug:eval', { code, timeoutMs }),

  // 图片上传（空白新建用）
  fetchImagesToLocal: (args) => ipcRenderer.invoke('img:fetchToLocal', args),
  setFileInput: (args) => ipcRenderer.invoke('img:setFileInput', args),
  mmsCall: (path, body) => ipcRenderer.invoke('debug:mmsCall', { path, body }),
  captureEdit: (commit, goods) => ipcRenderer.invoke('debug:captureEdit', { commit, goods }),

  // 尺码表模板
  sizeList: () => ipcRenderer.invoke('size:list'),
  sizeMatch: (catNames) => ipcRenderer.invoke('size:match', catNames),

  // 日志
  onLog: (cb) => {
    const h = (_e, line) => cb(line);
    ipcRenderer.on('log', h);
    return () => ipcRenderer.removeListener('log', h);
  },
});
