# -*- coding: utf-8 -*-
"""自建 vs 采购 TCO 测算表（带公式，可改参数）"""
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

wb = openpyxl.Workbook()
wb.calculation.fullCalcOnLoad = True

HDR = PatternFill("solid", fgColor="1F3864")
HDRF = Font(name="微软雅黑", size=10, bold=True, color="FFFFFF")
BODY = Font(name="微软雅黑", size=9)
BOLD = Font(name="微软雅黑", size=9, bold=True)
TITLE = Font(name="微软雅黑", size=14, bold=True, color="1F3864")
NOTE = Font(name="微软雅黑", size=9, italic=True, color="595959")
IN_FILL = PatternFill("solid", fgColor="FFF2CC")   # 可编辑
OUT_FILL = PatternFill("solid", fgColor="E2EFDA")  # 公式输出
WARN = PatternFill("solid", fgColor="FCE4E4")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def setup(ws, title, subtitle, ncol):
    ws.sheet_view.showGridLines = False
    ws["A1"] = title
    ws["A1"].font = TITLE
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=ncol)
    ws.row_dimensions[1].height = 26
    ws["A2"] = subtitle
    ws["A2"].font = NOTE
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=ncol)
    ws.row_dimensions[2].height = 18
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.page_margins.left = ws.page_margins.right = 0.3


def header_row(ws, row, headers):
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=row, column=c, value=h)
        cell.fill = HDR
        cell.font = HDRF
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[row].height = 36


