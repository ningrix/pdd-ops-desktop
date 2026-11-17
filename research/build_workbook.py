
# -*- coding: utf-8 -*-
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

os.makedirs("research", exist_ok=True)
wb = Workbook()

# ---------- styles ----------
H = Font(bold=True, color="FFFFFF", size=11)
HF = PatternFill("solid", fgColor="2F5597")
SUB = Font(bold=True, size=11, color="1F3864")
SUB_F = PatternFill("solid", fgColor="D9E2F3")
WARN = PatternFill("solid", fgColor="FFF2CC")
BAD = PatternFill("solid", fgColor="FCE4D6")
GOOD = PatternFill("solid", fgColor="E2EFDA")
THIN = Side(style="thin", color="BFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
WRAP = Alignment(wrap_text=True, vertical="top")

def style_row(ws, row, fill=None, bold=False):
    for c in ws[row]:
        c.border = BORDER
        c.alignment = WRAP
        if fill: c.fill = fill
        if bold: c.font = Font(bold=True)

def header(ws, row, values):
    for i, v in enumerate(values, start=1):
        c = ws.cell(row=row, column=i, value=v)
        c.font = H; c.fill = HF; c.border = BORDER
        c.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")

# ================= Sheet 1: 结论摘要 =================
ws = wb.active
ws.title = "结论摘要"
ws.column_dimensions["A"].width = 26
ws.column_dimensions["B"].width = 95
rows = [
    ("报告", "二次元周边创业：300 元首轮选品与验证方案"),
    ("日期", "2026-10-22 / 数据截至当日 / 桌面研究，非正式法律意见"),
    ("核心判断", "方向成立，但 300 元 + 无店铺不能同时完成「卖货 + 积累现金」；300 元只能做需求验证。"),
    ("硬门槛", "正常开店最低现金占用约 700–1000 元（保证金 500 可退 + 首批货/包材）；0 元入驻限制提现、不能投推广、限 20 商品/100 件/2500 货值。"),
    ("合规红线", "奶龙、臭企鹅（咕咕嘎嘎）、第五人格等游戏二创、GPT/DeepSeek 娘化、无授权「正版」——全部不碰。"),
    ("法律成本", "奶龙案：1688 卖家卖 3.8 元捏捏乐，判赔 2800 元 ≈ 首轮预算的 9.3 倍。"),
    ("首选路径", "0 元 PDD 店（验证） + 闲鱼/小红书同步 + 小批量自发货；首批 80–90 元，14 天验证。"),
    ("主测 SKU", "A2 长脖鸭毛绒挂件（采购 4.00 / 售价 15.9）、A1 不织布嘴替挂件（采购 1.50 / 售价 9.9）。"),
    ("备选 SKU", "C2 空心塑料相框钥匙扣（0.33–0.50 / 9.9，需询盘确认起批/时效/面单）。"),
    ("淘汰项", "A3 空白亚克力相框：单价 0.28 元但 3000 个起批（840 元）、15 天发货，超预算 2.8 倍且违反 PDD 48h。"),
    ("单位利润", "小批量自发货口径：A2 约 7.98 元/件；A1 约 4.69 元/件；C2 约 5.69 元/件（含 3% 售后预留，不含广告/人工）。"),
    ("14 天达标线", "≥3 单、退款 ≤1、48h 发货 100% 达成、单件贡献 ≥4 元、0 IP 投诉。"),
    ("最大瓶颈", "流量：0 元店不能投广告，新店自然流量接近 0；所以必须同步闲鱼/小红书做外部验证。"),
    ("最大数据缺口", "PDD 真实成交价/销量；1688 代发加价/运费/拼多多面单；0 元入驻提现细则；个人店品牌授权政策。"),
    ("建议下一步", "1) 确认目标是验证还是赚现金；2) 花 1 天人工补数（PDD 买家端 + 供应商询盘）；3) 再决定是否下单。"),
]
ws["A1"] = "二次元周边创业｜首轮选品与验证方案（摘要）"
ws["A1"].font = Font(bold=True, size=15, color="1F3864")
ws.merge_cells("A1:B1")
r = 3
for k, v in rows:
    ws.cell(row=r, column=1, value=k).font = SUB
    ws.cell(row=r, column=1).fill = SUB_F
    ws.cell(row=r, column=1).border = BORDER
    ws.cell(row=r, column=1).alignment = WRAP
    c = ws.cell(row=r, column=2, value=v)
    c.border = BORDER; c.alignment = WRAP
    r += 1
ws.freeze_panes = "A3"

# ================= Sheet 2: 候选品对比 =================
ws = wb.create_sheet("候选品对比")
widths = [7, 24, 16, 26, 11, 10, 22, 10, 9, 9, 8, 9, 11, 9, 20, 18, 12]
for i, w in enumerate(widths, start=1):
    ws.column_dimensions[get_column_letter(i)].width = w

ws["A1"] = "候选品对比（A 级价格；利润为小批量自发货口径）"
ws["A1"].font = Font(bold=True, size=13, color="1F3864")
ws.merge_cells("A1:Q1")
ws["A2"] = "假设参数（可改，公式会自动重算）："
ws["A2"].font = SUB
params = [("平台费率", 0.006), ("售后预留率", 0.03), ("快递/单", 3.0), ("包材/单", 0.35)]
for i, (k, v) in enumerate(params):
    col = 2 + i*2
    ws.cell(row=3, column=col, value=k).font = Font(bold=True)
    c = ws.cell(row=3, column=col+1, value=v)
    c.number_format = "0.0%" if isinstance(v, float) and v < 1 else "0.00"
    c.fill = WARN; c.border = BORDER
ws["B3"] = "平台费率"; ws["C3"] = 0.006
ws["D3"] = "售后预留率"; ws["E3"] = 0.03
ws["F3"] = "快递/单"; ws["G3"] = 3.0
ws["H3"] = "包材/单"; ws["I3"] = 0.35
for cell in ["C3","E3"]:
    ws[cell].number_format = "0.0%"
for cell in ["G3","I3"]:
    ws[cell].number_format = "0.00"

hdr = ["编号","商品","供应链","链接","采购价(元)","起批","发货承诺","建议售价(元)","平台费(元)","售后预留(元)","快递(元)","包材(元)","单件贡献(元)","毛利率","IP风险","库存风险","首轮结论"]
header(ws, 5, hdr)
rows = [
    ("A2","长脖鸭毛绒挂件（发声）","1688 · 1049755412035","https://m.1688.com/offer/1049755412035.html",4.00,"2 个","浙江金华 · 48h 申通",15.9,"中低（页面IP授权=否，需自查）","低（10只=40元）","主测"),
    ("A1","不织布嘴替挂件（文字梗）","1688 · 829717500149","https://m.1688.com/offer/829717500149.html",1.50,"1 件","河北邢台 · 48h 韵达",9.9,"低（文字梗避开受保护文案）","低（20件=30元）","主测/引流"),
    ("C1","蔬菜表情亚克力钥匙扣","chinagoods（义乌二区）","https://www.chinagoods.com/store/goodsdetail/2034194986613092353/",0.88,"1 件","浙江金华 · 72h；不支持7天无理由",9.9,"低（通用蔬菜表情）","低（20件≈17.6元）","备选（72h/售后政策差）"),
    ("C2","空心塑料相框钥匙扣（可DIY）","1688 · 602052494222","https://m.1688.com/offer/602052494222.html",0.50,"待核实（按1件测算）","页面未展示；7天无理由/退货包运费/晚发必赔",9.9,"低（可插自印卡片）","低（20件=10元）","备选（需询盘）"),
    ("A3","空白亚克力相框钥匙扣","1688 · 820748661735","https://m.1688.com/offer/820748661735.html",0.28,"3000 个（≈840元）","浙江温州 · 仅15天",9.9,"低","高（超预算2.8倍；15天）","淘汰"),
]
r = 6
for row in rows:
    code, name, sup, url, cost, moq, ship, price, ip, inv, concl = row
    ws.cell(row=r, column=1, value=code)
    ws.cell(row=r, column=2, value=name)
    ws.cell(row=r, column=3, value=sup)
    c = ws.cell(row=r, column=4, value=url); c.font = Font(color="0563C1", underline="single")
    c.hyperlink = url
    ws.cell(row=r, column=5, value=cost).number_format = "0.00"
    ws.cell(row=r, column=6, value=moq)
    ws.cell(row=r, column=7, value=ship)
    ws.cell(row=r, column=8, value=price).number_format = "0.00"
    platform_fee = round(price * 0.006, 2)
    after_sale = round(price * 0.03, 2)
    ship_cost = 3.00
    pack_cost = 0.35
    contrib = round(price - price * 0.006 - price * 0.03 - ship_cost - pack_cost - cost, 2)
    ws.cell(row=r, column=9, value=platform_fee).number_format = "0.00"
    ws.cell(row=r, column=10, value=after_sale).number_format = "0.00"
    ws.cell(row=r, column=11, value=ship_cost).number_format = "0.00"
    ws.cell(row=r, column=12, value=pack_cost).number_format = "0.00"
    ws.cell(row=r, column=13, value=contrib).number_format = "0.00"
    ws.cell(row=r, column=14, value=round(contrib/price, 4)).number_format = "0.0%"
    ws.cell(row=r, column=15, value=ip)
    ws.cell(row=r, column=16, value=inv)
    ws.cell(row=r, column=17, value=concl)
    style_row(ws, r)
    if concl == "淘汰":
        for c2 in ws[r]: c2.fill = BAD
    elif concl.startswith("主测"):
        for c2 in ws[r]: c2.fill = GOOD
    r += 1

notes = [
    "口径：单件贡献 = 售价 - 平台费 - 售后预留 - 快递 - 包材 - 采购价；不含人工/广告/工具订阅。",
    "A3 的 0.28 元为 3000 个起批价，不能按单件采购；按 3000 个算需 840 元，超首轮预算 2.8 倍。",
    "C1 页面明确「不支持7天无理由退换货」，但拼多多对消费者的法定7天无理由义务不能因此免除，退货成本由卖家承担。",
    "C2 的起批量、发货时效、能否代发均未在页面明确，需询盘确认；表内按 1 件、假设可发测算。",
    "A2 页面「是否IP授权=否」只代表不是授权商品，不等于原创或不侵权；上架前需确认造型未模仿知名角色。",
]
r2 = r + 1
for n in notes:
    ws.cell(row=r2, column=1, value="注：" + n).alignment = WRAP
    ws.merge_cells(start_row=r2, start_column=1, end_row=r2, end_column=17)
    ws.cell(row=r2, column=1).font = Font(italic=True, color="7F7F7F")
    r2 += 1
ws.freeze_panes = "B6"

# ================= Sheet 3: 利润敏感性 =================
ws = wb.create_sheet("利润敏感性")
ws.column_dimensions["A"].width = 14
for i in range(2, 8):
    ws.column_dimensions[get_column_letter(i)].width = 12
ws["A1"] = "单件贡献利润敏感性（元/件；公式：售价×(1-0.6%-3%)-采购价-快递-包材）"
ws["A1"].font = Font(bold=True, size=13, color="1F3864")
ws.merge_cells("A1:H1")
ships = [2.5, 3.0, 3.5, 4.0]
def matrix(ws, start_row, title, cost, prices):
    ws.cell(row=start_row, column=1, value=title).font = SUB
    ws.cell(row=start_row, column=1).fill = SUB_F
    ws.cell(row=start_row, column=1).border = BORDER
    ws.cell(row=start_row+1, column=1, value="售价 \\ 快递").font = Font(bold=True)
    ws.cell(row=start_row+1, column=1).border = BORDER
    for j, s in enumerate(ships, start=2):
        c = ws.cell(row=start_row+1, column=j, value=s)
        c.font = Font(bold=True); c.fill = SUB_F; c.border = BORDER
        c.number_format = "0.0"
    for i, p in enumerate(prices, start=1):
        rr = start_row + 1 + i
        c = ws.cell(row=rr, column=1, value=p); c.font = Font(bold=True); c.border = BORDER
        c.number_format = "0.00"
        for j, s in enumerate(ships, start=2):
            v = round(p*(1-0.006-0.03) - cost - s - 0.35, 2)
            cc = ws.cell(row=rr, column=j, value=v)
            cc.number_format = "0.00"; cc.border = BORDER
            if v < 3: cc.fill = WARN
            elif v < 4: pass
            else: cc.fill = GOOD
matrix(ws, 3, "A2 长脖鸭毛绒挂件（采购 4.00 元）", 4.00, [12.9, 15.9, 19.9])
matrix(ws, 9, "A1 不织布嘴替挂件（采购 1.50 元）", 1.50, [9.9, 12.9, 15.9])
matrix(ws, 15, "C2 空心塑料相框钥匙扣（采购 0.50 元）", 0.50, [9.9, 12.9, 15.9])

# break-even table
ws["A22"] = "盈亏平衡：售价对应的「采购价+快递+包材」上限（目标单件毛利≥3元）"
ws["A22"].font = Font(bold=True, size=12, color="1F3864")
ws.merge_cells("A22:E22")
header(ws, 23, ["售价","扣费后净收入","成本上限(含快递/包材)","快递3.0+包材0.35时采购价上限","结论"])
be = [(9.9,"9.9 档需采购≤3.2 元"),(12.9,"12.9 档需采购≤6.1 元"),(15.9,"15.9 档需采购≤9.0 元"),(19.9,"19.9 档需采购≤12.8 元")]
r = 24
for p, note in be:
    net = round(p*(1-0.006-0.03),2)
    ws.cell(row=r, column=1, value=p).number_format = "0.00"
    ws.cell(row=r, column=2, value=net).number_format = "0.00"
    ws.cell(row=r, column=3, value=round(net-3,2)).number_format = "0.00"
    ws.cell(row=r, column=4, value=round(net-3-3.0-0.35,2)).number_format = "0.00"
    ws.cell(row=r, column=5, value=note)
    style_row(ws, r)
    r += 1

# volume table
ws["A31"] = "销量对应的月贡献利润（元；不含广告/人工）"
ws["A31"].font = Font(bold=True, size=12, color="1F3864")
ws.merge_cells("A31:F31")
header(ws, 32, ["月订单","A2（15.9元/7.98元）","A1（9.9元/4.69元）","C2（9.9元/5.69元）"])
r = 33
for q in [20, 50, 100, 300]:
    ws.cell(row=r, column=1, value=q)
    ws.cell(row=r, column=2, value=round(q*7.98))
    ws.cell(row=r, column=3, value=round(q*4.69))
    ws.cell(row=r, column=4, value=round(q*5.69))
    style_row(ws, r)
    r += 1
ws.cell(row=r+1, column=1, value="提示：A2/A1/C2 的单件贡献会随实际快递费、退货率、采购价变化，请以候选品表公式为准。").font = Font(italic=True, color="7F7F7F")

# ================= Sheet 4: 预算与SOP =================
ws = wb.create_sheet("300元预算与SOP")
ws.column_dimensions["A"].width = 30
ws.column_dimensions["B"].width = 14
ws.column_dimensions["C"].width = 60
ws["A1"] = "首轮 300 元预算（0 元入驻 + 小批量自发货）"
ws["A1"].font = Font(bold=True, size=13, color="1F3864")
ws.merge_cells("A1:C1")
header(ws, 3, ["项目","金额(元)","说明"])
budget = [
    ("首批小库存：A2×10 + A1×20 + C2×20（含运费）", 90, "采购 40+30+10=80；1688 运费预留 10；合计 90"),
    ("包材（气泡袋50+卡纸+胶带）", 30, "小件挂件用气泡袋即可，无需纸箱"),
    ("拍摄道具/背景纸", 20, "可用现有物品替代，尽量不花"),
    ("快递垫资（首批约20单×3元）", 60, "按新店 100g 小包 2.5–3 元/单估算"),
    ("备用金（退款/补货/差价）", 100, "不轻易动；出现退款优先从这里出"),
]
r = 4
for k, v, n in budget:
    ws.cell(row=r, column=1, value=k)
    ws.cell(row=r, column=2, value=v).number_format = "0"
    ws.cell(row=r, column=3, value=n)
    style_row(ws, r)
    r += 1
ws.cell(row=r, column=1, value="合计").font = Font(bold=True)
ws.cell(row=r, column=2, value=300).font = Font(bold=True)
ws.cell(row=r, column=2).number_format = "0"
ws.cell(row=r, column=3, value="预算合计 300 元").font = Font(bold=True)
style_row(ws, r, SUB_F, True)
ws.cell(row=r+1, column=1, value="注意：若 0 元入驻实际要求先缴保证金才能上架/提现，本预算不成立，需改走「攒到 800–1000 元」路径。").font = Font(italic=True, color="C00000")

sop_start = r + 3
ws.cell(row=sop_start, column=1, value="14 天执行 SOP").font = Font(bold=True, size=13, color="1F3864")
ws.merge_cells(start_row=sop_start, start_column=1, end_row=sop_start, end_column=3)
header(ws, sop_start+1, ["时间","动作","产出/记录"])
sop = [
    ("D1","注册拼多多商家版，选 0 元入驻；确定 A2/A1/C2；用 8 个问题询盘供应商","店铺状态、供应商书面答复"),
    ("D2","下单样品+小库存；买包材；确认快递报价（菜鸟裹裹商家版/快递员）","订单截图、快递报价"),
    ("D3–D4","拍摄（白底/手持/尺寸对比/细节/包装）；写标题详情售后；上架 3 SKU；定价 15.9/9.9/9.9","3 条链接、素材库"),
    ("D5–D7","闲鱼同步上架；小红书发 2 条开箱/选品内容（不硬广、不带 IP）；记录曝光/咨询","内容链接、咨询数"),
    ("D8–D10","处理订单：48h 内发货、回填单号；发售后卡；记录退款/差评原因","订单表、退款表"),
    ("D11–D13","按数据调价/换主图/只补卖得动的款","调价记录"),
    ("D14","复盘：订单、退货率、单件贡献、发货达标率；决定继续/调整/停止","复盘表"),
]
r = sop_start + 2
for a, b, c in sop:
    ws.cell(row=r, column=1, value=a)
    ws.cell(row=r, column=2, value=b).alignment = WRAP
    ws.cell(row=r, column=3, value=c).alignment = WRAP
    style_row(ws, r)
    r += 1

metric_start = r + 2
ws.cell(row=metric_start, column=1, value="达标线与停止线").font = Font(bold=True, size=13, color="1F3864")
ws.merge_cells(start_row=metric_start, start_column=1, end_row=metric_start, end_column=3)
header(ws, metric_start+1, ["指标","达标线","停止/调整信号"])
metrics = [
    ("订单数（14天）","≥3 单","0 单且曝光<300 → 0元店自然流量不可行"),
    ("退款/仅退款","≤1 单且退款率≤10%","退款率>10% → 换品/换供应商"),
    ("48h 发货","100% 达成","出现延迟 → 先解决履约再放大"),
    ("单件贡献","≥4 元/件","<3 元 → 提价或换成本更低的品"),
    ("IP 投诉/违规","0","出现 → 立即下架并复盘选品"),
    ("有效咨询","≥10 个","0 咨询 → 主图/标题/价格问题，或渠道不对"),
]
r = metric_start + 2
for a, b, c in metrics:
    ws.cell(row=r, column=1, value=a)
    ws.cell(row=r, column=2, value=b)
    ws.cell(row=r, column=3, value=c).alignment = WRAP
    style_row(ws, r)
    r += 1

# ================= Sheet 5: 来源与证据 =================
ws = wb.create_sheet("来源与证据")
ws.column_dimensions["A"].width = 8
ws.column_dimensions["B"].width = 52
ws.column_dimensions["C"].width = 62
ws.column_dimensions["D"].width = 12
ws.column_dimensions["E"].width = 10
ws.column_dimensions["F"].width = 38
header(ws, 1, ["编号","标题","URL","日期","等级","用途"])
sources = [
    ("P1","拼多多下调商家店铺保证金（1000→500）","https://www.ceweekly.cn/company/2024/0906/454463.html","2024-09-06","B+","保证金金额"),
    ("P2","2026-10-24 新版《保证金规则》只调特殊类目","https://www.163.com/dy/article/L97EB1I805118A6A.html","2026-10-14","B","本类目保证金推断"),
    ("P3","拼多多发货规则更新（48h、虚假发货5%、欺诈30%）","https://www.thepaper.cn/newsDetail_forward_30785695","2025-05-09","B+","履约规则"),
    ("P4","2026 无货源围剿与「中间商预警」","https://m.huxiu.com/article/4857384.html","2026-05-11","B","代发风险"),
    ("P5","0 元入驻限制（20商品/100件/2500货值/提现受限）","https://insight.xiaoduoai.com/e-commerce-information/pinduoduo-information/pinduoduo-merchant-entry-requirements-and-wlirok.html","2026-10-01","C","0元店限制"),
    ("P6","拼多多入驻流程与个人店资质","https://diantuoyi.com/article/36076.html","2026-07-21","C","入驻路径"),
    ("P7","一件代发电子面单与面单费用","https://www.kdniao.com/message/detail/126235","2025-10-27","B","电子面单"),
    ("P8","艾媒咨询：谷子经济 2021 亿元（2025）","https://www.iimedia.cn/c1094/108809.html","2026-01-16","A","市场规模"),
    ("P9","中国青年报：89.32% 月花费≤300 元（n=2327）","http://news.cyol.com/gb/articles/2026-03/03/content_77m7j6SeEN.html","2026-03-03","A","价格带"),
    ("P10","青岛早报：抖音100亿+、吧唧六成","https://www.guanhai.com.cn/p/398141.html","2025-07-18","A","需求信号"),
    ("P11","新华社：谷子质量问题","http://www.xinhuanet.com/20250813/eb8a617c0a5b435085c8c56bba8e43d0/c.html","2025-08-13","A","质量/售后风险"),
    ("P12","奶龙案判决书（2024）浙0782民初3570号","https://zh.wikisource.org/zh/第七印象文化传媒（深圳）有限公司、义乌市优饵灭贸易有限公司侵害作品复制权、发行权纠纷一审民事判决书","2024-03-18","A","IP 红线"),
    ("P13","1688 长脖鸭毛绒挂件（A 级直读）","https://m.1688.com/offer/1049755412035.html","2026-10-22","A","采购价4.00"),
    ("P14","1688 不织布嘴替挂件（A 级直读）","https://m.1688.com/offer/829717500149.html","2026-10-22","A","采购价1.50"),
    ("P15","1688 空白亚克力相框（A 级直读，3000起批）","https://m.1688.com/offer/820748661735.html","2026-10-22","A","淘汰项"),
    ("P16","chinagoods 蔬菜表情亚克力钥匙扣（A 级直读）","https://www.chinagoods.com/store/goodsdetail/2034194986613092353/","2026-10-22","A","采购价0.88"),
    ("P17","1688 空心塑料相框钥匙扣（A 级直读）","https://m.1688.com/offer/602052494222.html","2026-10-22","A","采购价0.33-0.50"),
]
r = 2
for row in sources:
    for j, v in enumerate(row, start=1):
        c = ws.cell(row=r, column=j, value=v)
        c.alignment = WRAP
    style_row(ws, r)
    r += 1
ws.freeze_panes = "A2"

wb.save("research/候选品利润对比.xlsx")
print("SAVED", os.path.getsize("research/候选品利润对比.xlsx"))
