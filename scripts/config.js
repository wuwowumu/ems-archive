/**
 * 本机配置读取（随人而变的信息都放这里，不写进 skill 本体）
 *
 * 优先级：命令行参数 > 环境变量 > ~/.ems-archive.json > 默认值
 *
 * ~/.ems-archive.json 示例：
 * {
 *   "outDir": "~/Desktop/EMS快递存档",
 *   "phone": "13800000000"
 * }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = path.join(os.homedir(), '.ems-archive.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

const expand = (s) => String(s || '').replace(/^~(?=\/|$)/, os.homedir());

const CFG = loadConfig();

const outDir = path.resolve(
  expand(process.env.EMS_ARCHIVE_DIR || CFG.outDir || path.join(os.homedir(), 'Desktop', 'EMS快递存档'))
);

// 登录手机号只用于登录提示文案；不填也能用（窗口里自己输）
const phone = String(process.env.EMS_LOGIN_PHONE || CFG.phone || '').trim();

// 台账文件名里的姓名（如「张三EMS寄件台账【2026.11.3更新】」）。
// 不填则自动取索引里出现最多的寄件人，再不行就不带名字。
const owner = String(process.env.EMS_OWNER || CFG.owner || '').trim();

// 浏览器登录态目录：换人换机就该换目录，别共用
const profileDir = path.resolve(
  expand(process.env.EMS_PROFILE_DIR || CFG.profileDir || path.join(os.homedir(), '.workbuddy', 'ems-profile'))
);

module.exports = { CONFIG_PATH, CFG, outDir, phone, owner, profileDir, expand };
