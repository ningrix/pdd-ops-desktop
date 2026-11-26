/**
 * 自动更新：electron-updater + GitHub Releases。
 *
 * 只在打包态启用。开发态没有 app-update.yml，调用 autoUpdater 会直接抛错。
 *
 * 事件统一通过 'update:event' 推给渲染层，渲染层只认 type 字段：
 *   checking | available | none | progress | downloaded | error
 *
 * 关于静默安装：本项目安装包未做代码签名。实测未签名包用 /S 静默安装时，
 * 部分机器会被 SmartScreen / Defender 静默拦掉（进程返回 0 但文件不落地）。
 * 所以 quitAndInstall 刻意传 isSilent=false，让安装向导弹出来由用户确认。
 * 买了代码签名证书之后，把 false 改成 true 即可恢复完全静默。
 */
module.exports = function registerUpdate(ctx) {
  const { ipcMain, app, getMainWindow, trace, dataDir } = ctx;

  let updater = null;
  let lastState = { type: 'idle' };

  function send(evt) {
    lastState = evt;
    const brief = evt.type + (evt.version ? ' v' + evt.version : '') + (evt.message ? ' :: ' + evt.message : '');
    try { trace('update event: ' + brief); } catch (_) { /* ignore */ }
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null;
    // 注意：isDestroyed 是函数，别写 !win.isDestroyed（函数是 truthy，取反恒为 false，
    // 会让整个条件永远不成立、事件一个都发不出去）。
    const alive = win && (typeof win.isDestroyed === 'function' ? !win.isDestroyed() : true);
    if (alive) {
      try { win.webContents.send('update:event', evt); } catch (_) { /* ignore */ }
    }
  }

  function getUpdater() {
    if (updater) return updater;
    // 延迟 require：开发态没有更新配置，提前引入会打一堆警告
    const { autoUpdater } = require('electron-updater');
    try {
      const log = require('electron-log');
      autoUpdater.logger = log;
      log.transports.file.level = 'info';
    } catch (_) { /* electron-log 缺失也不影响主流程 */ }

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = false;

    autoUpdater.on('checking-for-update', () => send({ type: 'checking' }));
    autoUpdater.on('update-available', (info) => send({
      type: 'available',
      version: (info && info.version) || '',
      notes: String((info && info.releaseNotes) || '').slice(0, 500),
    }));
    autoUpdater.on('update-not-available', () => send({ type: 'none', version: app.getVersion() }));
    autoUpdater.on('download-progress', (p) => send({
      type: 'progress',
      percent: p && typeof p.percent === 'number' ? Math.round(p.percent) : 0,
      bytesPerSecond: (p && p.bytesPerSecond) || 0,
    }));
    autoUpdater.on('update-downloaded', (info) => send({
      type: 'downloaded',
      version: (info && info.version) || '',
    }));
    autoUpdater.on('error', (e) => {
      const msg = String((e && e.message) || e || '未知错误');
      send({ type: 'error', message: msg.slice(0, 300) });
    });

    updater = autoUpdater;
    return updater;
  }

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { ok: false, error: '开发态不检查更新', dev: true };
    try {
      const r = await getUpdater().checkForUpdates();
      return {
        ok: true,
        current: app.getVersion(),
        latest: (r && r.updateInfo && r.updateInfo.version) || app.getVersion(),
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
  });

  ipcMain.handle('update:install', () => {
    if (!app.isPackaged) return { ok: false, error: '开发态不安装更新', dev: true };
    try {
      // isSilent=false：未签名包静默安装可能被系统拦掉，交给安装向导
      // isForceRunAfter=true：装完自动拉起新版本
      setImmediate(() => {
        try {
          getUpdater().quitAndInstall(false, true);
        } catch (e) {
          send({ type: 'error', message: String((e && e.message) || e).slice(0, 300) });
        }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
    }
  });

  ipcMain.handle('update:state', () => lastState);

  ipcMain.handle('update:version', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  // 设置页：显示并打开数据目录（登录态/快照/成本都在这里，换机时整目录拷走即可）
  ipcMain.handle('app:dataDir', () => dataDir || '');
  ipcMain.handle('app:openDataDir', async () => {
    try {
      const { shell } = require('electron');
      if (!dataDir) return { ok: false, error: '数据目录未知' };
      const err = await shell.openPath(dataDir);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 用户设置（性能开关）。GPU 开关只在启动时读取，改完必须重启。
  const fs = require('fs');
  const path = require('path');
  const settingsFile = path.join(dataDir || app.getPath('userData'), 'settings.json');
  function readSettings() {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch (_) { return {}; }
  }
  ipcMain.handle('app:settingsGet', () => readSettings());
  ipcMain.handle('app:settingsSet', (_e, patch) => {
    try {
      const next = Object.assign({}, readSettings(), patch || {});
      fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
      return { ok: true, settings: next };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('app:relaunch', () => {
    // 必须走 app.quit() 而不是 app.exit(0)：exit 不触发 before-quit，
    // main.js 里那轮 flushStorageData() 不会执行，两个店铺 + 采集会话的
    // cookie 都来不及落盘 —— 重启后全部掉登录。relaunch 只是登记下次启动，
    // 真正的退出交给 quit 走正常流程。
    setImmediate(() => { app.relaunch(); app.quit(); });
    return { ok: true };
  });

  // 启动后延迟检查：不和首屏、店铺恢复抢资源
  if (app.isPackaged) {
    setTimeout(() => {
      try {
        getUpdater().checkForUpdates();
      } catch (e) {
        try { trace('update check fail: ' + ((e && e.message) || e)); } catch (_) { /* ignore */ }
      }
    }, 8000);
  }
};
