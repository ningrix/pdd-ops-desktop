'use strict';
/**
 * imgtool 的 Node 侧封装。
 *
 * 为什么走子进程：图像处理依赖 torch / PIL / cv2，Node 侧要等价能力得用 sharp（原生编译，违反
 * AGENTS.md §1.3.4）或 jimp（没有超分和修补）。Python 环境已就绪，spawn 是最省的方案。
 *
 * 通信约定：Python 侧只往 stdout 写一行 JSON；我们取最后一行解析。
 * 失败分类严格按 AGENTS.md §5：
 *   - 退出码非 0 且拿到结构化错误 → failed_known
 *   - 超时 / 无输出 / 非 JSON      → failed_unknown（远端可能已有产物）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/**
 * `python -m tools.imgtool` 的工作目录。
 *
 * 源码态：工作区根（app 的上一级），tools/imgtool 在那里。
 * 打包态：__dirname 在 app.asar 内，`..` 指向无意义位置；imgtool 源码由
 *   extraResources 复制到 resources/tools/imgtool，所以 cwd 取 process.resourcesPath。
 *
 * 判断用 `!process.defaultApp && !!process.resourcesPath`：
 *   - 打包应用里 process.defaultApp 是 undefined（不是 false）；
 *   - 纯 Node 下跑测试时 process.resourcesPath 也是 undefined，会回落到源码路径。
 *
 * 注意：这里只解决路径，不提供 Python 运行时。目标机没装 Python/pillow 时，
 * runImgTool 仍会以 failed_known 返回可读错误，不会崩界面。
 */
const ROOT = (!process.defaultApp && process.resourcesPath)
  ? process.resourcesPath
  : path.resolve(__dirname, '..', '..');

function pythonExe() {
  return process.env.PDD_PYTHON || 'python';
}

/**
 * 跑一次 imgtool 子命令。
 * @returns {Promise<{ok:boolean, data?:object, failed?:string, error?:string}>}
 */
function runImgTool(args, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 180000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonExe(), ['-m', 'tools.imgtool', ...args], {
        cwd: ROOT,
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      });
    } catch (e) {
      return resolve({ ok: false, failed: 'failed_known', error: '启动 Python 失败: ' + e.message });
    }

    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (_) { /* ignore */ }
      resolve({
        ok: false,
        failed: 'failed_unknown',
        error: 'imgtool 超时（' + Math.round(timeoutMs / 1000) + 's）：' + args[0],
        stderr: err.slice(-400),
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, failed: 'failed_known', error: 'Python 进程错误: ' + e.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const lines = String(out).trim().split(/\r?\n/).filter(Boolean);
      let data = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const s = lines[i].trim();
        if (!s.startsWith('{')) continue;
        try { data = JSON.parse(s); break; } catch (_) { /* keep looking */ }
      }
      if (!data) {
        return resolve({
          ok: false,
          failed: 'failed_unknown',
          error: 'imgtool 没有返回 JSON（退出码 ' + code + '）',
          stderr: err.slice(-500),
        });
      }
      if (data.ok) return resolve({ ok: true, data });
      return resolve({
        ok: false,
        failed: data.failed || 'failed_known',
        error: data.error || 'imgtool 失败',
        data,
      });
    });
  });
}

// ---------------------------------------------------------------- 图片下载
function download(url, destPath, timeoutMs) {
  return new Promise((resolve) => {
    const limit = timeoutMs || 30000;
    let u;
    try { u = new URL(url); } catch (e) {
      return resolve({ ok: false, error: 'URL 不合法' });
    }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://mms.pinduoduo.com/',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, destPath, timeoutMs).then(resolve);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, error: 'HTTP ' + res.statusCode });
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ws = fs.createWriteStream(destPath);
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.pipe(ws);
      ws.on('finish', () => resolve({ ok: true, path: destPath, bytes }));
      ws.on('error', (e) => resolve({ ok: false, error: '写盘失败: ' + e.message }));
    });
    req.setTimeout(limit, () => {
      req.destroy();
      resolve({ ok: false, error: '下载超时' });
    });
    req.on('error', (e) => resolve({ ok: false, error: '下载失败: ' + e.message }));
  });
}

// ---------------------------------------------------------------- 图像检测
/** 下载并检测一组图片 URL。返回每张的测量结果。 */
async function inspectUrls(urls, tmpDir, opts) {
  const o = opts || {};
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  const images = [];
  const errors = [];
  fs.mkdirSync(tmpDir, { recursive: true });

  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    const dest = path.join(tmpDir, 'i' + i + '.img');
    const dl = await download(url, dest);
    if (!dl.ok) {
      images.push({ url, w: null, h: null, bytes: null, error: dl.error });
      errors.push('第 ' + (i + 1) + ' 张下载失败：' + dl.error);
      continue;
    }
    const r = await runImgTool(['inspect', '--in', dest, '--json'].concat(o.ocr ? ['--ocr'] : []),
                               { timeoutMs: o.timeoutMs || 60000 });
    if (!r.ok) {
      images.push({ url, w: null, h: null, bytes: dl.bytes, error: r.error });
      errors.push('第 ' + (i + 1) + ' 张检测失败：' + r.error);
      continue;
    }
    const d = r.data;
    images.push({
      url, w: d.w, h: d.h, bytes: d.bytes,
      ratio: d.ratio, whiteRatio: d.whiteRatio, edgeWhite: d.edgeWhite,
      centerOffset: d.centerOffset, textRatio: d.textRatio,
      level: d.level, issues: d.issues,
    });
  }
  return { ok: true, count: images.length, images, errors };
}

// ---------------------------------------------------------------- 加/去水印
/**
 * 对一组图片 URL 加水印，输出到 outDir。
 * @param {string[]} urls
 * @param {object} opts { text, mode, opacity, pos, where, sizeRatio, outDir, namePrefix }
 */
async function watermarkUrls(urls, opts) {
  const o = opts || {};
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!list.length) return { ok: false, failed: 'failed_known', error: '没有图片' };
  if (!o.text) return { ok: false, failed: 'failed_known', error: '水印文字为空' };

  const outDir = o.outDir;
  const tmpDir = path.join(outDir, '_src');
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const files = [];
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const src = path.join(tmpDir, 's' + i + '.jpg');
    const dl = await download(list[i], src);
    if (!dl.ok) { errors.push('第 ' + (i + 1) + ' 张下载失败：' + dl.error); continue; }

    const name = (o.namePrefix || 'img') + '_' + String(i + 1).padStart(2, '0') + '.jpg';
    const out = path.join(outDir, name);
    const args = ['watermark', '--in', src, '--out', out,
                  '--text', o.text, '--mode', o.mode || 'corner', '--json'];
    if (o.pos) args.push('--pos', o.pos);
    if (o.where) args.push('--where', o.where);
    if (o.opacity != null) args.push('--opacity', String(o.opacity));
    if (o.sizeRatio != null) args.push('--size', String(o.sizeRatio));

    const r = await runImgTool(args, { timeoutMs: o.timeoutMs || 60000 });
    if (!r.ok) { errors.push('第 ' + (i + 1) + ' 张水印失败：' + r.error); continue; }
    files.push({ src: list[i], out, name, size: r.data.size });
  }

  // 清掉临时源图
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

  return {
    ok: files.length > 0,
    count: files.length,
    total: list.length,
    files,
    errors,
    failed: files.length ? undefined : 'failed_known',
    error: files.length ? undefined : (errors[0] || '全部失败'),
  };
}

module.exports = { runImgTool, download, inspectUrls, watermarkUrls, ROOT };
