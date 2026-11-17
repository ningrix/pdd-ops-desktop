# AGENTS.md

> 本工作区的工程约定。**任何 agent 在动代码前必须读完。**
> 与用户当次明示冲突时，以用户为准，事后回写本文档。
>
> 最后更新：2026-11-17 ｜ 对应应用版本：v0.3（采集箱 + 跨店上架 + 平台锁）

**关于定位方式**：本文档一律用**函数名 / 选择器**指位置，不写行号。`main.js` 曾在六小时内从 635 行涨到 1096 行，行号第二天就会失效。

**并行协作前必读**：本仓库已初始化 git（baseline commit `725600c`）。多 agent 并行前先读 `C:\Users\56587\.workbuddy\plans\协作分工_lead与workbuddy_2026-11-17.md`。

---

## 0. 这个工作区在做什么

两条业务线，共享一个 Electron 桌面应用 `app/`：

- **A 线 · 上货优化** —— 把商品采集进本地池，优化标题 / 价格 / 图片 / 属性，再上架到任意店铺。
- **B 线 · 售后对账** —— 售后单分诊、一键申诉举证、拼多多账单核对。（未开工）

业务背景：拼多多鞋类 / 服装卖家。品类决定两个高频痛点——退货率高（尺码问题）、仅退款多。

**沟通原则**：用户不看概念，只问「能不能落地、成本多少」。少铺垫、给结论、附证据。

---

## 1. 硬约束（违反即返工）

### 1.1 渲染层

1. **禁止 `type="module"` / `import` / `export`。** 页面由 `loadFile()` 以 `file://` 加载，ES module 会被 CORS 阻止；`main.js` 里 `Menu.setApplicationMenu(null)` 清空了应用菜单，DevTools 进不去。**加载失败是静默白屏，没有任何报错。**
2. 多文件时每个文件整体包 IIFE，只向 `window.UI` 挂一个对象。经典 script 共享同一全局词法环境，**重名 `const` 是解析期 SyntaxError，整个文件不执行**。末尾断言命名空间齐全。
3. **`#pane-browser` 的任何祖先元素不得使用** `transform` / `filter` / `perspective` / `will-change` / `contain:paint` / `backdrop-filter`。这些会建立新的 containing block，`getBoundingClientRect()` 返回值随之变化，`setBounds()` 会把原生浏览器视图贴到错误位置。
   另：`main.js` 顶部已 `disableHardwareAcceleration()`，毛玻璃在软件渲染下又慢又脏。
4. **原生视图可见性唯一由 `syncBounds()` 决定。** 目标是引入 `state.suspendDepth` 计数器，`>0` 时强制隐藏。当前实现靠 `withViewHidden()` 布尔挂起，`resize` 时会被绕过（见 §8）。
5. **任何浮层不得覆盖 `#pane-browser` 的矩形**（toast / 下拉 / tooltip 都会被原生层遮住）。全局提示放顶栏。
6. **视图可见性与弹窗 Promise 必须解耦。** 不得让「用户点关闭」成为恢复视图的唯一路径。
7. **原生视图摘掉后必须显式把键盘焦点还给 HTML 层。** `WebContentsView` 是原生子视图，被点过就持有原生键盘焦点；`removeChildView` 之后主窗口的 `webContents` **不会**自动重新获得焦点。症状：弹窗里 input 是 `document.activeElement`，但 `document.hasFocus() === false` —— 鼠标能点、**键盘打不进字、也删不掉字**。
   修法：`main.js` 的 `detachView()` 与 `view:toggle(false)` 里调用 `focusMainWindow()`；渲染层每次弹窗打开调 `window.pdd.focusWindow()`，并用 `focusInput()` 等两帧后重试 `focus + select`。已实测（`Input.insertText` 走真实输入路径、逐字符 `dispatchKeyEvent`、退格）：修复前 `hasFocus:false`，修复后 `hasFocus:true` 且能打中文/能删。
