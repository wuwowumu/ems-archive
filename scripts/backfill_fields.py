#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从已生成的 Word 回填索引里缺的字段（收件人电话／收件地址／备注）

只补空字段，不覆盖已有值，可重复运行。
用途：老版本存档没有记录这几个字段，重抓一遍代价太大，而 Word 里本来就写着。

用法:
  python3 backfill_fields.py <存档根目录>
"""
import glob
import json
import os
import re
import sys

from docx import Document

# 电话：手机 1 开头 11 位，或座机 区号-号码（可带分机）
PHONE_RE = re.compile(r'^(.*?)\s*((?:1\d{10})|(?:\d{3,4}-\d{7,8}(?:-\d+)?))\s+(.*)$')


def collapse_repeats(s):
    """把开头重复拼接的省市区压掉，如「上海市上海市浦东新区…」→「上海市浦东新区…」"""
    s = (s or '').strip()
    n = len(s)
    for plen in range(2, n // 2 + 1):
        p = s[:plen]
        k = 1
        while s[k * plen:(k + 1) * plen] == p:
            k += 1
        if k > 1:
            return p + s[k * plen:]
    return s


def parse_party(line):
    """「张三 13800000000 地址」→ (姓名, 电话, 地址)"""
    m = PHONE_RE.match(line or '')
    if not m:
        return (line or '').strip(), '', ''
    return m.group(1).strip(), m.group(2).strip(), collapse_repeats(m.group(3))


def read_docx(path):
    """从存档 Word 里取：收件人电话（页面显示行）、收件地址、备注

    - 「收件人（页面显示）」行格式为「姓名 电话 地址」，电话从这里取；
      部分法院/部门地址本身没填电话，这行会缺失，此时电话留空（事实如此）。
    - 「收件地址」是独立一行，比从上面那行截取更干净，优先用它。
    """
    rec_line, addr_row, notes = None, None, None
    doc = Document(path)
    for t in doc.tables:
        for row in t.rows:
            cells = [c.text.strip() for c in row.cells]
            if not cells:
                continue
            if cells[0] == '收件人（页面显示）' and len(cells) > 1 and not rec_line:
                rec_line = cells[1]
            elif cells[0] == '收件地址' and len(cells) > 1 and not addr_row:
                addr_row = cells[1]
            elif cells[0] == '备注' and len(cells) > 1 and notes is None:
                # 合并单元格会把同一段文字重复多次，去掉重复项
                vals = [c for c in dict.fromkeys(cells[1:]) if c]
                notes = '\n'.join(vals)
    return rec_line, addr_row, notes


def find_index(out_dir):
    """定位索引文件：新名 02<姓名>存档索引【YYYY.M.D更新】.json 优先（取最新），兼容旧名"""
    # 新命名：取修改时间最新的一个
    cands = sorted(
        glob.glob(os.path.join(out_dir, '02*存档索引【*更新】.json')),
        key=lambda p: os.path.getmtime(p),
        reverse=True,
    )
    for p in cands:
        return p
    for name in ('02存档索引.json', '_存档索引.json', '02 存档索引.json'):
        p = os.path.join(out_dir, name)
        if os.path.exists(p):
            return p
    return os.path.join(out_dir, '02存档索引.json')


def main(out_dir):
    idx_path = find_index(out_dir)
    with open(idx_path, encoding='utf-8') as f:
        data = json.load(f)
    items = data.get('items') or {}

    stat = {'phone': 0, 'addr': 0, 'notes': 0, 'no_docx': 0, 'no_phone': 0}
    for mail_no, rec in items.items():
        d = os.path.join(out_dir, rec.get('dir') or '')
        docs = glob.glob(os.path.join(d, 'EMS快递信息存档 *.docx'))
        if not docs:
            stat['no_docx'] += 1
            continue
        rec_line, addr_row, notes = read_docx(docs[0])
        _name, phone, line_addr = parse_party(rec_line or '')
        addr = collapse_repeats(addr_row) if addr_row else line_addr

        if phone and not rec.get('receiverPhone'):
            rec['receiverPhone'] = phone
            stat['phone'] += 1
        elif not phone and not rec.get('receiverPhone'):
            stat['no_phone'] += 1
        if addr and not rec.get('receiverAddress'):
            rec['receiverAddress'] = addr
            stat['addr'] += 1
        if notes and notes.strip('-').strip() and not rec.get('notes'):
            rec['notes'] = notes
            stat['notes'] += 1

    with open(idx_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(
        '回填完成：电话 {phone} 件、地址 {addr} 件、备注 {notes} 件；'
        '页面本身无电话 {no_phone} 件（留空），无 Word {no_docx} 件'.format(**stat)
    )


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
