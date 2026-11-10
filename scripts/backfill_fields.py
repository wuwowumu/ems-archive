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

# 电话候选：任意 6 位以上的数字串（允许中间带连字符）
RUN_RE = re.compile(r'\d[\d\-]{5,}')


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
    """「姓名+电话 地址」→ (姓名, 电话, 地址)

    真实页面三种写法都有，只认「1 开头 11 位」或「区号-号码」会漏：
        张三法官08130000001 四川省…     区号直接连号码，无空格无连字符
        李四0813-0000002 四川省…        带连字符
        立案庭1号窗口83880002 四川省…   姓名本身含数字
    做法：取「最后一个 7~13 位数字串、且其后紧跟空白或行尾」那一段当电话。
    """
    s = (line or '').strip()
    if not s:
        return '', '', ''
    for m in reversed(list(RUN_RE.finditer(s))):
        raw = m.group().strip()
        if not (7 <= len(re.sub(r'\D', '', raw)) <= 13):
            continue
        tail = s[m.end():]
        if tail and not tail[:1].isspace():
            continue
        return s[:m.start()].strip(), raw, collapse_repeats(tail.strip())
    return s, '', ''


def read_docx(path):
    """从存档 Word 里取：收件人电话（页面显示行）、收件地址、备注、订单号

    - 「收件人（页面显示）」行格式为「姓名 电话 地址」，电话从这里取；
      部分法院/部门地址本身没填电话，这行会缺失，此时电话留空（事实如此）。
    - 「收件地址」是独立一行，比从上面那行截取更干净，优先用它。
    - 「订单号」必须存进索引：平台「我的快递」只保留最近几个月，更早的件
      列表和搜索都查不到，只有订单号能把详情页直接打开（配 --order-no 用）。
    """
    rec_line, addr_row, notes, order_no = None, None, None, None
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
            elif not order_no:
                # 「邮件号 | 1387… | 订单号 | Z1992…」这种同一行的写法
                for j, c in enumerate(cells[:-1]):
                    if c == '订单号' and cells[j + 1].strip():
                        order_no = cells[j + 1].strip()
    return rec_line, addr_row, notes, order_no


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

    stat = {'phone': 0, 'addr': 0, 'notes': 0, 'order': 0, 'no_docx': 0, 'no_phone': 0}
    for mail_no, rec in items.items():
        d = os.path.join(out_dir, rec.get('dir') or '')
        docs = glob.glob(os.path.join(d, 'EMS快递信息存档 *.docx'))
        if not docs:
            stat['no_docx'] += 1
            continue
        rec_line, addr_row, notes, order_no = read_docx(docs[0])
        _name, phone, line_addr = parse_party(rec_line or '')
        addr = collapse_repeats(addr_row) if addr_row else line_addr

        if order_no and not rec.get('orderNo'):
            rec['orderNo'] = order_no
            stat['order'] += 1
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
        '回填完成：电话 {phone} 件、地址 {addr} 件、备注 {notes} 件、订单号 {order} 件；'
        '页面本身无电话 {no_phone} 件（留空），无 Word {no_docx} 件'.format(**stat)
    )


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
