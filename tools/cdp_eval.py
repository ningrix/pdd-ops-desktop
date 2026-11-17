#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
cdp_eval.py —— 通过 CDP 在已登录的拼多多后台页面里执行 JS
替代「F12 → 粘贴到 Console」，全程无需手动输入

用法:
    python tools/cdp_eval.py work/step2_dump.js
    python tools/cdp_eval.py work/step2_dump.js --url mms.pinduoduo.com

前置:
    python tools/launch_pdd_browser.ps1   # 或直接跑 启动拼多多工作浏览器.bat
    然后在弹出的窗口里登录一次
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

try:
    import websocket  # websocket-client
except ImportError:
    print("[ERR] 缺少 websocket-client，执行: python -m pip install websocket-client")
    sys.exit(1)

DEBUG_BASE = "http://127.0.0.1:9222"
DEFAULT_MATCH = "mms.pinduoduo.com"
TARGET_URL = "https://mms.pinduoduo.com/home/"


def _req(path, method="GET"):
    req = urllib.request.Request(DEBUG_BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read().decode("utf-8", "replace")
    body = body.strip()
    if body.startswith("{") or body.startswith("["):
        return json.loads(body)
    return body


def check_debug_port():
    try:
        info = _req("/json/version")
        print("[OK] CDP 端口就绪: {}".format(info.get("Browser", "?")))
        return True
    except Exception as e:
        print("[ERR] 连不上 9222 —— 工作浏览器没启动。")
        print("      先跑: powershell -ExecutionPolicy Bypass -File tools\\launch_pdd_browser.ps1")
        print("      原因: {}".format(e))
        return False


def find_page(match):
    targets = _req("/json/list")
    pages = [t for t in targets if t.get("type") == "page"]
    print("[..] 当前页面数: {}".format(len(pages)))

    # 优先命中后台主体页（/home/），避免选中登录页
    hits = [t for t in pages if match in (t.get("url") or "")]
    hits.sort(key=lambda t: 0 if "/home" in (t.get("url") or "") else 1, reverse=False)
    for t in hits:
        u = t.get("url") or ""
        if "/login" in u:
            print("[!] 命中登录页: {}".format(u[:110]))
            print("    → 请在这个工作浏览器窗口里扫码登录，登录完成后再跑一次本命令")
            return t
        print("[OK] 命中后台页: {}".format(u[:110]))
        return t
    return None


def open_page(url):
    print("[..] 没有匹配页，新开: {}".format(url))
    q = urllib.parse.quote(url, safe="")
    for method in ("PUT", "GET"):
        try:
            t = _req("/json/new?url=" + q, method=method)
            if isinstance(t, dict) and t.get("webSocketDebuggerUrl"):
                time.sleep(3.0)
                return t
        except Exception as e:
            print("      {} 失败: {}".format(method, e))
    return None


class CDP(object):
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=120, suppress_origin=True)
        self._id = 0

    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        # 跳过事件，等我们的回包
        while True:
            raw = self.ws.recv()
            if not raw:
                continue
            msg = json.loads(raw)
            if msg.get("id") == self._id:
                return msg

    def evaluate(self, expression, await_promise=True):
        return self.send("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": await_promise,
            "returnByValue": True,
            "userGesture": True,
        })

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("js_file", help="要执行的 JS 文件路径")
    ap.add_argument("--url", default=DEFAULT_MATCH, help="页面 URL 匹配串")
    ap.add_argument("--open", default=TARGET_URL, help="没找到页面时新开的 URL")
    args = ap.parse_args()

    if not os.path.isfile(args.js_file):
        print("[ERR] JS 文件不存在: {}".format(args.js_file))
        return 2

    if not check_debug_port():
        return 2

    target = find_page(args.url)
    if target is None:
        target = open_page(args.open)
    if target is None:
        print("[ERR] 打不开目标页")
        return 2

    ws_url = target.get("webSocketDebuggerUrl")
    if not ws_url:
        print("[ERR] 目标页没有 websocket 调试地址（可能是扩展/后台页）")
        return 2

    with open(args.js_file, "r", encoding="utf-8") as f:
        code = f.read()

    cdp = CDP(ws_url)
    try:
        cdp.send("Runtime.enable")
        res = cdp.evaluate(code)
    finally:
        cdp.close()

    if "error" in res:
        print("[ERR] 执行出错: {}".format(json.dumps(res["error"], ensure_ascii=False)))
        return 1

    result = (res.get("result") or {}).get("result") or {}
    if "exceptionDetails" in (res.get("result") or {}):
        print("[ERR] JS 抛异常:")
        print(json.dumps(res["result"]["exceptionDetails"], ensure_ascii=False, indent=2)[:3000])
        return 1

    val = result.get("value")
    print("\n=== 返回值 ===")
    if isinstance(val, (dict, list)):
        print(json.dumps(val, ensure_ascii=False, indent=2)[:6000])
    else:
        print(val)
    print("\n（页面内 console.log 的内容请在该浏览器的 F12 里看；本脚本只回传表达式的返回值）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
