#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EMS 快递信息存档 → Word 文档

用法:
  python3 build_docx.py <data.json> <out.docx>

data.json 由 ems_archive.js 生成，字段见 SKILL.md
版式：宋体标题／仿宋正文，A4，页边距上3.7 下3.5 左2.8 右2.6cm，页脚"第X页 共Y页"
"""
import json
import re
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

SONG = '宋体'
FANG = '仿宋'


def set_run_font(run, name=SONG, size=None, bold=None, color=None):
    run.font.name = name
    run._element.rPr.rFonts.set(qn('w:eastAsia'), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if color is not None:
        run.font.color.rgb = color


def add_par(doc, text, font=FANG, size=14, bold=False, align=None,
            first_indent=0, space_before=0, space_after=0, line=25):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    pf.line_spacing = Pt(line)
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    if first_indent:
        pf.first_line_indent = Pt(size * first_indent)
    if align is not None:
        p.alignment = align
    if text:
        r = p.add_run(text)
        set_run_font(r, font, size, bold)
    return p


def shade(cell, hexcolor='EEF2F7'):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), hexcolor)
    tcPr.append(shd)


def cell_text(cell, text, size=10.5, bold=False, align=WD_ALIGN_PARAGRAPH.LEFT, font=SONG):
    cell.text = ''
    p = cell.paragraphs[0]
    p.alignment = align
    pf = p.paragraph_format
    pf.space_before = Pt(1)
    pf.space_after = Pt(1)
    pf.line_spacing_rule = WD_LINE_SPACING.SINGLE
    r = p.add_run(str(text if text is not None else ''))
    set_run_font(r, font, size, bold)


def make_table(doc, rows, cols, widths=None, header=None, size=10.5):
    t = doc.add_table(rows=rows, cols=cols)
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    tblPr = t._tbl.tblPr
    layout = OxmlElement('w:tblLayout')
    layout.set(qn('w:type'), 'fixed')
    tblPr.append(layout)
    if widths:
        for i, w in enumerate(widths):
            t.columns[i].width = Cm(w)
            for row in t.rows:
                row.cells[i].width = Cm(w)
    if header:
        for i, h in enumerate(header):
            c = t.rows[0].cells[i]
            cell_text(c, h, size=size, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
            shade(c)
    return t


def add_page_footer(section):
    footer = section.footer
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER

    def fld(instr):
        r = p.add_run()
        set_run_font(r, SONG, 9)
        f1 = OxmlElement('w:fldChar'); f1.set(qn('w:fldCharType'), 'begin')
        it = OxmlElement('w:instrText'); it.set(qn('xml:space'), 'preserve'); it.text = instr
        f2 = OxmlElement('w:fldChar'); f2.set(qn('w:fldCharType'), 'end')
        r._r.append(f1); r._r.append(it); r._r.append(f2)

    r = p.add_run('第 '); set_run_font(r, SONG, 9)
    fld(' PAGE ')
    r = p.add_run(' 页 共 '); set_run_font(r, SONG, 9)
    fld(' NUMPAGES ')
    r = p.add_run(' 页'); set_run_font(r, SONG, 9)


def add_header(section, text):
    hp = section.header.paragraphs[0]
    hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = hp.add_run(text)
    set_run_font(r, SONG, 9)
    # 去掉页眉横线
    pPr = hp._p.get_or_add_pPr()
    pbdr = OxmlElement('w:pBdr')
    for edge in ('top', 'left', 'bottom', 'right'):
        e = OxmlElement(f'w:{edge}')
        e.set(qn('w:val'), 'nil')
        pbdr.append(e)
    pPr.append(pbdr)


def build(data, out_path):
    doc = Document()

    # 默认样式
    st = doc.styles['Normal']
    st.font.name = FANG
    st.font.size = Pt(14)
    st.element.rPr.rFonts.set(qn('w:eastAsia'), FANG)

    sec = doc.sections[0]
    sec.page_width = Cm(21.0)
    sec.page_height = Cm(29.7)
    sec.top_margin = Cm(3.7)
    sec.bottom_margin = Cm(3.5)
    sec.left_margin = Cm(2.8)
    sec.right_margin = Cm(2.6)

    mail_no = data.get('mailNo', '')
    notes = data.get('notes') or ''
    case_no = ''
    m = re.search(r'（\d{4}）[^，。,；;\s]*?号', notes)
    if m:
        case_no = m.group(0)
    header_txt = f'邮件号：{mail_no}' + (f'　{case_no}' if case_no else '')
    add_header(sec, header_txt)
    add_page_footer(sec)

    # 标题
    add_par(doc, 'EMS 快递信息存档', SONG, 16, True, WD_ALIGN_PARAGRAPH.CENTER, 0, 0, 4, 30)
    add_par(doc, f'邮件号 {mail_no}　|　存档时间 {data.get("stamp","")}　|　数据来源：中国邮政速递物流官网（我的快递—我寄的）',
            SONG, 9, False, WD_ALIGN_PARAGRAPH.CENTER, 0, 0, 10, 16)

    # 一、基本信息
    add_par(doc, '一、基本信息', SONG, 15, True, None, 2, 6, 4, 26)
    info = data.get('info', {})
    rows = [
        ('邮件号', mail_no, '订单号', data.get('orderNo', '')),
        ('产品／状态', f'{data.get("product","")}／{data.get("status","")}', '收寄时间', data.get('collected', '')),
        ('寄件人', data.get('senderName', ''), '签收时间', data.get('signed', '')),
        ('收件人', data.get('receiverName', ''), '物品／资费', f'{data.get("goods","")}／{data.get("postage","")}'),
    ]
    t = make_table(doc, rows=len(rows) + 3, cols=4, widths=[2.3, 5.4, 2.3, 5.6], size=10.5)
    for i, (k1, v1, k2, v2) in enumerate(rows):
        cell_text(t.rows[i].cells[0], k1, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER); shade(t.rows[i].cells[0], 'F7F9FB')
        cell_text(t.rows[i].cells[1], v1)
        cell_text(t.rows[i].cells[2], k2, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER); shade(t.rows[i].cells[2], 'F7F9FB')
        cell_text(t.rows[i].cells[3], v2)
    # 寄件地址 / 收件地址 / 备注（合并）
    i = len(rows)
    for label, value in (('寄件地址', data.get('senderAddress', '')),
                         ('收件地址', data.get('receiverAddress', '')),
                         ('备注', notes or '—')):
        r = t.rows[i]
        cell_text(r.cells[0], label, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER); shade(r.cells[0], 'F7F9FB')
        merged = r.cells[1].merge(r.cells[3])
        cell_text(merged, value)
        i += 1

    # 二、邮寄轨迹
    traces = data.get('traces', [])
    add_par(doc, f'二、邮寄轨迹（共 {len(traces)} 条）', SONG, 15, True, None, 2, 12, 4, 26)
    if traces:
        t2 = make_table(doc, rows=len(traces) + 1, cols=6,
                        widths=[2.6, 1.2, 5.4, 3.2, 1.6, 1.6],
                        header=['时间', '状态', '轨迹', '机构', '操作人', '联系电话'], size=10)
        for i, x in enumerate(traces, start=1):
            c = t2.rows[i].cells
            cell_text(c[0], x.get('time', ''), size=10)
            cell_text(c[1], x.get('state', ''), size=10, align=WD_ALIGN_PARAGRAPH.CENTER)
            cell_text(c[2], x.get('operation', ''), size=10)
            cell_text(c[3], x.get('org', ''), size=10)
            cell_text(c[4], x.get('operator', ''), size=10, align=WD_ALIGN_PARAGRAPH.CENTER)
            cell_text(c[5], x.get('phone', ''), size=10)
    else:
        add_par(doc, '（未获取到轨迹）', FANG, 12)

    # 三、邮件详情
    add_par(doc, '三、邮件详情', SONG, 15, True, None, 2, 12, 4, 26)
    detail_rows = data.get('detailRows', [])
    if detail_rows:
        t3 = make_table(doc, rows=len(detail_rows), cols=2, widths=[3.4, 12.2], size=10)
        for i, (k, v) in enumerate(detail_rows):
            cell_text(t3.rows[i].cells[0], k, size=10, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
            shade(t3.rows[i].cells[0], 'F7F9FB')
            cell_text(t3.rows[i].cells[1], v, size=10)

    # 四、变更记录
    add_par(doc, '四、变更记录', SONG, 15, True, None, 2, 12, 4, 26)
    changes = data.get('changes') or []
    if changes:
        add_par(doc, json.dumps(changes, ensure_ascii=False, indent=1), FANG, 10)
    else:
        add_par(doc, data.get('changesText') or '本邮件无变更记录（平台显示“暂无数据”；接口返回的投递变更、修改、撤回记录均为空）。',
                FANG, 14, first_indent=2)

    # 五、签收记录
    add_par(doc, '五、签收记录', SONG, 15, True, None, 2, 12, 4, 26)
    sign = data.get('sign', {})
    if sign.get('time'):
        srows = [
            ('签收状态', sign.get('state', '')),
            ('签收时间', sign.get('time', '')),
            ('签收方式', f'{sign.get("type","")}（平台签收方式代码 signType={sign.get("signType","")}，操作码 opCode={sign.get("opCode","")}）'),
        ]
        t5 = make_table(doc, rows=len(srows), cols=2, widths=[3.4, 12.2], size=10)
        for i, (k, v) in enumerate(srows):
            cell_text(t5.rows[i].cells[0], k, size=10, bold=True, align=WD_ALIGN_PARAGRAPH.CENTER)
            shade(t5.rows[i].cells[0], 'F7F9FB')
            cell_text(t5.rows[i].cells[1], v, size=10)
        if not sign.get('signatureImage'):
            add_par(doc, '注：平台未提供签收人签名图像或签收照片。',
                    SONG, 9, False, None, 0, 4, 2, 14)

    # 六、附件清单
    shots = data.get('shots', [])
    add_par(doc, '六、附件（页面截图，与本文档同目录）', SONG, 15, True, None, 2, 12, 4, 26)
    for s in shots:
        add_par(doc, f'· {s.get("file","")}　（采集时间 {s.get("time","")}）', FANG, 12, False, None, 0, 0, 1, 20)

    add_par(doc, '', FANG, 10, False, None, 0, 10, 0, 12)
    # 账号脱敏后由 ems_archive.js 传入（account 字段）；没传就写"本账号"，绝不写死某个人的号码
    _acct = (data.get('account') or '').strip()
    _by = f'登录账号 {_acct} ' if _acct else '本账号'
    add_par(doc, f'本文档由页面截图、页面文字与平台数据整理而成，截图取自{_by}于 {data.get("stamp","")} 的查询结果；'
                 f'截图记录了页面地址与采集时间，可与其后附图片相互印证。',
            SONG, 9, False, None, 0, 6, 0, 14)

    doc.save(out_path)
    return out_path


if __name__ == '__main__':
    with open(sys.argv[1], encoding='utf-8') as f:
        d = json.load(f)
    print(build(d, sys.argv[2]))
