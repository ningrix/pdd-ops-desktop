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
  poolCollect: (index) => ipcRenderer.invoke('pool:collect', { index }),
  poolRemove: (id) => ipcRenderer.invoke('pool:remove', id),
  poolPublish: (args) => ipcRenderer.invoke('pool:publish', args),

  // 状态与诊断
  pingMall: (id) => ipcRenderer.invoke('ops:pingMall', id),
  debugInfo: () => ipcRenderer.invoke('debug:info'),

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
