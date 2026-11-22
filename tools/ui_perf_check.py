# -*- coding: utf-8 -*-
"""UI 性能验收脚本（真实 Electron renderer，CDP 9333）。

用法：
  python tools/ui_perf_check.py
  python tools/ui_perf_check.py --port 9333 --strict

输出 JSON 指标；--strict 时任一预算超限返回 exit 1。
"""
import argparse, json, sys, time, urllib.request, websocket


def targets(port):
    for _ in range(40):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=2) as r:
                return json.load(r)
        except Exception:
            time.sleep(0.25)
    raise SystemExit('无法连接 CDP，请先运行 tools/restart-app.ps1')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=9333)
    ap.add_argument('--strict', action='store_true')
    args = ap.parse_args()

    page = next(t for t in targets(args.port)
                if t.get('type') == 'page' and 'renderer/index.html' in (t.get('url') or ''))
    ws = websocket.create_connection(page['webSocketDebuggerUrl'], suppress_origin=True, timeout=60)
    seq = [900]

    def call(method, params=None):
        seq[0] += 1
        mid = seq[0]
        ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(ws.recv())
            if m.get('id') == mid:
                return m

    def ev(expr, ap=True):
        r = call('Runtime.evaluate', {'expression': expr, 'returnByValue': True,
                                      'awaitPromise': ap, 'userGesture': True})
        res = r['result'].get('result') or {}
        if res.get('subtype') == 'error':
            raise RuntimeError(res.get('description'))
        return res.get('value')

    def metrics():
        m = call('Performance.getMetrics')['result']['metrics']
        return {x['name']: x['value'] for x in m}

    time.sleep(2)
    call('Performance.enable')
    base = metrics()
    try:
        dom = call('Memory.getDOMCounters')['result']
    except Exception:
        dom = {}

    data = ev("""(async () => {
      // 窗口被遮挡或最小化时 requestAnimationFrame 不触发、setTimeout 还会被节流到秒级，
      // 两者都会让整段 evaluate 挂死。不可见时直接跳过等待，只做节点/规则数这类静态检查。
      const raf2 = () => new Promise(r => {
        if (document.visibilityState !== 'visible') return r();
        let done = false;
        const fin = () => { if (!done) { done = true; r(); } };
        requestAnimationFrame(() => requestAnimationFrame(fin));
        setTimeout(fin, 120);
      });
      // 每项测两遍取最小值：调度抖动只会让某一次变慢，不会让它变快，
      // 所以最小值比平均值更接近代码真实成本（实测同一份代码在 33ms 与 116ms 之间漂）。
      const measure = async (fn) => {
        let best = Infinity;
        for (let i = 0; i < 2; i++) {
          const t = performance.now(); await fn(); await raf2();
          best = Math.min(best, Math.round((performance.now() - t) * 10) / 10);
        }
        return best;
      };
      const long = [];
      let obs = null;
      try { obs = new PerformanceObserver(l => { for (const e of l.getEntries()) long.push(e.duration); }); obs.observe({ entryTypes: ['longtask'] }); } catch (_) {}
      // 预热一轮：首次切换包含 JIT 编译与样式首次匹配，不代表稳态。
      // 不预热的话 theme/tabs 两项会在 40~90ms 之间随机飘，测出来的不是真实回归。
      for (const name of ['pool', 'finance', 'returns', 'risk', 'collect', 'browser', 'goods']) setTab(name);
      document.querySelector('#btnTheme').click();
      document.querySelector('#btnTheme').click();
      await raf2();
      const timings = [];
      timings.push(['theme', await measure(() => document.querySelector('#btnTheme').click())]);
      timings.push(['themeBack', await measure(() => document.querySelector('#btnTheme').click())]);
      const tabs = {};
      const paneNodes = {};
      const scopedNodes = () => {
        const ap = document.querySelector('.pane.active');
        return (ap ? ap.querySelectorAll('*').length : 0)
          + document.querySelector('.side').querySelectorAll('*').length
          + document.querySelector('.topbar').querySelectorAll('*').length;
      };
      for (const name of ['pool', 'finance', 'returns', 'risk', 'collect', 'browser', 'goods']) {
        tabs[name] = await measure(() => setTab(name));
        paneNodes[name] = scopedNodes();
      }
      const poolRender = await measure(async () => { await refreshPool(); });
      await new Promise(r => setTimeout(r, 1000));
      if (obs) obs.disconnect();
      const s = document.querySelector('.side');
      return {
        nodes: document.querySelectorAll('*').length,
        cssRules: document.styleSheets[0] ? document.styleSheets[0].cssRules.length : 0,
        dclMs: performance.timing ? performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart : null,
        theme: timings,
        tabs, poolRender, paneNodes,
        poolRows: document.querySelectorAll('#poolBody tr').length,
        finRows: document.querySelectorAll('#finOrderBody tr').length,
        longTasks: long,
        sidebar: { client: s.clientHeight, scroll: s.scrollHeight },
        themeIcons: {
          // PH2 之后主题按钮里是单个 sun-morph svg（.sun / .moon 两组），
          // 旧的 .ic-moon / .ic-sun 已移除；读不到就返回 null，不让整个探针抛错。
          dark: (() => {
            const b = document.querySelector('#btnTheme');
            if (!b) return null;
            const s = b.querySelector('.sun-morph .sun');
            const m = b.querySelector('.sun-morph .moon');
            return (s && m) ? [getComputedStyle(s).opacity, getComputedStyle(m).opacity] : null;
          })(),
        },
        themeNow: document.documentElement.dataset.theme,
      };
    })()""")
    after = metrics()
    data['heapMB'] = round(after.get('JSHeapUsedSize', 0) / 1024 / 1024, 2)
    data['domCounters'] = dom
    data['perfDelta'] = {
        'TaskDuration': round(after.get('TaskDuration', 0) - base.get('TaskDuration', 0), 4),
        'LayoutDuration': round(after.get('LayoutDuration', 0) - base.get('LayoutDuration', 0), 4),
        'RecalcStyleDuration': round(after.get('RecalcStyleDuration', 0) - base.get('RecalcStyleDuration', 0), 4),
    }

    # DOM 预算按「当前页签作用域」算（活动 pane + 侧栏 + 顶栏），不按全文档总数。
    # 理由：所有 pane 常驻 DOM，非活动 pane 的节点不该算进当前页的渲染成本；
    # 但单个 pane 自己膨胀（例如表格不虚拟化）必须被抓到，所以取各页签的最大值。
    pane_nodes = data.get('paneNodes') or {}
    worst_pane = max(pane_nodes.items(), key=lambda kv: kv[1]) if pane_nodes else ('none', 0)
    checks = {
        'scoped nodes <= 1200 (worst: %s=%d)' % worst_pane: worst_pane[1] <= 1200,
        'cssRules <= 600': data['cssRules'] <= 600,
        'theme <= 50ms': all(v <= 50 for _, v in data['theme']),
        'tabs <= 80ms': all(v <= 80 for v in data['tabs'].values()),
        'poolRender <= 60ms': data['poolRender'] <= 60,
        'longTasks == 0': len(data['longTasks']) == 0,
        'sidebar no overflow': data['sidebar']['client'] == data['sidebar']['scroll'],
    }
    data['checks'] = checks
    print(json.dumps(data, ensure_ascii=False, indent=2))
    failed = [k for k, v in checks.items() if not v]
    if failed:
        print('FAIL:', ', '.join(failed), file=sys.stderr)
        if args.strict:
            sys.exit(1)
    else:
        print('PASS: UI performance budget')
    ws.close()


if __name__ == '__main__':
    main()
