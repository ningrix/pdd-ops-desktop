'use strict';
/**
 * 悬浮胶囊音乐播放器 · 数据层
 *
 * music:list      读播放列表（内置曲 + 用户添加），并保证内置曲已生成
 * music:pick      选一个音乐文件夹，扫描音频
 * music:addFiles  添加单个/多个音频文件（不想整目录时用）
 * music:save      记住音量/循环模式/上一首/进度
 * music:resize    展开/收起胶囊面板（改窗口尺寸，底边不动）
 * music:capsule   开/关胶囊窗口（窗口本身在 main.js 里建）
 *
 * 只读本地文件，不联网，不解析任何平台的加密格式（.ncm 会明确告诉用户为什么放不了）。
 * 支持 mp3 / flac / m4a / aac / wav / ogg / opus —— 用户自己合法持有的音频。
 */
const { pathToFileURL } = require('url');
const tonetrack = require('../lib/tonetrack');

module.exports = function registerMusic(ctx) {
  const { ipcMain, fs, path, DATA_DIR, dialog, writeJsonAtomic, trace, capsule } = ctx;

  const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.wav', '.ogg', '.opus']);
  const FILE = path.join(DATA_DIR, 'music.json');
  const BUILTIN_DIR = path.join(DATA_DIR, 'music', 'builtin');

  function readStore() {
    try {
      const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      return {
        dir: (o && o.dir) || '',
        tracks: (o && Array.isArray(o.tracks)) ? o.tracks : [],
        files: (o && Array.isArray(o.files)) ? o.files : [],
        player: (o && o.player && typeof o.player === 'object') ? o.player : {},
      };
    } catch (_) {
      return { dir: '', tracks: [], files: [], player: {} };
    }
  }

  function writeStore(o) {
    try {
      writeJsonAtomic(FILE, Object.assign({ at: Date.now() }, o));
    } catch (e) {
      trace('music save fail: ' + ((e && e.message) || e));
    }
  }

  function exists(p) {
    try { return fs.statSync(p).size > 0; } catch (_) { return false; }
  }

  /** 内置曲：缺了才生成，生成失败不阻塞其它功能 */
  function ensureBuiltin() {
    try { fs.mkdirSync(BUILTIN_DIR, { recursive: true }); } catch (_) { /* ignore */ }
    const out = [];
    for (const spec of tonetrack.BUILTINS) {
      const full = path.join(BUILTIN_DIR, spec.file);
      if (!exists(full)) {
        try {
          const n = tonetrack.render(spec, full);
          trace('music: builtin generated ' + spec.file + ' (' + n + ' bytes)');
        } catch (e) {
          trace('music: builtin fail ' + spec.file + ': ' + ((e && e.message) || e));
          continue;
        }
      }
      out.push({
        file: full,
        title: spec.title,
        album: '内置 · 合成',
        builtin: true,
        missing: false,
      });
    }
    return out;
  }

  /**
   * 递归扫两层（专辑子目录也能收进来），跳过隐藏目录。
   * .ncm 单独计数：它是网易云的 DRM 容器，本播放器不解析，界面要给出可解释的提示。
   */
  function scan(dir) {
    const out = [];
    let skippedNcm = 0;
    let skippedOther = 0;
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
        if (ext === '.ncm') { skippedNcm += 1; continue; }
        if (!AUDIO_EXT.has(ext)) {
          if (ext === '.lrc' || ext === '.jpg' || ext === '.png' || ext === '.txt') continue;
          skippedOther += 1;
          continue;
        }
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
    return { tracks: out, skippedNcm, skippedOther };
  }

  /** 用户文件在前，内置曲在后；按完整路径去重，并补上 file:// URL */
  function listAll(store) {
    const seen = new Set();
    const own = [];
    for (const t of [...(store.files || []), ...(store.tracks || [])]) {
      if (!t || !t.file || seen.has(t.file)) continue;
      seen.add(t.file);
      own.push(t);
    }
    for (const t of own) t.missing = !exists(t.file);
    const merged = own.concat(ensureBuiltin());
    return merged.map((t) => {
      let url = '';
      try { url = pathToFileURL(t.file).href; } catch (_) { /* ignore */ }
      return Object.assign({}, t, { url });
    });
  }

  ipcMain.handle('music:list', () => {
    const store = readStore();
    const tracks = listAll(store);
    return {
      ok: true,
      dir: store.dir || '',
      tracks,
      player: store.player || {},
      builtinCount: tonetrack.BUILTINS.length,
      ncmHint: store.dir ? undefined : '还没有添加自己的音乐。内置两首可以直接播。',
    };
  });

  ipcMain.handle('music:pick', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择音乐文件夹',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    const scanned = scan(dir);
    const store = readStore();
    store.dir = dir;
    store.tracks = scanned.tracks;
    writeStore(store);
    trace('music: picked ' + dir + ' -> ' + scanned.tracks.length + ' 首, ncm=' + scanned.skippedNcm);
    return {
      ok: true,
      dir,
      tracks: listAll(store),
      skippedNcm: scanned.skippedNcm,
      skippedOther: scanned.skippedOther,
    };
  });

  ipcMain.handle('music:addFiles', async () => {
    const r = await dialog.showOpenDialog({
      title: '添加音乐文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频', extensions: ['mp3', 'flac', 'm4a', 'aac', 'wav', 'ogg', 'opus'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const store = readStore();
    const have = new Set(store.files.map((t) => t.file));
    let added = 0;
    for (const full of r.filePaths) {
      if (have.has(full)) continue;
      have.add(full);
      store.files.push({
        file: full,
        title: path.basename(full, path.extname(full)),
        album: '手动添加',
        size: 0,
        missing: false,
      });
      added += 1;
    }
    writeStore(store);
    trace('music: addFiles +' + added);
    return { ok: true, added, tracks: listAll(store) };
  });

  ipcMain.handle('music:save', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return { ok: false };
    const store = readStore();
    const p = store.player || {};
    const allowed = ['volume', 'rate', 'shuffle', 'repeat', 'lastFile', 'lastTime', 'openedAt'];
    for (const k of allowed) {
      if (patch[k] !== undefined) p[k] = patch[k];
    }
    store.player = p;
    writeStore(store);
    return { ok: true, player: p };
  });

  ipcMain.handle('music:resize', (_e, size) => {
    if (!capsule || !size) return { ok: false };
    return capsule.resize(Number(size.w) || 400, Number(size.h) || 76);
  });

  ipcMain.handle('music:capsule', () => capsule.toggle());
};
