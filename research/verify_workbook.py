
from openpyxl import load_workbook
wb = load_workbook("research/候选品利润对比.xlsx", data_only=True)
ws = wb["候选品对比"]
for r in range(6, 11):
    print([ws.cell(row=r, column=c).value for c in [1,5,8,13,14,17]])
