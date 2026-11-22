'use strict';
/**
 * 商品检测 + 主图水印域。
 *
 * inspect:item    单个采集箱条目的规则检测；withImages=true 时会下载主图做图像层检测（慢，几十秒）
 * inspect:pool    整池批量检测（只看规则层）
 * img:watermark   批量加水印，产物落到 DATA_DIR 下的输出目录
 *
 * 依赖注入：pool 是采集箱存储，inspect / imgtool 是 lib 层的纯逻辑与子进程封装。
 */
module.exports = function registerInspect(ctx) {
  const {
    ipcMain, fs, path, DATA_DIR, pool, log,
  } = ctx;

// ---------------------------------------------------------------- 商品检测 + 主图水印
const inspect = require('../lib/inspect');
const imgtool = require('../lib/imgtool');

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

  return {  };
};