8. 需要重排时用 `ResizeObserver` 而不是手工调 `scheduleSync()`——新加的工具条、页签行高变化都不会触发 `window.resize`。
9. **窗口顶部即标题栏。** `main.js` 的 `BrowserWindow` 用 `titleBarStyle: 'hidden'` + `titleBarOverlay`，系统标题栏已隐藏，`.topbar` 兼任标题栏。三处必须同步，改一处就要改另两处：
   - `titleBarOverlay.height` == CSS `--topbar-h`
   - `titleBarOverlay.color` == CSS `--topbar-bg`
   - `.topbar` 的 `padding-right` 必须留出窗口按钮宽度（实测 136px，现留 152px）
   拖拽靠 `.topbar { -webkit-app-region: drag }`。**新增任何顶栏可点元素都必须补 `-webkit-app-region: no-drag`**，否则点击会被当成拖拽、按钮点不动。

### 1.2 平台操作红线

1. **提交上架、申诉提交、批量拦截一律不得自动执行**，必须人工确认。上架不可逆，申诉有次数限制。
2. **同店复制默认必须拦截。** `ops:copy` 要求显式 `allowSameStore`，这是有意设计——同店复制会产生重复链接，触发平台重复铺货判定。不得为了方便把它改成默认放行。
3. 批量任务必须有**全局互斥锁 + 看门狗**。无锁队列等于没有队列。
4. 超时 / 异常导致的**状态未知**，只允许「去后台核对」，**绝不重试**——那一刻远端草稿往往已经建好，重试就是第二条。
5. **不得声称能突破 8% 加价。** 这是平台规则，不是软件开关。利润从单买价与券结构来。
6. **不得把「加个水印 / 换个色调」当作避重手段**，平台图像指纹判定不看这个。
7. 拦截前必须校验两件事：货值是否高于「拦截费 + 退回运费」，包裹是否仍在派件前。
8. 复制前必须按 `goods_id` 校正列表下标，复制后必须比对返回的 `source.goods_id`。列表在下标之间可能已移位。

### 1.3 事实与数据

1. 涉及**平台规则、费用、接口是否存在、审核门槛**，一律先查官方资料再回答。**禁止凭印象推断。**
2. **查不到就说「未确认」，不许给近似答案事后纠正。** 这两条是本工作区已经付出过代价的：曾把「小程序测试号不支持云开发」当成可行、把「分享受限」误判成备案问题、把尺码表当成提交硬门槛。
3. 未确认项在代码注释与本文档里显式标注 `未确认：`。
4. **不引入需要原生编译的依赖**（`better-sqlite3` 等）。无构建步骤是硬前提，存储用 JSON / NDJSON。
5. **金额一律用「分」为单位的整数**，不用浮点。
6. 布尔字段表示「未知」时用 `null`，不用 `false`。

---

## 2. 代码地图

| 路径 | 职责 | 可改性 |
| --- | --- | --- |
| `app/main.js` | 窗口、店铺视图池、全部 IPC、改价抓包（CDP）、跨店上架编排、session flush | 需用户明示，**只做增量**，不动既有 IPC 签名 |
| `app/preload.js` | `contextBridge` 暴露 `window.pdd` | 需用户明示，新增只加不改 |
| `app/lib/ops.js` | 注入拼多多页面执行的业务 JS（**已实测跑通**） | **禁止重构** |
| `app/lib/pool.js` | 采集箱本地存储（增删查）；**读取时对 gallery 去重** | 可改 |
| `app/lib/batch.js` | 批量队列（串行 + 间隔 + 失败分类 + 断点续跑） | 可改 |
| `app/lib/inspect.js` | 商品检测·规则层（纯 Node 零依赖，不读图） | 可改 |
| `app/lib/imgtool.js` | imgtool 的 Node 封装：spawn Python、下载图、失败分类 | 可改 |
| `tools/imgtool/` | Python 图像工具包（超分/水印/图像检测），见下 | 可改 |
| `app/renderer/index.html` | 界面结构（4 个页签：商品列表 / 采集箱 / 浏览器 / 原始结果） | 可改，守 §1.1 |
| `app/renderer/style.css` | 样式（无框架、无预处理器） | 可改，守 §1.1 |
| `app/renderer/app.js` | 界面逻辑（单文件，全局 `$` / `state`） | 可改，守 §1.1 |
| `app/data/size-templates.json` | 尺码表模板库（6 套） | 可改 |
| `app/userdata/` | `malls.json`、`pool.json`、`Partitions/` 登录态 | **不得删除**，删了要重新扫码 |
| `tools/` | CDP 抓包与调试脚本（`cdp_capture.py`、`pdd.py`、`pdd_price.py`） | 可改 |
| `work/` | 实验脚本与中间产物 | 任意，可丢弃 |
| `research/` | 研究结论，**是事实来源** | 只追加不覆盖 |
| `交付/`、`交付样张/` | 已交付成品图（70+ 张） | 只读 |
| `assets/`、`putian-ref/`、`putian-shoe/` | 原始素材与视频工程 | 只读 |

