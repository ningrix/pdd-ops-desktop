
from openpyxl import load_workbook
wb = load_workbook("research/候选品利润对比.xlsx", data_only=True)
ws = wb["300元预算与SOP"]
for r in range(4, 11):
    print([ws.cell(row=r, column=c).value for c in [1,2]])
print("sum:", sum(ws.cell(row=r, column=2).value or 0 for r in range(4, 9)))
ws2 = wb["结论摘要"]
print("summary:", ws2["B6"].value, "|", ws2["B7"].value)
