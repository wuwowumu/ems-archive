#!/usr/bin/env node
/**
 * naming.js 的自测：重点守住「终态 vs 在途」这条判断线。
 *
 *   node scripts/test_naming.js          全部应通过（退出码 0）
 *
 * 为什么值得单独测：「已签收」和「待签收」只差一个字，判错两个方向都难受——
 *   判成终态 → 在途件永远不再刷新，轨迹停在半路；
 *   判成在途 → 已签收的旧件每次都被重抓，浪费时间还招风控。
 */
const path = require('path');
const { isFinalStatus, archiveReason, splitParty } = require(path.join(__dirname, 'naming.js'));

let pass = 0;
let fail = 0;

function eq(actual, expect, name) {
  const ok = actual === expect;
  ok ? pass++ : fail++;
  const mark = ok ? '  ok  ' : '  FAIL';
  const tail = ok ? '' : `（期望 ${JSON.stringify(expect)}）`;
  console.log(`${mark}  ${name}  → ${JSON.stringify(actual)}${tail}`);
}

function group(title, cases) {
  console.log(`\n— ${title} —`);
  cases.forEach(([input, expect, label]) => eq(isFinalStatus(input), expect, label || `"${input}"`));
}

// 平台真实出现过的状态原文（2026.11.4 统计 42 件：已代收 39、已妥收 2、本人收 1）
group('终态：平台真实取值', [
  ['已代收', true],
  ['已妥收', true],
  ['本人收', true],
  ['已签收', true],
]);

// 签收方式类原文，也可能出现在状态里
group('终态：签收方式类原文', [
  ['单位收发室签收', true],
  ['他人代收', true],
  ['物业代收', true],
  ['本人签收', true],
]);

group('终态：异常结案', [
  ['退回', true],
  ['拒收', true],
  ['撤件', true],
  ['无法投递', true],
  ['投递失败', true],
  ['无人接收', true],
  ['无着邮件', true],
  ['改寄', true],
  ['销毁', true],
  ['丢失', true],
  ['损毁', true],
]);

// 这一组是防回归的关键：任何一个被误判成终态，在途件就再也不刷新了
group('在途：绝不能判成终态', [
  ['待签收', false],
  ['未签收', false],
  ['等待签收', false],
  ['即将签收', false],
  ['待揽收', false],
  ['待派送', false],
  ['待取件', false],
  ['运送中', false],
  ['运输中', false],
  ['派送中', false],
  ['已揽收', false],
  ['已收件', false],
  ['已收寄', false],
  ['待确认地址', false],
  ['', false],
  [null, false],
  [undefined, false],
]);

console.log('\n— archiveReason 增量决策 —');
[
  [undefined, { status: '已代收' }, 'new', '索引里没有 → 新件'],
  [{ status: '已代收', signed: '2026-2-11 10:00' }, { status: '已代收', signed: '2026-2-11 10:00' }, '', '已代收 + 未变 → 跳过'],
  [{ status: '已妥收', signed: '2026-2-12 12:00' }, { status: '已妥收', signed: '2026-2-12 12:00' }, '', '已妥收 + 未变 → 跳过'],
  [{ status: '本人收', signed: '2026-2-13 09:00' }, { status: '本人收', signed: '2026-2-13 09:00' }, '', '本人收 + 未变 → 跳过'],
  [{ status: '退回', signed: '' }, { status: '退回', signed: '' }, '', '退回（终态）+ 未变 → 跳过'],
  [{ status: '运送中', signed: '' }, { status: '运送中', signed: '' }, 'transit', '运送中 + 未变 → 在途刷新'],
  [{ status: '派送中', signed: '' }, { status: '派送中', signed: '' }, 'transit', '派送中 + 未变 → 在途刷新'],
  [{ status: '已揽收', signed: '' }, { status: '已揽收', signed: '' }, 'transit', '已揽收未签收 → 在途刷新'],
  [{ status: '运送中', signed: '' }, { status: '已代收', signed: '2026-2-14 09:33' }, 'changed', '在途 → 已代收 → 重存'],
  [{ status: '已代收', signed: '' }, { status: '已代收', signed: '2026-2-14 09:33' }, 'changed', '补上签收时间 → 重存'],
  [{ status: '', signed: '' }, { status: '待揽收', signed: '' }, 'changed', '旧记录没状态 → 重存'],
  [{ status: '', signed: '' }, { status: '', signed: '' }, 'transit', '状态全空（脏数据）→ 当在途刷一次'],
].forEach(([rec, order, expect, label]) => eq(archiveReason(rec, order), expect, label));

// 这一组是 2026.11.10 补的：42 件里 8 件台账没电话，全卡在「姓名和电话之间没有空格、
// 座机又没有连字符」这几种写法上。只认「1 开头 11 位」或「区号-号码」就会整行丢字段。
console.log('\n— splitParty 寄收件人行解析 —');
[
  ['张三法官08130000001 四川省甲市乙区丙路 1 号', '08130000001', '区号连号码、姓名与电话无空格'],
  ['李四0813-0000002 四川省甲市乙区丙路 1 号', '0813-0000002', '座机带连字符'],
  ['值班室68880001 四川省甲市乙区丙路 1 号', '68880001', '8 位本地号码，无区号'],
  ['立案庭1号窗口83880002 四川省甲市乙区丙路 1 号', '83880002', '姓名本身含数字，不能截错'],
  ['王五13800138000 四川省甲市乙区丙路 1 号', '13800138000', '手机号'],
  ['赵六（公司法代）010-00000003 北京市甲区乙路 1 号院', '010-00000003', '带括号职务、区号带连字符'],
  ['孙七13900139000 重庆市甲区乙路 1 段 1 号', '13900139000', '手机号 + 地址含门牌数字'],
  ['孙七', '', '整行只有姓名 → 电话为空，不能误取'],
  ['', '', '空行'],
].forEach(([line, expect, label]) => eq(splitParty(line).phone, expect, label));

eq(splitParty('张三法官08130000001 四川省甲市').name, '张三法官', '姓名不被数字带歪');
eq(splitParty('张三法官08130000001 四川省甲市').address, '四川省甲市', '地址从电话之后起算');

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