### 两条上货路径（不要混淆）

| 路径 | 入口 | 机制 | 适用 |
| --- | --- | --- | --- |
| **A · 同店复制** | 商品列表 → 复制 | 在源店里克隆一条新的 | 极少用。会产生重复链接，默认被 `ops:copy` 拦截 |
| **B · 采集箱跨店** | 商品列表 → 采集 → 采集箱 → 上架到当前店 | 采集到本地池，再从池里上架到另一家店 | **主路径** |

路径 B 的实现（`pool:publish`）：
切到目标店 → 找**同品类**骨架 → 克隆骨架成草稿 → 打开发货草稿编辑页 → **滚动到「规格与库存」等懒渲染** → DOM 改颜色 → DOM 勾尺码 → **点页面「保存草稿」（让页面自己生成 spec_id）** → 抓最终载荷覆盖标题/主图/价格/库存 → 按源商品有无尺码表决定「沿用」或「置 0」 → 保存 → 提交。

**硬限制**：
- 目标店必须**已有同品类在售商品**才能当骨架。空店、或没有同品类商品，都无法跨店上架。
- 同一个骨架不能连续克隆：`600102 该商品已被新建过` 是时间性限流（实测成功后 1 分钟内再克隆必拒）。所以按「最久未用优先」轮换（`lib/skeleton.js`）。
- **尺码分两类，处理方式不同**：
  - **标准码**（36~45、S/M/L 这类）→ `ops.scanAllSizeSystems` 遍历 7 种码制，选覆盖源最全的那个再 `ops.setSizes` 勾选。
  - **自定义码**（`parent_id=1226`，值如 `2（90-100）` 自由文本）→ **不在任何标准码制里，遍历必然全缺**。目前**未实现**，需要找页面上的自定义尺码输入入口（线索：曾见过 placeholder 为 `未使用模板` 的文本框）。

### 渲染层三条关键机制

- **原生视图定位**：`#pane-browser` 的 `getBoundingClientRect()` → `window.pdd.setBounds()` → `main.js` 的 `view.setBounds()`。只在 `tab==='browser' && visible && 有店铺` 时显示。
- **弹窗必须先摘视图**：`WebContentsView` 是原生层，永远盖在 HTML 之上。
- **注入执行**：`view.webContents.executeJavaScript(ops.xxx())`，走页面自己的 `window.__mms.fetch.sync`，与页面请求同指纹。**永不包装 `window.fetch`**，平台指纹会识破。

---

## 3. 已验证的事实（不要重验，也不要推翻）

