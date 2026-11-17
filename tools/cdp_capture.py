#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cdp_capture.py —— 用 CDP 抓真实网络流量，找出「编辑/草稿」相关接口
不猜端点，让浏览器自己走一遍，我们看它调了什么

用法:
    python tools/cdp_capture.py --nav https://mms.pinduoduo.com/goods/goods-list --seconds 12
    python tools/cdp_capture.py --nav "https://mms.pinduoduo.com/goods/goods-list" --match commit,edit,draft
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request
import os

try:
    import websocket
except ImportError:
    print("[ERR] pip install websocket-client")
    sys.exit(1)

DEBUG_BASE = "http://127.0.0.1:9222"


def _req(path, method="GET"):
    req = urllib.request.Request(DEBUG_BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read().decode("utf-8", "replace").strip()
    return json.loads(body) if body[:1] in "{[{" else body


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True)
        self._id = 0
        self.events = []

    def send(self, method, params=None):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        return mid

    def pump(self, seconds):
        """收集事件一段时间"""
        deadline = time.time() + seconds
        self.events = []
        while time.time() < deadline:
            self.ws.settimeout(max(0.2, deadline - time.time()))
            try:
                raw = self.ws.recv()
            except Exception:
                continue
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if "method" in msg:
                self.events.append(msg)
        return self.events

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def pick_page(match="mms.pinduoduo.com"):
    targets = _req("/json/list")
    pages = [t for t in targets if t.get("type") == "page" and match in (t.get("url") or "")]
    if pages:
        pages.sort(key=lambda t: 0 if "/home" in (t.get("url") or "") else 1)
        return pages[0]
    # 新建
    q = urllib.parse.quote("https://mms.pinduoduo.com/home/", safe="")
    for m in ("PUT", "GET"):
        try:
            t = _req("/json/new?url=" + q, method=m)
            if isinstance(t, dict) and t.get("webSocketDebuggerUrl"):
                time.sleep(2)
                return t
        except Exception:
            pass
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nav", default="", help="导航到的 URL（空则不导航，只抓当前页）")
    ap.add_argument("--seconds", type=float, default=12.0)
    ap.add_argument("--match", default="commit,edit,draft,copy,goods", help="URL 关键词，逗号分隔")
    ap.add_argument("--body", action="store_true", help="尝试取响应体")
    ap.add_argument("--click", default="", help="点击 innerText 等于该文本的元素（例如 编辑）")
    ap.add_argument("--click-index", type=int, default=0, help="点击第几个匹配元素（默认 0）")
    ap.add_argument("--wait-before-click", type=float, default=4.0, help="导航后等多久再点")
    args = ap.parse_args()

    target = pick_page()
    if not target:
        print("[ERR] 没有可用的 mms 页面，先跑 launch_pdd_browser")
        return 2
    ws_url = target["webSocketDebuggerUrl"]
    print("[OK] 附着页面: {}".format((target.get("url") or "")[:120]))

    cdp = CDP(ws_url)
    cdp.send("Network.enable", {"maxTotalBufferSize": 50 * 1024 * 1024})
    cdp.send("Page.enable")

    if args.nav:
        print("[..] 导航到: {}".format(args.nav))
        cdp.send("Page.navigate", {"url": args.nav})

    if args.click:
        time.sleep(args.wait_before_click)
        js = (
            "(() => {"
            "  const want = %s; const idx = %d;"
            "  const els = [...document.querySelectorAll('a,button,span,div')]"
            "    .filter(e => (e.innerText||'').replace(/\\s+/g,' ').trim() === want);"
            "  if (!els[idx]) return {clicked:false, candidates: els.length};"
            "  els[idx].click();"
            "  return {clicked:true, candidates: els.length, tag: els[idx].tagName};"
            "})()"
        ) % (json.dumps(args.click, ensure_ascii=False), args.click_index)
        cdp.send("Runtime.evaluate", {"expression": js, "returnByValue": True, "userGesture": True})
        print("[..] 已点击「{}」第 {} 个".format(args.click, args.click_index))

    print("[..] 抓包 {} 秒 ...".format(args.seconds))
    events = cdp.pump(args.seconds)

    # 抓包结束后回读最终 URL
    try:
        cdp2 = CDP(ws_url)
        mid = cdp2.send("Runtime.evaluate", {"expression": "location.href", "returnByValue": True})
        val = None
        for _ in range(20):
            raw = cdp2.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == mid:
                val = ((msg.get("result") or {}).get("result") or {}).get("value")
                break
        cdp2.close()
        print("[OK] 点击后页面 URL: {}".format(val))
    except Exception as e:
        print("[!] 回读 URL 失败: {}".format(e))

    reqs = {}
    order = []
    for e in events:
        m = e.get("method")
        p = e.get("params") or {}
        if m == "Network.requestWillBeSent":
            rid = p.get("requestId")
            url = (p.get("request") or {}).get("url", "")
            reqs[rid] = {"url": url, "method": (p.get("request") or {}).get("method"),
                         "postData": (p.get("request") or {}).get("postData")}
            order.append(rid)
        elif m == "Network.responseReceived":
            rid = p.get("requestId")
            if rid in reqs:
                resp = p.get("response") or {}
                reqs[rid]["status"] = resp.get("status")
                reqs[rid]["mime"] = resp.get("mimeType")

    kws = [k.strip().lower() for k in args.match.split(",") if k.strip()]
    hits = []
    for rid in order:
        r = reqs.get(rid) or {}
        u = (r.get("url") or "").lower()
        if any(k in u for k in kws):
            hits.append((rid, r))

    print("\n=== 共 {} 个请求，命中 {} 个 ===".format(len(order), len(hits)))
    seen = set()
    for rid, r in hits:
        u = r.get("url", "")
        short = u.split("?")[0]
        if short in seen:
            continue
        seen.add(short)
        print("\n{} {} -> {}".format(r.get("method"), r.get("status"), u[:220]))
        if r.get("postData"):
            print("   body: {}".format(str(r["postData"])[:400]))

    print("\n=== 全部 URL（去重，仅路径）===")
    allp = []
    for rid in order:
        u = (reqs.get(rid) or {}).get("url", "")
        if "pinduoduo.com" in u:
            p = u.split("?")[0]
            if p not in allp:
                allp.append(p)
    for p in allp:
        print("  " + p[:200])

    # 把命中的请求体完整落盘，便于分析保存接口
    try:
        dump = []
        for rid, r in hits:
            dump.append({
                "url": r.get("url"),
                "method": r.get("method"),
                "status": r.get("status"),
                "postData": r.get("postData"),
            })
        out_path = os.path.join(os.getcwd(), "work", "capture_bodies.json")
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(dump, f, ensure_ascii=False, indent=2)
        print("\n[OK] 请求体已落盘: {}".format(out_path))
    except Exception as e:
        print("[!] 落盘失败: {}".format(e))

    cdp.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
