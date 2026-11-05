#!/usr/bin/env node
/**
 * EMS 快递信息存档器 v3
 *
 * 用法:
 *   node ems_archive.js                      # 增量：新件 + 状态变化的 + 尚未签收的在途件（刷新轨迹）
 *                                           #       已达终态（已签收/退回/拒收）的不再重存
 *   node ems_archive.js 1234567890123 ...    # 指定单号（即使已存过也重存）
 *   node ems_archive.js --recent 5           # 最近的 5 件
 *   node ems_archive.js --all                # 全量重存（忽略索引）
 *   node ems_archive.js --limit 10           # 本次最多处理 10 件
 *   node ems_archive.js --out <目录>          # 自定义根目录
 *   node ems_archive.js --headful            # 显示浏览器窗口（过风控 / 重新登录用）
 *   node ems_archive.js --raw                # 额外保留平台接口原始 JSON
 *
 * 产出（每件一个文件夹）:
 *   00 详情页整页.png / 01-04 四个板块.png
 *   EMS快递信息存档 <单号>.docx
 * 根目录另有两个文件（前缀 01/02 是为了在 Finder 里置顶）:
 *   01<姓名>EMS寄件台账【YYYY.M.D更新】.xlsx   全部寄件一览
 *   02<姓名>存档索引【YYYY.M.D更新】.json      增量判断依据（勿删）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { CONFIG_PATH, outDir, phone, owner, profileDir } = require('./config.js');

const PROFILE = profileDir;
const DEFAULT_OUT = outDir;

// playwright 惰性加载：只在真要开浏览器时才 require。
// 允许只装 playwright-core（体积约 12MB，不含浏览器下载器），便于整包分发给别人。
let _chromium = null;
function loadChromium() {
  if (_chromium) return _chromium;
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      _chromium = require(mod).chromium;
      return _chromium;
    } catch (e) {}
  }
  const skillRoot = path.join(__dirname, '..');
  console.error('\n[X] 缺少浏览器驱动（playwright 或 playwright-core）。');
  console.error('\n    在终端执行（约 10 秒，不下载浏览器）：\n');
  console.error(`      cd "${skillRoot}" && npm i playwright-core --registry=https://registry.npmmirror.com\n`);
  console.error('    或直接跑同目录的 install.sh，它会自动补上。\n');
  process.exit(4);
}

// ---------- 浏览器内核选择 ----------
// 原则：优先用本机装的 Chrome（日常最常用），其次 Edge，最后才用 playwright 自带的 chromium。
//   ① 上次成功用过的内核（记在 profile 里，避免中途换内核导致登录态失效）
//   ② 系统 Google Chrome / Microsoft Edge —— 新机器走这条，零下载
//   ③ playwright 自带的 chromium（只有以前下过才存在）
const BROWSER_PREF = path.join(PROFILE, '.browser.json');

function browserCandidates() {
  const list = [];
  const seen = new Set();
  const add = (o) => {
    const k = o.channel || 'chromium';
    if (!seen.has(k)) {
      seen.add(k);
      list.push(o);
    }
  };
  try {
    const pref = JSON.parse(fs.readFileSync(BROWSER_PREF, 'utf8'));
    if (pref.channel) add({ channel: pref.channel, label: pref.label || pref.channel });
    else add({ label: 'chromium' });
  } catch (e) {}
  add({ channel: 'chrome', label: '系统 Chrome' });
  add({ channel: 'msedge', label: '系统 Edge' });
  try {
    if (fs.existsSync(loadChromium().executablePath())) add({ label: 'chromium' });
  } catch (e) {}
  return list;
}

async function openContext(launchOpts) {
  const chromium = loadChromium();
  const errs = [];
  for (const cand of browserCandidates()) {
    const { label, ...rest } = cand;
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, { ...launchOpts, ...rest });
      try {
        fs.mkdirSync(PROFILE, { recursive: true });
        fs.writeFileSync(
          BROWSER_PREF,
          JSON.stringify({ channel: rest.channel || null, label, at: new Date().toISOString() }, null, 2)
        );
      } catch (e) {}
      if (label !== 'chromium') console.log(`（浏览器：${label}，无需下载内核）`);
      return ctx;
    } catch (e) {
      errs.push(`${label}: ${String(e.message || e).split('\n')[0]}`);
    }
  }
  const skillRoot = path.join(__dirname, '..');
  console.error('\n[X] 没能启动浏览器，已尝试：');
  errs.forEach((l) => console.error('      ' + l));
  console.error('\n    最省事的办法：装一个 Google Chrome（免费），重跑即可——不需要下载 playwright 的浏览器内核。');
  console.error(`    不想装 Chrome 的话，也可以下载内核：cd "${skillRoot}" && npm i playwright && npx playwright install chromium\n`);
  process.exit(4);
}
// 脚本就在 skill 目录里，按自身位置定位，不写死绝对路径
const SCRIPTS = __dirname;
const DOCX_BUILDER = path.join(SCRIPTS, 'build_docx.py');
const LEDGER_BUILDER = path.join(SCRIPTS, 'build_ledger.py');
const LIST_API = /\/order\/v3\/list/;
const INDEX_PREFIX = '02';
const INDEX_BASE = '存档索引';
// 早期版本用 _存档索引.json / 02存档索引.json，读取时都兼容并自动迁到新名
const LEGACY_INDEX_NAMES = ['02存档索引.json', '_存档索引.json', '02 存档索引.json'];
const NEW_INDEX_RE = /^02.*存档索引【.*更新】\.json$/;
const LEDGER_PREFIX = '01';
// 旧版台账/索引/存档快照的归档去处（根目录只留当天的两份）。
// 前缀 00：与 01 台账、02 索引同一套排序逻辑，让它稳定排最上面（约定）
const HISTORY_DIR = '00历史文件';
const LEGACY_HISTORY_DIRS = ['历史文件'];

// 台账文件名：01<姓名>EMS寄件台账【YYYY.M.D更新】.xlsx
// 前缀 01 是为了在 Finder 里排到最前（存档文件夹都以日期开头，0 排在 2 之前）。
// 姓名优先取配置 owner，其次取索引里出现最多的寄件人，都没有就不带姓名。
const LEDGER_SUFFIX = 'EMS寄件台账';
function todayDot() {
  const d = new Date();
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

function inferOwner(index) {
  const counts = new Map();
  for (const it of Object.values((index && index.items) || {})) {
    const n = String(it.senderName || '').trim();
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  }
  let best = '';
  let max = 0;
  for (const [n, c] of counts) {
    if (c > max) {
      max = c;
      best = n;
    }
  }
  return best;
}

function ledgerOwner(index) {
  return (owner || inferOwner(index) || '').trim();
}

function ledgerFileName(index) {
  return `${LEDGER_PREFIX}${ledgerOwner(index)}${LEDGER_SUFFIX}【${todayDot()}更新】.xlsx`;
}

// 索引文件名与台账同一套规则：02<姓名>存档索引【YYYY.M.D更新】.json
function indexFileName(index) {
  return `${INDEX_PREFIX}${ledgerOwner(index)}${INDEX_BASE}【${todayDot()}更新】.json`;
}

// 重建台账：文件名带 01 前缀、姓名、生成日期；旧命名的自动清掉
function rebuildLedger(outDir, index) {
  const ledgerName = ledgerFileName(index);
  const ledgerPath = path.join(outDir, ledgerName);
  const indexPath = path.join(outDir, indexFileName(index));
  if (!fs.existsSync(indexPath)) return null; // 还没有索引（一次都没存过），不用建台账
  try {
    execFileSync('python3', [LEDGER_BUILDER, indexPath, ledgerPath, ledgerOwner(index)], {
      stdio: 'pipe',
    });
    pruneOldLedgers(outDir, ledgerName);
    console.log(`\n台账已更新：${ledgerPath}`);
    return ledgerPath;
  } catch (e) {
    console.log('台账生成失败:', (e.stderr || e.message || '').toString().slice(0, 200));
    return null;
  }
}

// 在 dir 里找一个不冲突的名字：同名自动加 (2)(3)…（目录直接在末尾加，文件加在扩展名前）
function uniqueIn(dir, name, isDir) {
  const ext = isDir ? '' : path.extname(name);
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  let dest = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}(${n})${ext}`);
    n++;
  }
  return dest;
}

// 旧版台账/索引/存档快照一律不删除，收进「00历史文件」子目录，方便回看文件更新沿革（约定）
function retireToHistory(outDir, fileName) {
  const src = path.join(outDir, fileName);
  if (!fs.existsSync(src)) return null;
  try {
    const hdir = path.join(outDir, HISTORY_DIR);
    fs.mkdirSync(hdir, { recursive: true });
    const isDir = fs.statSync(src).isDirectory();
    const dest = uniqueIn(hdir, fileName, isDir);
    fs.renameSync(src, dest);
    return dest;
  } catch (e) {
    console.log(`（旧文件 ${fileName} 归档失败：${e.message}）`);
    return null;
  }
}

// 早期版本叫「历史文件」，改名后要自动并入「00历史文件」（00 前缀为了排在最前，与 01/02 同一套排序逻辑）
function ensureHistoryDir(outDir) {
  const hdir = path.join(outDir, HISTORY_DIR);
  fs.mkdirSync(hdir, { recursive: true });
  for (const legacy of LEGACY_HISTORY_DIRS) {
    const old = path.join(outDir, legacy);
    if (!fs.existsSync(old)) continue;
    try {
      for (const f of fs.readdirSync(old)) {
        const p = path.join(old, f);
        const dest = uniqueIn(hdir, f, fs.statSync(p).isDirectory());
        fs.renameSync(p, dest);
      }
      fs.rmdirSync(old);
      console.log(`（旧目录 ${legacy}/ 已并入 ${HISTORY_DIR}/）`);
    } catch (e) {
      console.log(`（${legacy}/ 并入 ${HISTORY_DIR}/ 失败：${e.message}，请手动搬一下）`);
    }
  }
  return hdir;
}

// 台账是派生数据，根目录只留最新一份；旧日期的（含最早期 _EMS寄件台账.xlsx）移入历史文件
function pruneOldLedgers(dir, keepName) {
  const moved = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === keepName) continue;
      if (/EMS寄件台账【.*更新】\.xlsx$/.test(f) || f === '_EMS寄件台账.xlsx') {
        const d = retireToHistory(dir, f);
        if (d) moved.push(path.basename(d));
      }
    }
  } catch (e) {}
  if (moved.length) console.log(`（旧台账已移入 ${HISTORY_DIR}/：${moved.join('、')}）`);
}
const LIST_URL = 'https://www.ems.com.cn/query_express_delivery';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = { out: DEFAULT_OUT, recent: 0, headful: false, raw: false, all: false, limit: 0, ledger: true, listOnly: false };
const mails = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') opt.out = argv[++i];
  else if (a === '--recent') opt.recent = parseInt(argv[++i], 10);
  else if (a === '--limit') opt.limit = parseInt(argv[++i], 10);
  else if (a === '--headful') opt.headful = true;
  else if (a === '--raw') opt.raw = true;
  else if (a === '--all') opt.all = true;
  else if (a === '--no-ledger') opt.ledger = false;
  else if (a === '--list') opt.listOnly = true;
  else if (a === '--print-config') opt.printConfig = true;
  else if (/^\d{8,}$/.test(a)) mails.push(a);
}

// 先看配置对不对（换人换机后第一条命令就该跑这个）
if (opt.printConfig) {
  console.log(
    JSON.stringify(
      {
        配置文件: CONFIG_PATH,
        存档根目录: DEFAULT_OUT,
        登录态目录: PROFILE,
        登录手机号: phone || '（未配置，登录时手动输入）',
        脚本目录: SCRIPTS,
        Node: process.version,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const DATE_DOT = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;
const STAMP = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(
  now.getMinutes()
)}:${pad(now.getSeconds())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页脚署名用的账号（脱敏成 138****0000 这种样子）。从配置的 phone 现算，不写死——
// 否则换个人用，每份 Word 都会印上别人的号码。
function maskPhone(p) {
  const s = String(p || '').replace(/\D/g, '');
  if (s.length < 8) return '';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

const { clean, fmtDate, summarize, buildDirName, archiveReason } = require('./naming.js');

function parsePairs(text) {
  const lines = (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^[^：]{2,10}：$/.test(l)) {
      const k = l.slice(0, -1);
      const v = lines[i + 1] && !/^[^：]{2,10}：$/.test(lines[i + 1]) ? lines[i + 1] : '';
      out.push([k, v]);
      i++;
    } else if (/^[^：]{2,10}：.+/.test(l)) {
      const idx = l.indexOf('：');
      out.push([l.slice(0, idx), l.slice(idx + 1)]);
    }
  }
  return out;
}

function splitParty(line) {
  const m = (line || '').match(/^(.*?)\s*(1\d{10}|\d{3,4}[-\s]?\d{7,8})\s+(.*)$/);
  if (m) return { name: m[1].trim(), phone: m[2].trim(), address: m[3].trim() };
  return { name: (line || '').trim(), phone: '', address: '' };
}

// ---------- 索引 ----------
// 索引名跟台账同一套规则：02<姓名>存档索引【YYYY.M.D更新】.json
// （02 前缀让它在根目录里紧随 01 台账排第二；姓名/日期让「多久没更新」一眼可见）
// 读取时按修改时间取最新一个，旧名字（_存档索引.json / 02存档索引.json）自动迁移并删除。

// 除 keepName 以外的索引（含旧名）移入「历史文件」，不删除
function cleanupIndexFiles(outDir, keepName) {
  const moved = [];
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (f === keepName) continue;
      if (NEW_INDEX_RE.test(f) || LEGACY_INDEX_NAMES.includes(f)) {
        const d = retireToHistory(outDir, f);
        if (d) moved.push(path.basename(d));
      }
    }
  } catch (e) {}
  if (moved.length) console.log(`（旧索引已移入 ${HISTORY_DIR}/：${moved.join('、')}）`);
}

function loadIndex(outDir) {
  let files = [];
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (!NEW_INDEX_RE.test(f) && !LEGACY_INDEX_NAMES.includes(f)) continue;
      const p = path.join(outDir, f);
      try {
        files.push({ f, p, m: fs.statSync(p).mtimeMs });
      } catch (e) {}
    }
  } catch (e) {}
  files.sort((a, b) => b.m - a.m); // 修改时间最新的优先

  for (const { f, p } of files) {
    let idx;
    try {
      idx = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      continue;
    }
    const want = indexFileName(idx); // 需要 idx 里的寄件人才能定姓名
    if (f !== want) {
      try {
        fs.writeFileSync(path.join(outDir, want), JSON.stringify(idx, null, 2));
        cleanupIndexFiles(outDir, want);
        console.log(`（索引已重命名为：${want}）`);
      } catch (e) {
        console.log(`（索引仍是旧名 ${f}，迁移失败：${e.message}）`);
      }
    }
    return idx;
  }
  return { version: 3, items: {} };
}

function saveIndex(outDir, idx) {
  idx.updatedAt = STAMP;
  const want = indexFileName(idx);
  fs.writeFileSync(path.join(outDir, want), JSON.stringify(idx, null, 2));
  cleanupIndexFiles(outDir, want);
  return want;
}

(async () => {
  const log = (...a) => console.log(...a);
  fs.mkdirSync(opt.out, { recursive: true });
  ensureHistoryDir(opt.out); // 保证 00历史文件/ 存在，并把旧名「历史文件/」并进来
  const index = loadIndex(opt.out);

  const ctx = await openContext({
    headless: !opt.headful,
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let lastList = null;
  page.on('response', async (r) => {
    if (!LIST_API.test(r.url())) return;
    try {
      lastList = await r.json();
    } catch (e) {}
  });

  // 网站风控：浏览器会拿到 412 挑战页（2500 字节），非浏览器 405；此时页面近乎空白
  async function gotoWithChallenge(url, tries = 4) {
    let blocked = false;
    for (let i = 0; i < tries; i++) {
      let resp = null;
      try {
        resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (e) {}
      const st = resp ? resp.status() : 0;
      if (st === 412 || st === 405) {
        blocked = true;
        log(`  网站风控挑战（HTTP ${st}），等待 ${4 + i * 3}s 后重试…`);
        await sleep((4 + i * 3) * 1000);
        continue;
      }
      for (let k = 0; k < 8; k++) {
        const len = await page.evaluate(() => (document.body.innerText || '').trim().length);
        if (len > 200) return { ok: true, blocked };
        await sleep(1500);
      }
      log('  页面未渲染出内容，重试…');
      await sleep(3000);
    }
    return { ok: false, blocked };
  }

  // ---------- 登录 / 风控 ----------
  const first = await gotoWithChallenge(LIST_URL);
  if (!first.ok) {
    log('ACCESS_BLOCKED: 网站返回风控挑战页，未能进入「我的快递」');
    console.log(
      'RESULT_JSON:' +
        JSON.stringify({
          ok: false,
          error: 'blocked_by_waf',
          hint: '用 --headful 重跑，在可见窗口里等挑战自动通过（或手动刷新一次）；仍不行则隔 20-30 分钟再试',
        })
    );
    await ctx.close();
    process.exit(3);
  }

  const header = await page.evaluate(() => (document.body.innerText || '').slice(0, 200));
  if (/登录\s*\/\s*注册/.test(header)) {
    log('LOGIN_REQUIRED: 登录态已失效');
    console.log(
      'RESULT_JSON:' +
        JSON.stringify({
          ok: false,
          error: 'not_logged_in',
          hint: `用 --headful 重跑，在窗口里完成登录${
            phone ? `（手机号已配置：${phone}，勾协议→获取验证码→填入）` : '（勾协议→输入手机号→获取验证码→填入）'
          }`,
        })
    );
    await ctx.close();
    process.exit(2);
  }
  log('登录状态正常:', header.split('\n')[0].trim());

  const mapOrder = (it) => ({
    mailNo: it.mailNo,
    orderNo: it.subOrderNo,
    product: it.productName || it.baseProductName,
    senderName: it.senderName,
    senderAddress: [it.senderProvince, it.senderCity, it.senderArea, it.senderAddress].filter(Boolean).join(''),
    receiverName: it.receiverName,
    receiverAddress: [it.receiverProvince, it.receiverCity, it.receiverArea, it.receiverAddress].filter(Boolean).join(''),
    collected: it.osCollectedTime,
    signed: it.osSignedTime,
    status: it.mailStatusDesc,
    postage: it.postageTotal,
    goods: it.goodsDesc,
    notes: it.orderMailNotes,
  });

  // 首屏列表接口可能比 DOM 慢一步，等它到齐（否则会误判成 0 件）
  let orders = [];
  for (let k = 0; k < 12; k++) {
    const arr = lastList?.info?.mail?.send || [];
    if (arr.length) {
      orders = arr.map(mapOrder);
      break;
    }
    await sleep(700);
  }
  log('列表第 1 页已取到', orders.length, '件');

  // ---------- 翻页取全量 ----------
  async function collectAllPages(maxPages = 20) {
    // 先把每页条数调到 40，减少翻页次数（对网站也更友好）
    try {
      await page.locator('.el-pagination__sizes').first().click({ timeout: 6000 });
      await sleep(800);
      const opt40 = page.locator('.el-select-dropdown__item', { hasText: '40条/页' }).first();
      if (await opt40.count()) {
        await opt40.click({ timeout: 6000 });
        lastList = null;
        for (let k = 0; k < 20 && !lastList; k++) await sleep(600);
        if (lastList) {
          const add0 = (lastList.info?.mail?.send || []).map(mapOrder);
          if (add0.length > orders.length) {
            orders = add0;
            log(`  已切换 40 条/页，重取第 1 页 ${orders.length} 件`);
          }
        }
      }
    } catch (e) {}

    // 切换每页条数后总页数会变（如 42 件：10/页=5 页，40/页=2 页），必须重算，
    // 否则会多翻一页空页 —— 每次多余请求都在增加被风控盯上的概率
    const pagerInfo = await page
      .evaluate(() => {
        const totalTxt = (document.querySelector('.el-pagination__total')?.textContent || '').trim();
        const m = totalTxt.match(/(\d+)/);
        const nums = [...document.querySelectorAll('.el-pager li')]
          .map((li) => parseInt((li.textContent || '').trim(), 10))
          .filter((n) => Number.isFinite(n));
        const sizeTxt = (document.querySelector('.el-pagination__sizes')?.textContent || '').trim();
        const sm = sizeTxt.match(/(\d+)\s*条/);
        return {
          total: m ? parseInt(m[1], 10) : 0,
          maxShown: nums.length ? Math.max(...nums) : 0,
          pageSize: sm ? parseInt(sm[1], 10) : 0,
        };
      })
      .catch(() => ({ total: 0, maxShown: 0, pageSize: 0 }));
    const totalPages = (() => {
      if (pagerInfo.total && pagerInfo.pageSize) return Math.ceil(pagerInfo.total / pagerInfo.pageSize);
      // 每页条数取不到时，用「当前页实际条数」当每页条数（首页通常装满）
      if (pagerInfo.total && orders.length) return Math.ceil(pagerInfo.total / orders.length);
      if (pagerInfo.maxShown) return pagerInfo.maxShown;
      return maxPages;
    })();
    if (pagerInfo.total) {
      log(
        `  分页信息：共 ${pagerInfo.total} 件，约 ${orders.length} 条/页，共 ${Math.min(
          totalPages,
          maxPages
        )} 页`
      );
    }

    const seen = new Set(orders.map((o) => o.mailNo));
    for (let p = 2; p <= Math.min(maxPages, totalPages); p++) {
      let how = await page.evaluate((pageNo) => {
        const lis = [...document.querySelectorAll('.el-pager li')];
        const t = lis.find((li) => (li.textContent || '').trim() === String(pageNo));
        if (t) {
          t.click();
          return 'num';
        }
        const next = document.querySelector('.el-pagination .btn-next');
        if (next) {
          if (next.disabled) return 'end'; // 已到最后一页，不要再盲跳
          next.click();
          return 'next';
        }
        return '';
      }, p);
      if (how === 'end') {
        log('  已到最后一页');
        break;
      }
      if (!how) {
        try {
          const inp = page.locator('.el-pagination__jump input').first();
          if (await inp.count()) {
            await inp.fill(String(p));
            await inp.press('Enter');
            how = 'jump';
          }
        } catch (e) {}
      }
      if (!how) {
        log('  未找到可用的翻页控件，停止翻页');
        break;
      }
      lastList = null;
      for (let k = 0; k < 25 && !lastList; k++) await sleep(600);
      const add = (lastList?.info?.mail?.send || []).map(mapOrder);
      const fresh = add.filter((o) => !seen.has(o.mailNo));
      fresh.forEach((o) => seen.add(o.mailNo));
      orders = orders.concat(fresh);
      log(`  第 ${p} 页(${how}) +${fresh.length} 件，累计 ${orders.length}`);
      if (!fresh.length) break;
      await sleep(1500);
    }
  }

  if (!mails.length) await collectAllPages();
  log('列表累计', orders.length, '件');

  if (opt.listOnly) {
    const rows = orders.slice().sort((a, b) => String(b.collected || '').localeCompare(String(a.collected || '')));
    console.log('\n揽收日      收件人            摘要/状态                     邮件号');
    for (const o of rows) {
      console.log(
        `${fmtDate(o.collected).padEnd(11)} ${String(o.receiverName || '').padEnd(16)} ${String(
          summarize(o.notes, o.goods)
        ).padEnd(26)} ${o.mailNo}  ${o.status}`
      );
    }
    console.log('RESULT_JSON:' + JSON.stringify({ ok: true, count: rows.length, list: rows }, null, 1));
    await ctx.close();
    return;
  }

  // ---------- 选目标 ----------
  let targets = mails.slice();
  if (!targets.length) {
    let cand = orders;
    if (!opt.all) {
      cand = cand.filter((o) => {
        const rec = index.items[o.mailNo];
        const why = archiveReason(rec, o);
        if (why === 'changed') log(`  状态有变化，将重存：${o.mailNo} ${rec.status} → ${o.status}`);
        else if (why === 'transit') log(`  在途件，刷新最新轨迹：${o.mailNo} ${o.status || '（未签收）'}`);
        return !!why;
      });
    }
    cand = cand.slice().sort((a, b) => String(b.collected || '').localeCompare(String(a.collected || '')));
    targets = cand.map((o) => o.mailNo);
    if (opt.recent) targets = targets.slice(0, opt.recent);
  }
  if (opt.limit) targets = targets.slice(0, opt.limit);

  if (!targets.length) {
    // 没有新件也重建一次台账：让「【日期更新】」跟得上，顺带清掉旧命名的文件
    if (opt.ledger) rebuildLedger(opt.out, index);
    log('没有需要存档的件（无新件；其余均已签收/结案并已存档，无需重抓）');
    console.log('RESULT_JSON:' + JSON.stringify({ ok: true, archived: [], failed: [], skippedCount: 0, stamp: STAMP }, null, 1));
    await ctx.close();
    return;
  }
  log(`本次待处理 ${targets.length} 件`);

  async function findOrder(mailNo) {
    const o = orders.find((x) => x.mailNo === mailNo);
    if (o && o.orderNo) return o;
    try {
      await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(4000);
      const input = page.locator('input[placeholder*="邮件"]').first();
      await input.fill(mailNo, { timeout: 8000 });
      await page.keyboard.press('Enter');
      await sleep(5000);
      const hit = (lastList?.info?.mail?.send || []).map(mapOrder).find((x) => x.mailNo === mailNo);
      if (hit) {
        orders.push(hit);
        return hit;
      }
    } catch (e) {
      log('搜索失败', mailNo, e.message.slice(0, 100));
    }
    return orders.find((x) => x.mailNo === mailNo) || null;
  }

  const archived = [];
  const failed = [];

  for (let n = 0; n < targets.length; n++) {
    const mailNo = targets[n];
    log(`\n=== [${n + 1}/${targets.length}] ${mailNo} ===`);
    const meta = (await findOrder(mailNo)) || {};
    if (!meta.orderNo) {
      log('未找到该单号的订单号，跳过');
      failed.push({ mailNo, why: 'order_no_not_found' });
      continue;
    }

    const api = {};
    const onResp = async (r) => {
      const u = r.url();
      const map = [
        ['getGisTracesByOrderId', 'trajectory'],
        ['getOrderInfo', 'orderInfo'],
        ['getSignFeedback', 'signFeedback'],
        ['orderAddressRecord', 'addressRecord'],
      ];
      for (const [k, name] of map) {
        if (u.includes(k)) {
          try {
            api[name] = JSON.parse(await r.text());
          } catch (e) {}
        }
      }
    };
    page.on('response', onResp);

    const detailURL = `https://www.ems.com.cn/express_detail?type=0&status=1&orderNo=${meta.orderNo}&mailNo=${mailNo}&listType=0&isSubAccount=false&userId=&userPhone=`;
    const g = await gotoWithChallenge(detailURL);
    if (!g.ok) {
      log('  风控拦截，终止本次批量');
      page.off('response', onResp);
      failed.push({ mailNo, why: 'blocked_by_waf' });
      break;
    }
    try {
      await page.locator('.el-tabs__item').first().waitFor({ timeout: 20000 });
    } catch (e) {
      log('  详情页未加载出板块');
    }

    const tmpDir = path.join(opt.out, `新建中-${mailNo}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const tabs = [
      { file: '01 邮件轨迹.png', name: '邮件轨迹' },
      { file: '02 邮件详情.png', name: '邮件详情' },
      { file: '03 变更记录.png', name: '变更记录' },
      { file: '04 签收记录.png', name: '签收记录' },
    ];
    const sections = {};
    const shotTimes = {};

    for (const t of tabs) {
      try {
        await page.locator('.el-tabs__item', { hasText: t.name }).first().click({ timeout: 15000 });
      } catch (e) {
        log('  切换板块失败', t.name, e.message.slice(0, 80));
      }
      await sleep(2600);

      if (t.name === '邮件轨迹') {
        try {
          const more = page.getByText('展开全部', { exact: true }).first();
          if (await more.count()) {
            await more.click({ timeout: 5000 });
            await sleep(1800);
          }
        } catch (e) {}
      }

      if (t.name === '邮件详情') {
        const eyes = page.locator('.el-tabs__content img.icon:visible');
        const cnt = await eyes.count();
        for (let i = 0; i < cnt; i += 2) {
          try {
            await eyes.nth(i).click({ timeout: 6000 });
            await sleep(1400);
          } catch (e) {}
        }
        const stillMasked = await page.evaluate(() =>
          /\*\*\*\*/.test(document.querySelector('.el-tabs__content')?.innerText || '')
        );
        if (stillMasked && cnt >= 3) {
          try {
            await eyes.nth(2).click({ timeout: 6000 });
            await sleep(1500);
          } catch (e) {}
        }
      }

      // 隐藏右侧浮动客服栏
      await page.evaluate(() => {
        window.__emsHidden = [];
        document.querySelectorAll('body *').forEach((el) => {
          const cs = getComputedStyle(el);
          if (!['fixed', 'absolute'].includes(cs.position) || cs.display === 'none') return;
          if (el.closest('.el-tabs__content')) return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.right > window.innerWidth - 100 && r.width < 140) {
            window.__emsHidden.push([el, el.style.display]);
            el.style.display = 'none';
          }
        });
      });
      try {
        await page.locator('.el-tabs__content').first().screenshot({ path: path.join(tmpDir, t.file) });
      } catch (e) {
        await page.screenshot({ path: path.join(tmpDir, t.file), fullPage: true });
      }
      if (t.name === '邮件轨迹') {
        try {
          await page.screenshot({ path: path.join(tmpDir, '00 详情页整页.png'), fullPage: true });
        } catch (e) {}
      }
      await page.evaluate(() => {
        (window.__emsHidden || []).forEach(([el, d]) => (el.style.display = d));
        window.__emsHidden = [];
      });
      shotTimes[t.name] = STAMP;

      sections[t.name] = await page.evaluate(() => {
        const el = document.querySelector('.el-tabs__content');
        return el ? el.innerText : document.body.innerText;
      });
    }
    page.off('response', onResp);

    // ---------- 整理 ----------
    const traces = (api.trajectory?.info?.mail?.mailInfos || []).map((m) => ({
      time: m.time,
      state: m.mailStateDesc,
      operation: m.operation,
      org: m.orgName,
      operator: m.operatorName,
      phone: m.operatorPhone,
    }));

    const dLines = (sections['邮件详情'] || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    let senderLine = '';
    let receiverLine = '';
    for (const l of dLines) {
      if (!senderLine && meta.senderName && l.startsWith(meta.senderName) && /\d{7,}/.test(l)) senderLine = l;
      else if (!receiverLine && meta.receiverName && l.startsWith(meta.receiverName) && /\d{7,}/.test(l))
        receiverLine = l;
    }
    const sp = splitParty(senderLine);
    const rp = splitParty(receiverLine);

    const pairs = parsePairs(sections['邮件详情'] || '');
    const pageNotes = (pairs.find(([k]) => k === '备注') || [])[1];
    if (pageNotes && pageNotes !== '—') meta.notes = pageNotes;

    const detailRows = [];
    if (senderLine) detailRows.push(['寄件人（页面显示）', senderLine]);
    if (receiverLine) detailRows.push(['收件人（页面显示）', receiverLine]);
    for (const [k, v] of pairs) {
      if (['特快', '邮件号', '备注'].includes(k)) continue;
      detailRows.push([k, v || '—']);
    }

    const signInfo = api.signFeedback?.info || {};
    const addrRec = api.addressRecord?.info || {};
    const changes = [
      ...(addrRec.deliveryRecords || []),
      ...(addrRec.modifyRecords || []),
      ...(addrRec.revokeRecords || []),
    ];

    // 定名 → 覆盖旧目录 → 清除 hidden 标志
    // 签收方式只在「签收记录」接口里有（列表接口没有），必须在这里补进 meta
    const nameMeta = {
      ...meta,
      signed: meta.signed || signInfo.signFeedbackDate || '',
      signType: signInfo.signTypeName || '',
    };
    const finalDir = path.join(opt.out, buildDirName(nameMeta, DATE_DOT));
    const oldRec = index.items[mailNo];
    if (oldRec && oldRec.dir && oldRec.dir !== path.basename(finalDir)) {
      const oldPath = path.join(opt.out, oldRec.dir);
      if (fs.existsSync(oldPath)) {
        // 旧快照不删，移入历史文件：同一件在途期间每次刷新都是一份「当时长什么样」的证据
        const moved = retireToHistory(opt.out, oldRec.dir);
        if (moved) console.log(`  旧存档已移入 ${HISTORY_DIR}/：${oldRec.dir}`);
      }
    }
    if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, finalDir);
    try {
      execFileSync('chflags', ['-R', 'nohidden', finalDir]);
    } catch (e) {}

    if (opt.raw) {
      const rawMap = {
        '01 快递列表信息.json': meta,
        '02 邮件轨迹.json': api.trajectory,
        '03 邮件详情.json': api.orderInfo,
        '04 变更记录.json': api.addressRecord,
        '05 签收记录.json': api.signFeedback,
      };
      fs.mkdirSync(path.join(finalDir, '原始数据'), { recursive: true });
      for (const [nm, c] of Object.entries(rawMap)) {
        if (c) fs.writeFileSync(path.join(finalDir, '原始数据', nm), JSON.stringify(c, null, 2));
      }
    }

    const payload = {
      mailNo,
      orderNo: meta.orderNo,
      product: meta.product || '',
      status: meta.status || '',
      collected: meta.collected || '',
      signed: meta.signed || '',
      senderName: meta.senderName || sp.name || '',
      senderAddress: meta.senderAddress || sp.address || '',
      receiverName: meta.receiverName || rp.name || '',
      receiverAddress: meta.receiverAddress || rp.address || '',
      goods: meta.goods || '',
      postage: meta.postage != null ? '¥' + meta.postage / 100 : '',
      notes: meta.notes || '',
      traces,
      detailRows,
      changes,
      sign: {
        state: signInfo.deliveryStateName || '',
        time: signInfo.signFeedbackDate || '',
        type: signInfo.signTypeName || '',
        signType: signInfo.signType || '',
        opCode: signInfo.opCode || '',
        signatureImage: signInfo.signatureImage || '',
      },
      shots: tabs.map((t) => ({ file: t.file, time: shotTimes[t.name] || STAMP })),
      account: maskPhone(phone),
      stamp: STAMP,
      source: detailURL,
    };

    const tmpJson = path.join(os.tmpdir(), `ems_payload_${mailNo}.json`);
    fs.writeFileSync(tmpJson, JSON.stringify(payload, null, 2));
    const docxPath = path.join(finalDir, `EMS快递信息存档 ${mailNo}.docx`);
    try {
      execFileSync('python3', [DOCX_BUILDER, tmpJson, docxPath], { stdio: 'pipe' });
    } catch (e) {
      log('  Word 生成失败:', (e.stderr || e.message || '').toString().slice(0, 200));
    }

    // 索引
    const lastTrace = traces.length ? traces[traces.length - 1] : {};
    const prevHist = oldRec?.history || [];
    index.items[mailNo] = {
      mailNo,
      dir: path.basename(finalDir),
      collected: meta.collected || '',
      signed: meta.signed || '',
      status: meta.status || '',
      senderName: payload.senderName,
      receiverName: payload.receiverName,
      receiverPhone: rp.phone || '',
      receiverAddress: payload.receiverAddress || '',
      notes: payload.notes || '',
      summary: summarize(meta.notes, meta.goods),
      goods: meta.goods || '',
      signType: payload.sign.type,
      traceCount: traces.length,
      lastTraceTime: lastTrace.time || '',
      firstArchivedAt: oldRec?.firstArchivedAt || STAMP,
      lastArchivedAt: STAMP,
      history: prevHist
        .concat([{ time: STAMP, status: payload.status, signed: payload.signed, dir: path.basename(finalDir) }])
        .slice(-12),
    };
    saveIndex(opt.out, index);

    archived.push({
      mailNo,
      dir: finalDir,
      docx: fs.existsSync(docxPath) ? docxPath : null,
      traceCount: traces.length,
      status: payload.status,
      signed: payload.signed,
      signType: payload.sign.type,
    });
    log(`  已存档（轨迹 ${traces.length} 条，${payload.status}${payload.signed ? ' ' + payload.signed : ''}）`);

    // 节流：避免触发风控
    if (n < targets.length - 1) await sleep(2500);
  }

  saveIndex(opt.out, index);

  // 台账（文件名带 01 前缀、姓名与生成日期，只保留最新一份）
  if (opt.ledger) rebuildLedger(opt.out, index);

  await ctx.close();
  console.log('\nRESULT_JSON:' + JSON.stringify({ ok: true, stamp: STAMP, archived, failed }, null, 1));
})();