| 能力 | 证据 | 结论 |
| --- | --- | --- |
| 复制成草稿 | `research/复制上架实测记录_2026-11.md` | 调试浏览器直连同店 3/3 成功；链路 `create_by_sn → copyGoodsCommit → rename → detail` |
| 改价 | `research/改价接口打通_2026-11.md` | `action/edit` 载荷回放通过。**从零拼字段会报 4000000，不要走那条路** |
| 提交上架 | `research/提交门槛纠正_2026-11.md`、`research/提交上架打通_2026-11.md` | **接口已通，实测成功**（`提交(206438982955): ok`）。⚠️ **`17000001 满2件折扣` 是误导性错误**：库存为 0 时平台会用它伪装，把库存补到 50 后该错误消失。真门槛是尺码表 `10000014` |
| 跨店上架 | `research/跨店上架完全打通_2026-11-18.md` | **全链路已打通**（源标题+主图+颜色+尺码+价格+提交，实测 36 SKU 成功）。关键是 DOM 改规格 + 页面保存 + 清空继承尺码表。详见 §2「路径 B」 |
| 跨店规格搬运机制 | 同上 | `action/edit` **静默丢弃** skus 变更（返回 ok，重载后不变）。必须：DOM 改颜色/尺码 → 点页面「保存草稿」让页面生成 spec_id → 再抓载荷改价格。规格区是**懒渲染**，不滚到视口根本不渲染 |
| 尺码表（跨店） | 同上 | 源商品 `size_spec_id` 为空 = 该类目不要求尺码表。骨架继承的旧表在改码后会冲突，报 `10000014`。解法：把 `size_spec_id` / `size_parent_spec_id` / `is_size_spec_sync_detail` 全部置 0 |
| 参考价规则 | 同上 | `1000161 规格单买价格必须小于参考价格` —— `market_price` 必须**严格大于**所有 SKU 的最大单买价，相等也会被拒 |
| 删草稿接口 | 实测 | `POST /glide/v2/mms/edit/commit/delete`，参数 `{goods_commit_id, goods_id}`，成功返回 `true` |
| 尺码表接口 | `research/尺码表接口打通_2026-11.md` | `POST /glide/forward/cabernet/mms/sizespec/action/post`。body = `{content:{meta:{groups:[{id:1}],elements:[{id:N}]},records:[{values:{...}}]},status:0,class_id:N}`，每调一次生成新 spec id。绑定靠编辑载荷的 `size_spec_id` + `size_parent_spec_id`(=1226) + `is_size_spec_sync_detail`(=1) |
| 尺码表 class_id | 实测（1~12 全扫） | 按类目而定。运动羽绒服（cat 12508）= **5**。判断依据：只有正确 class 才会告诉你「缺哪个参数」，错误的只会回 `10000013 请选择该类目下正确的尺码表类型` |
| 尺码表参数 id | 实测 | `10004` = 推荐身高。**`体重(kg)` 的 id 未知**（10000~10049 已排除）。一张表最多 5 个参数，重复列会报「内容不完整」 |
| 平台互斥锁 | `main.js` 的 `withPlatform()` | 所有 `runInMall` / `saveDraftAndResolve` / `captureEditBody` 强制串行排队 + 超时看门狗。理由：`loadURL` 会抢视图、`webContents.debugger` 不能两处同时 attach |
| 采集箱 | `main.js` `pool:*` + `lib/pool.js` + `ops.collectGoods` | 采集 → 本地池 → 跨店上架已接成闭环 |
| 尺码匹配 | `main.js` `size:match` + `app/data/size-templates.json` | 支持「按商品尺码标签」优先，类目关键词兜底；返回 `bySizes` 标明命中方式 |
| 登录态持久 | `main.js` `before-quit` → `flushStorageData()` | 必须走正常关窗，强杀丢登录态。**启动/重启一律用 `tools/restart-app.ps1`**：它先请窗口自己关闭、等 `flushStorageData()` 完成，超时才降级强杀并警告。已实测：`taskkill /F` 会让两个店铺同时掉登录、Cookies 文件退化成 80 字节空壳 |
| 图像管线 | `交付/` 70+ 张成品 | 去标 / 去水印 / 4x 超分 / 白底；Real-ESRGAN + LaMa + RapidOCR，CPU 15–25s/张 |
| 图像工具包 | `tools/imgtool/`（Python）+ `app/lib/imgtool.js`（Node 封装） | **已跑通**：`upscale`（手写 RRDBNet，加载 RealESRGAN 权重 missing=0/unexpected=0）、`watermark`（corner/tile/band 三模式 + 自适应深浅色）、`inspect`（尺寸/比例/白底/居中/文字覆盖）。CLI 只往 stdout 写一行 JSON |
| 商品检测 | `app/lib/inspect.js` | **已跑通**：规则层纯 Node 零依赖。检查标题长度/堆砌/重复、SKU 价格逻辑、`market_price` 严格大于最高单买价（实测规则 1000161）、主图数量/重复、尺码表、类目。分 error/warn/info 三级，无官方依据的项标 `unconfirmed:true` |
| 图集去重 | `ops.collectGoods` + `lib/pool.js` | **平台返回的 `galleries` 本身带重复**（实测 21 项只有 11 个唯一 URL）。采集侧去重，读取侧再兜一层（旧数据也生效）。不去重会导致加水印重复处理、上架后主图重复图位 |
| 尺码是「自定义」不是标准码制 | 实测源商品 SKU spec | **很多商品的尺码是商家自定义的**：`parent_id=1226`（尺码）、`spec_id` 是该商品私有的、值是 `2（90-100）` 这类自由文本，**不在「通用/中国码/欧码/英码/德码/美码/均码」任一标准码制里**。所以「遍历 7 种码制找覆盖最好」对这类商品永远失败（缺码 = 全部）。正确方向：找页面上的「自定义尺码」输入入口（曾观测到一个 placeholder 为 `未使用模板` 的文本框），**未验证** |
| 骨架频控 | `lib/skeleton.js` | `600102 该商品已被新建过` 是**时间性限流**，实测：同一骨架克隆成功后 1 分钟再克隆就被拒。窗口期平台未公开。对策：记录每个骨架最近使用时间、按最久未用优先轮换；全失败时把每个骨架的「X 分钟前用过」列出来 |
| 骨架需有颜色规格 | `ops.listGoods` 的 `colors/colorCount` | 改颜色是在页面**已有的**颜色输入框里填值。骨架本身没有颜色规格时页面上没有输入框可填，颜色必然设不进去（实测：骨架 0 个颜色框 / 源 5 个颜色）。所以源有颜色时优先挑 `colorCount > 0` 的骨架 |
| 注入脚本语法校验 | `tools/check-injections.js` | `ops.js` 用模板字面量拼注入代码。拼错了 Electron 只回一句 "Script failed to execute"，看不出哪错。这个脚本用 `vm.Script` 编译全部注入脚本并打印出错行。**已踩过的坑**：在模板字面量里写注释，注释里的 `\n` 变成真实换行截断注释，后半句变成代码 → 整体语法错误 |
| 异常转文本 | `main.js` 的 `errText()` | Electron 的 `executeJavaScript` 在页面抛非 Error 值时 reject 出的是普通对象，`String(e)` 得到 `[object Object]`，真实原因全丢。必须用 `errText()` 递归取 `error`/`message`/`reason`/JSON |
| Python 环境 | 本机 | Pillow **必须 ≥ 11**：9.5.0 在这个环境下 `draw.text()` 直接崩 `0xC0000005`（ACCESS_VIOLATION）。`simple-lama-inpainting` 已卸载（它要求 pillow<10，会把版本拖回去；LaMa 预处理我们手写） |
| 三档定价 | `research/验证A_加价上限结论_2026-11.md` | 拼单价钳 1.08、单买价放开、市场价 > 单买价。多家厂商官方文档交叉印证 |
| 基础技术服务费 | 拼多多 2024 公告（媒体转述） | (实付 + 平台优惠) × 0.6%；先用后付同为 0.6%；2024-09-24 后退款订单自动退回 |
| 黑标技术服务费 | 同上 | 仅黑标商品，类目差异化费率（服饰 2.2%）；同单取最高费率不重复扣 |
| 物流拦截机制 | 官方《物流拦截技术支持服务规则》`mms.pinduoduo.com/other/rule?id=1616` | 仅派件前有效；到驿站/已签收必失败；拦截成功自动退款；退回运费商家承担；拦截账户余额**不可提现** |
| 错误码字典 | `app/renderer/app.js` 的 `runCopy` / `publishFromPool` | `600102` 已复制过 / `17000001` 满2件折扣 / `10000014` 尺码表 / `3000000` 参数不合法 / `600001` 编辑记录不存在 |

