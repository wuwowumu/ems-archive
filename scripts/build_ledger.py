#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从存档索引生成 EMS 寄件台账（xlsx）

用法:
  python3 build_ledger.py <_存档索引.json> <_EMS寄件台账.xlsx>

列说明：
  收件人电话 / 收件地址 / 备注 三列取自索引 rec 的同名字段（由 ems_archive.js 写入，
  历史数据可用 backfill_fields.py 从已生成的 Word 补齐）。
"""
import json
import math
import sys
from datetime import datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

SONG = '宋体'
HEAD_FILL = PatternFill('solid', fgColor='E8EEF6')
UNSIGNED_FILL = PatternFill('solid', fgColor='FFF6DC')
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

# (列名, 列宽, 是否换行, 是否居中)
COLS = [
    ('序号', 5, False, True),
    ('揽收日', 12, False, True),
    ('寄件人', 10, False, False),
    ('收件人', 14, False, False),
    ('收件人电话', 14, False, False),
    ('收件地址', 42, True, False),
    ('材料摘要', 22, True, False),
    ('备注', 32, True, False),
    ('邮件号', 15, False, True),
    ('状态', 9, False, True),
    ('签收时间', 12, False, True),
    ('签收方式', 13, False, False),
    ('轨迹', 6, False, True),
    ('存档时间', 12, False, True),
    ('存档目录', 50, False, False),
]


def ymd(s):
    """2026-2-10 17:29:32 → 2026.2.10"""
    if not s:
        return ''
    try:
        return datetime.strptime(str(s)[:10], '%Y-%m-%d').strftime('%Y.%-m.%-d')
    except Exception:
        return str(s)


def text_lines(val, width):
    """估算一个单元格在自动换行后占几行（中文按 2 个字符宽算）"""
    s = str(val or '')
    if not s:
        return 1
    per_line = max(4, int(width / 2))  # 列宽单位≈1 个西文字符，中文占 2
    total = 0
    for seg in s.split('\n'):
        total += max(1, math.ceil(len(seg) / per_line))
    return max(1, total)


def build(index_path, out_path, owner=''):
    with open(index_path, encoding='utf-8') as f:
        data = json.load(f)
    items = list((data.get('items') or {}).values())
    items.sort(key=lambda x: str(x.get('collected') or ''), reverse=True)

    wb = Workbook()
    ws = wb.active
    ws.title = 'EMS寄件台账'

    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(COLS))
    t = ws.cell(row=1, column=1)
    who = (owner or '').strip()
    prefix = f'{who} ' if who else ''
    t.value = (
        f'{prefix}EMS 寄件台账　共 {len(items)} 件　'
        f'生成于 {datetime.now().strftime("%Y-%m-%d %H:%M")}'
    )
    t.font = Font(name=SONG, size=12, bold=True)
    t.alignment = Alignment(horizontal='center', vertical='center')
    ws.row_dimensions[1].height = 26

    for i, (name, width, _wrap, _ctr) in enumerate(COLS, start=1):
        c = ws.cell(row=2, column=i, value=name)
        c.font = Font(name=SONG, size=10.5, bold=True)
        c.fill = HEAD_FILL
        c.alignment = Alignment(horizontal='center', vertical='center')
        c.border = BORDER
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.row_dimensions[2].height = 22

    for r, it in enumerate(items, start=3):
        signed = it.get('signed') or ''
        vals = [
            r - 2,
            ymd(it.get('collected')),
            it.get('senderName', ''),
            it.get('receiverName', ''),
            it.get('receiverPhone', ''),
            it.get('receiverAddress', ''),
            it.get('summary', ''),
            it.get('notes', ''),
            it.get('mailNo', ''),
            it.get('status', ''),
            signed.replace('-', '.')[:16] if signed else '',
            it.get('signType', ''),
            it.get('traceCount', ''),
            ymd(it.get('lastArchivedAt')),
            # 本地副本被清理过的（原件在夸克网盘），不能还写着本地路径——台账必须说实话
            '（本地已清理，原件存夸克网盘）' if it.get('localCopy') is False else it.get('dir', ''),
        ]
        max_lines = 1
        for ci, v in enumerate(vals, start=1):
            name, width, wrap, center = COLS[ci - 1]
            c = ws.cell(row=r, column=ci, value=v)
            c.font = Font(name=SONG, size=10)
            c.border = BORDER
            c.alignment = Alignment(
                horizontal='center' if center else 'left',
                vertical='center' if not wrap else 'top',
                wrap_text=wrap,
            )
            if wrap:
                max_lines = max(max_lines, text_lines(v, width))
        ws.row_dimensions[r].height = min(150, max(22, 14.5 * max_lines + 4))
        if not signed:
            for ci in range(1, len(COLS) + 1):
                ws.cell(row=r, column=ci).fill = UNSIGNED_FILL

    ws.freeze_panes = 'A3'
    ws.auto_filter.ref = f'A2:{get_column_letter(len(COLS))}{max(2, len(items) + 2)}'
    wb.save(out_path)
    return out_path


if __name__ == '__main__':
    print(build(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else ''))
