# 给 AI Agent 的安装说明

用户在对话里说的是类似「装一下 github.com/wuwowumu/ems-archive 这个 skill」。
照下面三步做完即可。**不要改代码、不要重构、不要另找 node_modules 凑。**

## 这是什么

给 WorkBuddy / Claude 等 Agent 用的技能：登录 ems.com.cn，把「我寄的」EMS 快件的四个板块
（邮寄轨迹／邮件详情／变更记录／签收记录）截图留证，生成 Word 汇总和寄件台账。
纯本地运行，不往任何服务器上传数据。

## 三步装好

### 1. 放进技能目录

```bash
git clone https://github.com/wuwowumu/ems-archive.git ~/.workbuddy/skills/ems-archive
```

非 WorkBuddy 平台就放到该平台的 skills 目录。两个硬要求：
**目录名必须是 `ems-archive`**；**目录里直接能看到 `SKILL.md`**（不要多套一层）。

### 2. 跑安装脚本

```bash
bash ~/.workbuddy/skills/ems-archive/install.sh
```

它做四件事：找 Node（优先系统 node，没有就用 WorkBuddy 自带的）→ 补装 `playwright-core`
（约 5 MB，走 npmmirror）→ 装 Python 的 `python-docx`／`openpyxl`（清华镜像）
→ 跑 `--print-config` 自检。

**看到「安装完成」四个字就算成功。**

### 3. 自检

```bash
node ~/.workbuddy/skills/ems-archive/scripts/ems_archive.js --print-config
node ~/.workbuddy/skills/ems-archive/scripts/test_naming.js
```

第二条应输出 `结果：59 通过，0 失败`。两条都过就可以用了。

## 装完向用户汇报

- 装在哪、版本 `3.10.4`、自测是否 59/59
- **首次登录要单独跑一次 `--login`**：会开浏览器窗口并最多等 10 分钟，由用户自己填手机号和验证码
- 之后每次只要说「把 EMS 快递存档」

## 报错对照

| 现象 | 含义 | 处置 |
| --- | --- | --- |
| `[X] 缺少浏览器驱动`，退出码 4 | 没跑 install.sh，或 npm 没装上 | 重跑 `bash install.sh` |
| `[X] 没能启动浏览器`，退出码 4 | 本机没有 Chrome／Edge | 装个 Chrome；或 `npx playwright install chromium` |
| 退出码 2，`login_timeout` | 10 分钟内没登完 | 重跑 `--login` |
| 退出码 3，`blocked_by_waf` | 撞上 EMS 风控 | 等 20–30 分钟再跑，别加并发 |

## 几条硬规矩

1. **首次登录只用 `--login`，不要用 `--headful`**。后者只把窗口显示出来，检测到未登录就立刻关窗退出，人来不及操作。
2. **不要共用别人的登录态目录**（`profileDir`），那等于共用账号凭证。每人用自己的 EMS 账号。
3. **不要一次抓太多**。实测一轮 10 件是安全档位，被拦就等二三十分钟。
4. **存档含当事人姓名、手机号、详细地址**，属敏感个人信息，对外提交前必须脱敏。
5. **不要为了绕过报错去改 `scripts/` 里的逻辑**，先照上面那张表处理。

## 可选配置

不配置也能直接跑：默认存到 `~/Desktop/EMS快递存档`，手机号留空、登录时手输。
想改的话写 `~/.ems-archive.json`：

```json
{ "outDir": "~/Desktop/EMS快递存档", "phone": "13800000000", "owner": "张三" }
```

更多细节见 `SKILL.md`（AI 的操作手册）与 `README.md`（含两种安装方式与依赖说明）。