---

## 4. 明确的未知（不许当成已知）

| 未知项 | 影响什么 | 怎么验证 |
| --- | --- | --- |
| 1.08 钳制在「同店复制」通道是否生效 | 定价引擎是否必须内置钳制 | 跑 `work/pdd_price_probe.js`（只建草稿不提交） |
| 售后 / 拦截单 / 对账中心的 API 端点 | B 线是真自动还是半自动 | `tools/cdp_capture.py` 抓包 |
| `quantity_delta` 语义（增量还是绝对值） | 能否做改库存 | 抓包后看草稿态是否回显 |
| 图片上传接口 | 图片自动替换的工作量是否翻倍 | 抓编辑页上传请求 |
| 申诉次数限制的具体规则 | 申诉模块的护栏强度 | 官方文档未见，只能从实操累积 |
| 跨店上架后平台是否判「搬运」 | 路径 B 的长期可行性 | 小批量试，观察是否限流 |

**降级路径**：端点抓不到就走「页面导出 Excel/CSV → 本地解析」。逻辑不变，只损失自动化，不损失分析能力。

---

## 5. 失败分类（写任务状态时必须遵守）

```
queued → running → done
                 ├→ failed_known    确定失败，可重试
                 └→ failed_unknown  状态未知，只允许人工核对
```

