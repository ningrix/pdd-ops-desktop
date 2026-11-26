// 读桌面所有 .lnk 的真实目标与图标路径，输出 JSON 供分析。
// 用法：electron.exe --no-sandbox --disable-gpu audit-lnk.js
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const DIRS = ['C:\\Users\\56587\\Desktop', 'C:\\Users\\Public\\Desktop'];

app.whenReady().then(() => {
  const rows = [];
  for (const dir of DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.lnk')); } catch (_) { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const d = shell.readShortcutLink(p);
        const tgt = d.target || '';
        const icon = d.icon || '';
        rows.push({
          name: f,
          dir,
          target: tgt,
          targetExists: tgt ? fs.existsSync(tgt) : null,
          icon,
          iconIndex: d.iconIndex,
          iconExists: icon ? fs.existsSync(icon) : null,
          args: d.args || '',
          cwd: d.cwd || '',
        });
      } catch (e) {
        rows.push({ name: f, dir, error: String(e && e.message || e) });
      }
    }
  }
  fs.writeFileSync('C:\\temp\\lnk-audit.json', JSON.stringify(rows, null, 2), 'utf8');
  console.log('wrote', rows.length, 'rows');
  app.quit();
});
