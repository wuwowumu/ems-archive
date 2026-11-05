/**
 * EMS 存档命名规则（主脚本与迁移脚本共用，勿在别处重复实现）
 */

const clean = (s) => (s || '').replace(/[\\/:*?"<>|\n\r]/g, '').replace(/\s+/g, ' ').trim();

// "2026-2-10 17:29:32" → "2026.2.10"（点分隔、不补零）
function fmtDate(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${m[1]}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}`;
}

/**
 * 从"备注"提炼材料概括，上限 12 字
 *  1) 去掉案号（（2026）××01民初123号案）
 *  2) 去掉【…】补充说明；开头【…】是案件/客户简称则保留，
 *     但【甲公司to法院】这类把 to 双方又写一遍的，只留 to 前的客户名
 *  3) 去掉开头"A to B"重复段、去掉开头日期（2026.2.10）
 *  4) ≤12 字直接返回
 *  5) 超长且有《》→ 取书名号内文书名；仍超长取末尾 12 字（中文文书重心在尾部）
 *  6) 超长且无书名号 → 在 12 字内最后一个标点处断句，否则硬截加…
 */
// 物品栏 "文件,文件" → "文件"
function goodsLabel(goods) {
  const parts = String(goods || '')
    .split(/[,，、;；\/]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return [...new Set(parts)].join('、') || '文件';
}

function summarize(notes, goods) {
  let s = (notes || '').trim();
  if (!s) return shortify(goodsLabel(goods));

  // 开头的【…】常是案件/客户简称
  let lead = (s.match(/^【([^】]{1,20})】/) || [])[1] || '';
  let leadStrict = true; // 无分隔符 = 真·案件简称，一律保留
  // 【甲公司to法院】【甲公司vs乙公司】这类把双方又写一遍，只留分隔符前的客户名；
  // 留不留得下由 12 字预算决定（不能为留简称把材料名截掉）
  if (/(?:vs|to)/i.test(lead)) {
    const head = lead.split(/(?:vs|to)/i)[0].trim();
    lead = head.length >= 2 && head.length <= 8 ? head : '';
    leadStrict = false;
  }

  s = s
    .replace(/（\d{4}）[^，。,；;\s]*?号案?/g, '')
    .replace(/【[^】]*】/g, '')
    .replace(/^[^《（]{1,30}?to[^《（]{1,20}(?=[《（])/, '')
    .replace(/^\d{4}[.\-年]\d{1,2}[.\-月]\d{1,2}日?/, '')
    .replace(/\s+/g, '')
    .replace(/^[，,、。；;：:\-]+|[，,、。；;：:\-]+$/g, '');

  if (!s) s = goodsLabel(goods);
  const core = shortify(s);
  if (lead && !core.includes(lead)) {
    if (leadStrict) return shortify(lead + s); // 案件简称优先，正文让位
    if (lead.length + core.length <= 12) return lead + core;
  }
  return core;
}

// 截断后若留下没闭合的（《，就退回到该括号之前
function balanceCut(head) {
  for (const [open, close] of [['（', '）'], ['《', '》']]) {
    const i = head.lastIndexOf(open);
    if (i >= 0 && head.indexOf(close, i) < 0) return head.slice(0, i);
  }
  return head;
}

function shortify(s) {
  if (s.length <= 12) return s;
  const m = s.match(/《([^》]{1,40})》/);
  if (m) {
    const t = m[1];
    return t.length > 12 ? t.slice(-12) : t;
  }
  const head = s.slice(0, 12);
  // 正好断在标点前 → 不留省略号
  if (/[（《，。；：、）]/.test(s.charAt(12))) return balanceCut(head);
  const idx = Math.max(...['（', '《', '，', '。', '；', '：', '、'].map((c) => head.lastIndexOf(c)));
  if (idx >= 5) return balanceCut(head.slice(0, idx));
  return balanceCut(head) + '…';
}

/**
 * 签收段（约定）
 *  已签收 → <签收日><签收方式>，如 2026.2.11单位收发室签收、2026.2.12他人代收
 *  异常件 → 如实写平台状态原文（退回/拒收/撤件…），不粉饰、不臆断日期
 *  其余   → 尚未签收
 */
const ABNORMAL = /退回|拒收|撤|无法投递|投递失败|无人接收|无着|改寄|销毁|丢失|损毁|滞留|逾期/;

// 终态：已签收（含各类代收/妥收）或异常结案（退回/拒收…）。到了终态就不必再刷新。
// 其余（待揽收/运输中/派送中/待确认地址…）都算在途，每次增量都要更新最新轨迹。
// 实测平台状态原文只有三种：已代收 / 已妥收 / 本人收；签收方式另有 单位收发室签收、他人代收、物业代收、本人签收。
// NOT_YET 是反向保护：中文里「待签收」含「签收」二字，不先排掉就会被误当成已签收。
const NOT_YET = /待签收|未签收|等待签收|即将签收|待收|待取|待派|待揽/;
const FINAL = /签收|代收|妥收|本人收|退回|拒收|撤件|撤销|撤回|无法投递|投递失败|无人接收|无着|改寄|销毁|丢失|损毁/;

function isFinalStatus(status) {
  const s = String(status || '').trim();
  if (!s) return false;
  if (NOT_YET.test(s)) return false;
  return FINAL.test(s);
}

/**
 * 增量判断：这一件要不要（重新）存档？
 * 返回 '' 表示跳过，其余为原因（便于日志区分）
 *   'new'      索引里没有 → 新件
 *   'changed'  状态或签收信息变了 → 重存
 *   'transit'  上次记录还没到终态（在途）→ 刷新最新轨迹
 * 已签收 / 退回 / 拒收 等终态件，状态没变就不再动它（省时间，也不覆盖原存档）
 */
function archiveReason(rec, order) {
  if (!rec) return 'new';
  const cur = order || {};
  if ((rec.status || '') !== (cur.status || '')) return 'changed';
  if ((rec.signed || '') !== (cur.signed || '')) return 'changed';
  const wasFinal = isFinalStatus(rec.status) || !!rec.signed;
  if (!wasFinal) return 'transit';
  return '';
}

function signPart(meta) {
  const sd = fmtDate(meta.signed);
  const type = clean(meta.signType || '');
  const st = clean(meta.status || '');
  if (sd) {
    if (type) return `${sd}${type}`;
    // 签收方式字段为空时，用平台状态兜底（"本人收"这类有利信息不能丢）
    if (st && /签收|代收|本人收|已收/.test(st)) return `${sd}${st}`;
    return `${sd}已签收`;
  }
  if (st && ABNORMAL.test(st)) return st;
  return '尚未签收';
}

/** 文件夹名：揽收日邮寄【A to B】概括-签收段-单号（存档日EMS存档） */
function buildDirName(meta, archiveDot) {
  const cd = fmtDate(meta.collected) || archiveDot;
  const summary = meta.summary ? clean(meta.summary) : summarize(meta.notes, meta.goods);
  return `${cd}邮寄【${clean(meta.senderName || '寄件人')}to${clean(meta.receiverName || '收件人')}】${summary}-${signPart(
    meta
  )}-${meta.mailNo}（${archiveDot}EMS存档）`;
}

module.exports = {
  clean,
  fmtDate,
  summarize,
  shortify,
  signPart,
  buildDirName,
  isFinalStatus,
  archiveReason,
};
