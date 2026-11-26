'use strict';
/**
 * 悬浮胶囊音乐播放器 · 数据层
 *
 * music:pick     选一个音乐文件夹，扫描音频，落盘到 userdata/music.json
 * music:list     读上次的列表（重启后不用重选）
 * music:capsule  开/关胶囊窗口（窗口本身在 main.js 里建）
 *
 * 只读本地文件，不联网、不解析任何平台的加密格式。
 * 支持 mp3 / flac / m4a / aac / wav / ogg / opus —— 用户自己合法持有的音频。
 */
module.exports = function registerMusic(ctx) {
  const { ipcMain, fs, path, DATA_DIR, dialog, writeJsonAtomic, trace } = ctx;

  const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus']);
  const FILE = path.join(DATA_DIR, 'music.json');

  function load() {
    try {
      if (!fs.existsSync(FILE)) return { dir: '', tracks: [] };
      const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (!o || !Array.isArray(o.tracks)) return { dir: '', tracks: [] };
      // 文件可能已被删掉：返回时标 missing，界面置灰但不删记录
      for (const t of o.tracks) {
        try { t.missing = !fs.existsSync(t.file); } catch (_) { t.missing = true; }
      }
      return { dir: o.dir || '', tracks: o.tracks };
    } catch (_) {
      return { dir: '', tracks: [] };
    }
  }

  /** 递归扫两层（专辑子目录也能收进来），跳过隐藏目录。 */
  function scan(dir) {
    const out = [];
    const walk = (d, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (depth < 2) walk(full, depth + 1);
          continue;
        }
        const ext = path.extname(e.name).toLowerCase();
        if (!AUDIO_EXT.has(ext)) continue;
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) { /* ignore */ }
        out.push({
          file: full,
          title: path.basename(e.name, ext),
          album: depth > 0 ? path.basename(d) : '',
          size,
          missing: false,
        });
      }
    };
    walk(dir, 0);
    out.sort((a, b) => (a.album || '').localeCompare(b.album || '') || a.title.localeCompare(b.title));
    return out;
  }

  ipcMain.handle('music:pick', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择音乐文件夹',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    const tracks = scan(dir);
    const payload = { dir, tracks, at: Date.now() };
    try { writeJsonAtomic(FILE, payload); } catch (e) { trace('music save fail: ' + ((e && e.message) || e)); }
    trace('music: picked ' + dir + ' -> ' + tracks.length + ' 首');
    return { ok: true, dir, tracks };
  });

  ipcMain.handle('music:list', () => load());

  ipcMain.handle('music:capsule', () => ctx.toggleCapsule());
};
