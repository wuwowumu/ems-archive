#!/usr/bin/env node
/**
 * 按最新命名规则重命名已存档目录（不联网）
 *
 * 用法:
 *   node migrate_names.js [--out <存档根目录>] [--dry]
 *
 * 适用场景：调整了 naming.js 里的概括/命名规则后，把历史目录名同步过来。
 * 依据：/tmp 下留存的 payload（ems_payload_<单号>.json）里的原始备注。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDirName, summarize } = require('./naming.js');
const { outDir } = require('./config.js');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
let out = outDir;
const i = argv.indexOf('--out');
if (i >= 0) out = argv[i + 1];

// 索引名以「02<姓名>存档索引【日期更新】.json」为准，兼容旧名
const INDEX = (() => {
  const dir = out;
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^02.*存档索引【.*更新】\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      const m = fs.statSync(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  } catch (e) {}
  if (best) return best.p;
  return (
    ['02存档索引.json', '_存档索引.json', '02 存档索引.json']
      .map((n) => path.join(dir, n))
      .find((p) => fs.existsSync(p)) || path.join(dir, '02存档索引.json')
  );
})();
const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const TMP = os.tmpdir();

let renamed = 0;
for (const [mailNo, rec] of Object.entries(idx.items)) {
  let notes = '';
  let summary = '';
  let goods = rec.goods || '';
  const pf = path.join(TMP, `ems_payload_${mailNo}.json`);
  if (fs.existsSync(pf)) {
    try {
      const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
      notes = p.notes || '';
      goods = p.goods || goods;
    } catch (e) {}
  } else {
    // /tmp 被系统清理后，退回索引里已存好的概括，避免重新提炼成"文件"
    summary = rec.summary || '';
  }

  // 存档日从 lastArchivedAt 取，保持与原目录一致
  const m = String(rec.lastArchivedAt || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  const archiveDot = m ? `${m[1]}.${parseInt(m[2], 10)}.${parseInt(m[3], 10)}` : '';

  const newName = buildDirName(
    {
      mailNo,
      collected: rec.collected,
      signed: rec.signed,
      signType: rec.signType || '',
      status: rec.status || '',
      senderName: rec.senderName,
      receiverName: rec.receiverName,
      summary,
      notes,
      goods,
    },
    archiveDot
  );

  if (newName === rec.dir) continue;

  const from = path.join(out, rec.dir);
  const to = path.join(out, newName);
  console.log(`${rec.dir}\n   → ${newName}`);
  renamed++;
  if (dry) continue;
  if (!fs.existsSync(from)) {
    console.log('   （原目录不存在，仅更新索引）');
  } else {
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }
  rec.dir = newName;
  rec.summary = summary || summarize(notes, goods);
  if (rec.history && rec.history.length) rec.history[rec.history.length - 1].dir = newName;
}

if (!dry && renamed) {
  idx.updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  fs.writeFileSync(INDEX, JSON.stringify(idx, null, 2));
}
console.log(`\n${dry ? '（dry-run）' : ''}共改名 ${renamed} 个`);