- **`failed_known`**：接口明确返回业务错误（`600102` / `3000000` 等），且失败发生在**创建之前**。
- **`failed_unknown`**：超时、异常、只走到一半。此时远端资产**可能已存在**。

> 把两者合并成一个 `failed`，批量任务就会自己造重复草稿。
> 这是本项目最贵的一条教训，不要重犯。

---

## 6. 数据结构约定

```js
// 采集箱条目（lib/pool.js，落盘 app/userdata/pool.json）
PoolItem {
  id, createdAt,
  title, catId, catNames[], price, sizes[],
  skus[], gallery[], thumb,
  sourceMallId, sourceMallName, sourceGoodsId
}
// 去重规则：同一 sourceMallId + sourceGoodsId 只保留一条，重复采集是覆盖不是新增

// 售后单（B 线，未实现）
AftersaleOrder {
  asn, orderSn, mallId, goodsId, goodsName, skuSpec,
  type: refund_only | return_refund | exchange,
  reason, amount,                  // 金额单位：分
  createdAt, deadlineAt,           // 分诊排序第一键
  status: pending_merchant | pending_buyer_ship | pending_receive
        | refunded | closed | appealing,
  refundedAt, serviceFeeRefunded,  // null = 未知，不是 false
  intercept: { state: none|requested|success|failed|unsupported, fee, at },
  returnShip: { company, trackingNo, shippedAt, signedAt, received },
  risk: money_goods_lost | in_transit | safe | closed,
  appeal: { state: none|drafted|submitted|won|lost, at, evidenceMissing[] }
}

// 对账条目（B 线，未实现）
BillEntry {
  date, orderSn, category, amount, traceable
  // base_tech_fee | black_label_fee | freight_insurance
  // | refund | coupon_seller | subsidy | ad_spend
  // ad_spend 的 traceable 恒为 false
}

// 批量任务（lib/batch.js，落盘 app/userdata/batch.json）—— 已实现
BatchTask {
  poolId, title, mallId,
  state: queued | running | done | failed_known | failed_unknown,
  attempts, errorCode, errorMsg,
  goodsId, commitId, startedAt, endedAt
}
// 重试规则：queued 与 failed_known 可重跑（默认最多 2 次）；
//           failed_unknown 与 done 一律跳过 —— 前者必须人工核对
```

三条铁律：