def widths(ws, ws_widths):
    for i, w in enumerate(ws_widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


# ============================================================
# Sheet 1 参数
# ============================================================
ws1 = wb.active
ws1.title = "1-参数"
setup(ws1, "测算参数", "黄色格子是你可以改的，改完所有页签自动重算", 5)
header_row(ws1, 3, ["参数", "值", "单位", "说明", ""])

params = [
    ("S  店铺数", 10, "个", "你实际在运营的拼多多店铺数"),
    ("P  操作员电脑数", 5, "台", "团队每人一台的台数；这是软件授权最常卡的地方"),
    ("Q  日均上货量", 300, "个/天", "决定你需不需要「无数量限制」档"),
    ("人日成本", 500, "元/人日", "内部核算口径，可按你团队薪资折算"),
    ("首次开发人日", 15, "人日", "用开源骨架 + AI 辅助编码的目标值；从零写要 40+"),
    ("年维护人日/月", 1.5, "人日/月", "平台改版就要修，这是最容易低估的一项"),
    ("摊销年数", 3, "年", "开发投入分几年摊"),
    ("现金支出", 1500, "元/年", "代理IP、LLM API、图床等（本地部署无服务器费）"),
    ("点券单价", 1.0, "元/点券", "天牛掌柜点券制，单价未公开，按 1:1 估"),
]
r = 4
for name, val, unit, note in params:
    ws1.cell(row=r, column=1, value=name).font = BOLD
    c = ws1.cell(row=r, column=2, value=val)
    c.fill = IN_FILL
    c.font = Font(name="微软雅黑", size=11, bold=True, color="C00000")
    c.alignment = Alignment(horizontal="center")
    ws1.cell(row=r, column=3, value=unit).font = BODY
    ws1.cell(row=r, column=4, value=note).font = BODY
    for cc in range(1, 5):
        ws1.cell(row=r, column=cc).border = BORDER
    ws1.row_dimensions[r].height = 22
    r += 1

widths(ws1, [22, 12, 12, 60, 2])
ws1.freeze_panes = "A4"

# ============================================================
# Sheet 2 年成本对比
# ============================================================
ws2 = wb.create_sheet("2-年成本对比")
setup(ws2, "采购 vs 自建：年成本对比",
      "公式实时引用「1-参数」。结论口径：只有在订阅年费 > 自建年化成本时，自建才在「省钱」这一项上成立", 7)
header_row(ws2, 3, ["方案", "计费口径", "年成本（元）", "能否拼上拼", "团队多人", "备注", "成本排名\n(仅限支持拼上拼)"])

P_S = "'1-参数'!$B$4"   # 店数
P_P = "'1-参数'!$B$5"   # 电脑数
P_UNIT = "'1-参数'!$B$12"  # 点券单价

rows = [
    ("尘牛管家", "18元/月/店", f"=216*{P_S}", "◐", "按店订购，同账号",
     "同平台限 200 个/店/天，日上货量大就不够", None),
    ("尘牛ERP", "36元/月/店", f"=432*{P_S}", "◐", "按店订购",
     "上货无数量限制，官方接口里最实用的档", None),
    ("甩手 标准版", "78元/年/店（折后）", f"=78*{P_S}+MAX(0,{P_P}-5)*20", "○", "1账号5台电脑，超出+20元/台",
     "官方口径已不支持拼上拼，需绕淘宝中转", None),
    ("甩手 高级版", "138元/年/店（折后）", f"=138*{P_S}+MAX(0,{P_P}-5)*20", "○", "同上",
     "高级版才有完整批量编辑", None),
    ("万店精灵", "40元/店/月起", f"=40*12*{P_S}", "●", "客户端",
     "免API订购，多平台通吃", None),
    ("天牛掌柜 点券版", "500元/年+点券", f"=500+MAX(0,120*{P_S}-500)*{P_UNIT}+720", "●", "多开",
     "发布10点券/店/月，采集60点券/月；送500点券", None),
    ("天牛掌柜 至尊版", "9988元/年 全功能", "=9988", "●", "待确认是否限机器",
     "「任用所有功能」不限店——店数一多它就是地板价", None),
    ("自建 年化成本", "开发摊销+维护+现金", "='3-自建成本'!$C$7", "●", "不限人数",
     "见「3-自建成本」页签", None),
]

r = 4
pp_rows = []
for name, basis, formula, pp, team, note, _ in rows:
    if pp in ("●", "◐"):
        pp_rows.append(r)
    ws2.cell(row=r, column=1, value=name).font = BOLD
    ws2.cell(row=r, column=2, value=basis).font = BODY
    c = ws2.cell(row=r, column=3, value=formula)
    c.number_format = '#,##0'
    c.fill = OUT_FILL
    c.font = Font(name="微软雅黑", size=11, bold=True)
    c.alignment = Alignment(horizontal="right")
    ws2.cell(row=r, column=4, value=pp).font = Font(name="微软雅黑", size=11, bold=True)
    ws2.cell(row=r, column=5, value=team).font = BODY
    ws2.cell(row=r, column=6, value=note).font = BODY
    for cc in range(1, 8):
        ws2.cell(row=r, column=cc).border = BORDER
    ws2.cell(row=r, column=4).alignment = Alignment(horizontal="center")
    ws2.cell(row=r, column=5).alignment = Alignment(horizontal="center", wrap_text=True)
    ws2.cell(row=r, column=6).alignment = Alignment(wrap_text=True, vertical="center")
    ws2.row_dimensions[r].height = 34
    r += 1

for rr in range(4, r):
    f = (f'=IF(D{rr}="○","不适用（不支持拼上拼）",'
         f'SUMPRODUCT(($D$4:$D${r-1}<>"○")*($C$4:$C${r-1}<C{rr}))+1)')
    cell = ws2.cell(row=rr, column=7, value=f)
    cell.alignment = Alignment(horizontal="center")
    cell.border = BORDER
    cell.font = Font(name="微软雅黑", size=10, bold=True, color="1F3864")

ws2.cell(row=r + 1, column=1, value="最低成本（仅限支持拼上拼的方案）").font = BOLD
ws2.merge_cells(start_row=r + 1, start_column=1, end_row=r + 1, end_column=2)
cmin = ws2.cell(row=r + 1, column=3)
cmin.value = "=MIN(" + ",".join(f"C{x}" for x in pp_rows) + ")"
cmin.number_format = '#,##0'
cmin.fill = WARN
cmin.font = Font(name="微软雅黑", size=12, bold=True, color="C00000")
cmin.alignment = Alignment(horizontal="right")
ws2.cell(row=r + 1, column=6,
         value="→ 若这个区间里最便宜的不是「自建」，说明纯按省钱算买更划算；自建的价值在能力与团队授权").font = NOTE

# 方案名提示（数据条：标记自建行）
ws2.cell(row=3, column=1).comment = None

widths(ws2, [20, 20, 16, 12, 22, 46, 24])
ws2.freeze_panes = "B4"

# ============================================================
# Sheet 3 自建成本
# ============================================================
ws3 = wb.create_sheet("3-自建成本")
setup(ws3, "自建成本拆解", "改「1-参数」里的开发人日/维护人日，这里自动重算", 4)
header_row(ws3, 3, ["项目", "一次性 / 年度", "金额（元）", "说明"])

selfcost = [
    ("首次开发（摊销后）", "年度摊销", "='1-参数'!B8*'1-参数'!B7/'1-参数'!B10", "开发人日 × 人日成本 ÷ 摊销年数"),
    ("年维护", "年度", "='1-参数'!B9*12*'1-参数'!B7", "维护人日/月 × 12 × 人日成本（平台改版就要修）"),
    ("现金支出", "年度", "='1-参数'!B11", "代理IP / LLM API / 图床（本地部署无服务器费）"),
]
r = 4
for name, kind, formula, note in selfcost:
    ws3.cell(row=r, column=1, value=name).font = BOLD
    ws3.cell(row=r, column=2, value=kind).font = BODY
    c = ws3.cell(row=r, column=3, value=formula)
    c.number_format = '#,##0'
    c.fill = OUT_FILL
    c.font = Font(name="微软雅黑", size=11, bold=True)
    ws3.cell(row=r, column=4, value=note).font = BODY
    for cc in range(1, 5):
        ws3.cell(row=r, column=cc).border = BORDER
    ws3.row_dimensions[r].height = 24
    r += 1

r = 7
ws3.cell(row=r, column=1, value="合计年化成本").font = Font(name="微软雅黑", size=11, bold=True)
ws3.cell(row=r, column=2, value="元/年").font = BODY
ws3.cell(row=r, column=3, value="=SUM(C4:C6)").number_format = '#,##0'
ws3.cell(row=r, column=3).fill = WARN
ws3.cell(row=r, column=3).font = Font(name="微软雅黑", size=13, bold=True, color="C00000")
ws3.cell(row=r, column=4, value="← 这个数就是「2-年成本对比」里自建那一行").font = NOTE
for cc in range(1, 5):
    ws3.cell(row=r, column=cc).border = BORDER

# 非货币成本
r = 9
ws3.cell(row=r, column=1, value="不折成钱、但必须计入的代价").font = Font(name="微软雅黑", size=11, bold=True, color="C00000")
hidden = [
    ("单点故障", "工具挂了 → 全团队停工，没有客服可找，只能自己修"),
    ("错误放大", "一个人配错加价公式 → 所有人批量任务一起执行 → 集体资损"),
    ("封店连带", "团队共用一套节奏/设备去铺货 → 触发四维关联识别 → 店群一起限流"),
    ("知识孤岛", "流程全在你一个人脑子里，团队无法自助排查"),
    ("平台改版", "后台一改版，采集/上货通道全断，必须当天修好"),
]
r = 10
for a, b in hidden:
    ws3.cell(row=r, column=1, value=a).font = BOLD
    ws3.cell(row=r, column=4, value=b).font = BODY
    ws3.merge_cells(start_row=r, start_column=1, end_row=r, end_column=3)
    ws3.cell(row=r, column=4).alignment = Alignment(wrap_text=True, vertical="center")
    for cc in range(1, 5):
        ws3.cell(row=r, column=cc).border = BORDER
    ws3.row_dimensions[r].height = 30
    r += 1

widths(ws3, [26, 16, 18, 56])
ws3.freeze_panes = "A4"

# ============================================================
# Sheet 4 盈亏平衡
# ============================================================
ws4 = wb.create_sheet("4-盈亏平衡点")
setup(ws4, "盈亏平衡点：店数要达到多少，自建才比采购便宜",
      "公式自动算。若平衡点远高于你的实际店数 → 纯省钱这条路不成立，价值要锚在能力和团队授权上", 5)
header_row(ws4, 3, ["对比方案", "单店年成本（元/店）", "自建年化（元）", "平衡店数（个）", "判读"])

C = "'3-自建成本'!$C$7"
S = "'1-参数'!$B$4"
be = [
    ("尘牛管家", "=216", "=IFERROR(ROUNDUP(" + C + "/216,0),\"—\")"),
    ("尘牛ERP", "=432", "=IFERROR(ROUNDUP(" + C + "/432,0),\"—\")"),
    ("甩手 标准版", "=78", "=IFERROR(ROUNDUP(" + C + "/78,0),\"—\")"),
    ("万店精灵", "=480", "=IFERROR(ROUNDUP(" + C + "/480,0),\"—\")"),
    ("天牛掌柜 至尊版", "固定 9988/年", "=IF(" + C + ">9988,\"不限店数，自建更贵\",\"不限店数，至尊更便宜\")"),
]
r = 4
for name, unitc, formula in be:
    ws4.cell(row=r, column=1, value=name).font = BOLD
    c2 = ws4.cell(row=r, column=2, value=unitc)
    c2.font = BODY
    c2.alignment = Alignment(horizontal="center")
    ws4.cell(row=r, column=3, value="=" + C).number_format = '#,##0'
    c = ws4.cell(row=r, column=4, value=formula)
    c.fill = OUT_FILL
    c.font = Font(name="微软雅黑", size=12, bold=True, color="C00000")
    c.alignment = Alignment(horizontal="center")
    ws4.cell(row=r, column=5, value=f'=IF(ISNUMBER(D{r}),IF({S}>=D{r},"你已超过平衡点 → 自建省钱","还差 "&(D{r}-{S})&" 个店 → 现在买更省"),"—")')
    ws4.cell(row=r, column=5).font = BODY
    for cc in range(1, 6):
        ws4.cell(row=r, column=cc).border = BORDER
    ws4.row_dimensions[r].height = 26
    r += 1

widths(ws4, [22, 20, 18, 20, 40])

# ============================================================
# Sheet 5 店数情景矩阵
# ============================================================
ws6 = wb.create_sheet("5-店数情景矩阵")
setup(ws6, "不同门店规模下的年支出（元/年）",
      "只保留「能拼上拼」的方案做对比；甩手已不支持拼上拼，不参与比价。绿色=该规模下最省", 8)
header_row(ws6, 3, ["店铺数", "尘牛管家\n(不支持拼上拼)", "尘牛ERP\n(不支持拼上拼)",
                    "万店精灵\n40/店/月", "天牛点券版", "天牛至尊版", "自建\n(年化)", "该规模最省（含拼上拼）"])

P_P = "'1-参数'!$B$5"
P_UNIT = "'1-参数'!$B$12"
CB = "'3-自建成本'!$C$7"

scenarios = [3, 5, 10, 20, 30, 50, 80]
r = 4
for S in scenarios:
    ws6.cell(row=r, column=1, value=S).font = Font(name="微软雅黑", size=11, bold=True)
    ws6.cell(row=r, column=1).alignment = Alignment(horizontal="center")
    vals = {
        2: f"=216*{S}",
        3: f"=432*{S}",
        4: f"=40*12*{S}",
        5: f"=500+MAX(0,120*{S}-500)*{P_UNIT}+720",
        6: "=9988",
        7: f"={CB}",
    }
    for col, formula in vals.items():
        c = ws6.cell(row=r, column=col, value=formula)
        c.number_format = '#,##0'
        c.font = Font(name="微软雅黑", size=10)
        c.alignment = Alignment(horizontal="right")
        c.border = BORDER
    ws6.cell(row=r, column=1).border = BORDER
    # 该规模最省（仅 万店/天牛点券/天牛至尊/自建）
    c = ws6.cell(row=r, column=8,
                 value=f"=MIN(D{r}:G{r})")
    c.number_format = '#,##0'
    c.fill = OUT_FILL
    c.font = Font(name="微软雅黑", size=10, bold=True, color="C00000")
    c.alignment = Alignment(horizontal="right")
    c.border = BORDER
    ws6.row_dimensions[r].height = 24
    r += 1

ws6.cell(row=r + 1, column=1,
         value="读法：前三列是官方接口方案，走不了拼上拼；真正可比的是 D~G 四列。自建那一列是「开发摊销 + 维护 + 现金」，不含人心成本。").font = NOTE
ws6.merge_cells(start_row=r + 1, start_column=1, end_row=r + 1, end_column=8)
widths(ws6, [10, 20, 20, 18, 16, 16, 14, 24])
ws6.freeze_panes = "B4"

# ============================================================
# Sheet 6 团队版改造清单
# ============================================================
ws5 = wb.create_sheet("6-团队版改造清单")
setup(ws5, "「给团队用」比「自己用」多出来的一整套东西",
      "这些是个人版可以不做、团队版必须做的。不做的后果列在最后一列", 5)
header_row(ws5, 3, ["改造项", "个人版", "团队版必须", "为什么", "不做的后果"])

team = [
    ("部署形态", "单机 GUI 或本地脚本", "局域网 Web 服务（B/S），一台机器跑，全团队浏览器访问",
     "团队要在各自电脑同时用，不能每人装一份", "每人一份 = 登录态、数据、规则全分裂"),
    ("账号与权限", "不需要", "账号体系 + 角色（管理员/运营/只读）+ 店铺级权限",
     "谁能改哪个店、谁能改加价公式，必须能管", "实习生能改全店价格 = 定时炸弹"),
    ("加价公式治理", "自己记得住", "公式版本化 + 双人复核 + 强制 dry-run 预演 + 改动审计",
     "公式错一次，全体批量任务一起错", "一个人写错倍数，全团队当天亏光"),
    ("任务队列", "串行跑就行", "队列 + 优先级 + 并发上限 + 分店铺隔离 + 失败重试",
     "多人同时提交任务会互相踩", "任务卡死、重复上架、链接漏传"),
    ("登录态管理", "自己扫码登录", "多店铺登录态集中托管 + 过期预警 + 自动续期提醒",
     "团队没人愿意天天帮别人扫码", "早上开工先花 1 小时扫码"),
    ("上货节奏控制", "手动控制", "全局限速 + 分时段 + 拟人间隔 + 单店日配额",
     "多人同时上货会叠加成高频，触发风控", "团队一起上货 = 一起进小黑屋"),
    ("回读校验", "可省", "强制开启：改完价回读比对，异常立即阻断并告警",
     "团队规模下没人会逐个复核", "定价错了没人发现，直到出单亏损"),
    ("操作审计", "不需要", "全量操作日志（谁、何时、改了哪个店哪个商品、改前改后）",
     "出问题要能定位到人和动作", "出事互相甩锅，查不出原因"),
    ("培训与文档", "自己知道就行", "内置操作引导 + 错误码字典 + 常见故障自助排查",
     "团队不能每次都来问你", "你变成 7×24 客服，比自己干还累"),
    ("备份与回滚", "不需要", "商品库/规则/任务日志每日备份 + 一键回滚",
     "团队数据丢失无法重建", "一次误删，几个月的工作没了"),
]
r = 4
for a, b, c_, d, e in team:
    ws5.cell(row=r, column=1, value=a).font = BOLD
    ws5.cell(row=r, column=2, value=b).font = BODY
    ws5.cell(row=r, column=3, value=c_).font = Font(name="微软雅黑", size=9, color="2E7D32")
    ws5.cell(row=r, column=4, value=d).font = BODY
    ws5.cell(row=r, column=5, value=e).font = Font(name="微软雅黑", size=9, color="C00000")
    for cc in range(1, 6):
        ws5.cell(row=r, column=cc).border = BORDER
        ws5.cell(row=r, column=cc).alignment = Alignment(wrap_text=True, vertical="center")
    ws5.row_dimensions[r].height = 40
    r += 1

widths(ws5, [16, 22, 44, 34, 34])
ws5.freeze_panes = "B4"

wb.save(r"C:\Users\56587\Documents\deepseek-harness\default-workspace\research\TCO_自建vs采购_测算表.xlsx")
print("saved")