1. **表示「未知」用 `null`，不要用 `false`。** 把「没发生」和「还不知道」混成一个值，对账必然算错。
2. **推广费（`ad_spend`）在平台账单里是日汇总，物理上无法追溯到单笔订单。** 任何声称能精确对到单的实现都是错的。只能按日分摊。
3. **金额单位一律是分。**

---

## 7. 改动前先问自己

| 想做的事 | 先确认 |
| --- | --- |
| 改 `main.js` / `preload.js` | 用户是否明示？只做增量，不动既有 IPC 签名 |
| 改 `lib/ops.js` | 是否有实测脚本能验证？没有就不要动 |
| 删 `app/userdata/` 下任何东西 | 会丢登录态与采集箱，需用户确认 |
| 加依赖 | 是否需要原生编译？需要则换方案 |
| 声称某个平台能力可行 | 官方资料在哪？没有就说「未确认」 |
| 加需要覆盖 `#pane-browser` 的 UI | 会被原生层遮住，换位置 |
| 把同店复制的拦截去掉 | 会产生重复链接，触平台重复铺货 |

---

## 8. 现存缺陷（截至本次核实）

**已修**：
- `openCopyDialog()` 会重置 `#copyPublish`；`#copyOk` 完成后 `onclick` 改为 `close`
- `#copyFactor` 加了 `input/change/keyup` 监听，改倍数时价格预览实时更新
- `copyGoods` / `collectGoods` 改为**按 `goods_id` 精确认商品**（`goodsId` 参数），不再依赖列表下标；找不到就明确报错
- 两个批量前置缺陷已清除，批量队列已启用

**仍在**：

| 缺陷 | 位置 | 后果 |
| --- | --- | --- |
| 复制完成后「再复制一条」按钮实际执行 `close` | `app.js` 的 `openCopyDialog` 内 `#copyOk.onclick` 尾段 | 文案与行为不符，点了只会关闭 |
| `withViewHidden()` 用局部布尔挂起视图，且 `finally` 无条件恢复 | `app.js` 与 `syncBounds` | 弹窗开着时拖窗口 / 切页签 → 原生视图压回弹窗上；快速双击「添加店铺」可使视图永久隐藏 |
| `refreshStatus()` 串行 `await`，单店无 try/catch | `app.js` | 改价期间 `loadURL` 会让健康店铺显示为离线；IPC reject 会中断整轮 |
| 删除店铺用 `window.confirm()` | `app.js` 的 `refreshMalls` 内点击处理 | 原生模态冻结界面，无法做输入店铺名确认 |
| `listGoods` 硬编码取 30 条，`total` 未显示 | `main.js` `ops:list` / `app.js` | 用户以为看到全部，实际只有前 30 条 |
| 日志时间戳源不一致 | `main.js` 的 `log()` 已改本地时间；`trace()` 仍是 UTC | 日志框正常，trace 文件里是 UTC |
| 上架库存默认 50 | `app.js` 调 `publish` / 批量参数 | 单件上架仍用 50；批量可在界面配置 |
| 跨店价格统一用源最低拼单价 | `main.js` 的 `pool:publish` 价格覆盖段 | 源的逐 SKU 差价没搬过来 |
| 跨店详情图未覆盖 | 同上 | 只换了主图（`galleries`），`decorationDetail` 仍是骨架的 |
| 采集箱里 6 条旧条目的 `sourceMallId` 指向已删除的旧店铺 | `app/userdata/pool.json` | 跨店判断时同店比较会失效；可手动移除这些条目 |

---

## 9. 文档维护

- 未确认项一旦验证，从 §4 移到 §3，并附证据文件路径。
- 代码改动触及 §1 / §5 / §6 时，**同一次改动内更新本文档**。
- 本文档只写**约束与事实**，不写计划、路线图、待办。计划放 `C:\Users\56587\.workbuddy\plans\`。
- 新增约束时写清楚「为什么」，否则下一个人会当成教条绕过它。
- **不要写行号。** 用函数名、选择器、IPC 通道名定位。
