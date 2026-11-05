# EMS 快递存档 skill

把从中国邮政 EMS 寄出的快件存档留证：登录 ems.com.cn，逐件截图四个板块（邮寄轨迹／邮件详情／变更记录／签收记录），
生成一份 **Word 汇总** 和一张 **寄件台账**——用来证明某份文书**哪天寄出、哪天被谁签收**。

`SKILL.md` 是给 AI（WorkBuddy / Claude 等）读的操作手册；`scripts/` 里的脚本可以完全独立运行，不依赖 AI。

---

## 它能做什么

- **逐件截图**：详情页整页 + 邮寄轨迹（自动"展开全部"）+ 邮件详情（寄收件人信息自动点开脱敏）+ 变更记录 + 签收记录
- **生成 Word**：A4、宋体标题＋仿宋正文、页脚「第 X 页 共 Y 页」、轨迹与签收表格化，可直接作证据附件
- **生成台账**（xlsx，15 列）：揽收日／寄件人／收件人／**收件人电话**／**收件地址**／材料摘要／**备注**／邮件号／状态／签收时间／**签收方式**／轨迹条数／存档时间／存档目录
- **增量**：新件、状态变了的、以及**尚未签收的在途件**每次刷新轨迹；**已签收／退回／拒收等终态不再重复抓**
- **只增不删**：被新版替代的台账、索引、存档快照统一进 `00历史文件/`，保留更新沿革

每件一个文件夹，名字自带时间线：

```
2026.2.10邮寄【张三to李四】某案授权材料-2026.2.11单位收发室签收-1300000000000（2026.11.2EMS存档）/
    00 详情页整页.png
    01 邮件轨迹.png
    02 邮件详情.png
    03 变更记录.png
    04 签收记录.png
    EMS快递信息存档 1300000000000.docx
```

签收段会写明是谁签的（单位收发室签收／他人代收／物业代收／本人签收），**非本人签收一眼能看出来**——这类正是"未实际送达"抗辩的高发点。

---

## 安装

### 方式一：下载打好的包（推荐，离线可用，约 3 秒）

到 [Releases](../../releases) 下载 `ems-archive-v3.zip`，解压后双击 **`一键安装.command`**。

> 包内已自带浏览器驱动 `playwright-core`，**不需要 npm、不下载浏览器内核**（用你电脑上的 Chrome／Edge）。
> 若 macOS 提示"无法验证开发者"：右键 → 打开；或打开「终端」，输入 `bash ` 后把 `install.sh` 拖进窗口回车。

### 方式二：从源码安装

```bash
git clone https://github.com/wuwowumu/ems-archive.git
cd ems-archive
bash install.sh
```

这条会联网补装一个依赖（`playwright-core`，约 5 MB，走 npmmirror 镜像），其余与方式一相同。

两种方式都装到 `~/.workbuddy/skills/ems-archive`，可重复运行（幂等）。

### 依赖

| 依赖 | 用途 | 说明 |
| --- | --- | --- |
| Node.js ≥ 18 | 抓取与截图 | 装了 WorkBuddy 就自带，`install.sh` 会自动找 |
| `playwright-core` | 驱动浏览器 | 包内自带；源码安装时联网补 |
| Python 3 + `python-docx`、`openpyxl` | 生成 Word 与台账 | `install.sh` 用清华镜像装 |

浏览器不下载内核，直接调用系统 **Chrome**（其次 Edge）。登录态跨内核可复用。

---

## 首次登录（只需一次）

EMS 官网要短信验证码，只能自己输：

```bash
cd ~/.workbuddy/skills/ems-archive
node scripts/ems_archive.js --headful --list
```

弹出浏览器窗口后输入自己的手机号、收验证码、勾上"自动登录"。
登录态存在本机 `~/.workbuddy/ems-profile`，以后长期免登录。**验证码脚本不会代填、也拿不到。**

---

## 用法

```bash
node scripts/ems_archive.js                    # 增量（最常用）
node scripts/ems_archive.js --recent 5         # 最近 5 件
node scripts/ems_archive.js 1300000000000      # 指定单号（已存过也重存）
node scripts/ems_archive.js --all              # 全量重存
node scripts/ems_archive.js --limit 10         # 本次最多 10 件
node scripts/ems_archive.js --headful          # 显示浏览器窗口（登录／过风控）
node scripts/ems_archive.js --out ~/Desktop/EMS存档   # 自定义根目录
node scripts/ems_archive.js --print-config     # 只看配置，不启动浏览器
```

在 WorkBuddy 里更简单：直接说「把 EMS 快递存档」。

---

## 产出结构

```
存档根目录/
  00历史文件/                                旧版台账、索引、被刷新掉的旧快照（只增不删）
  01<姓名>EMS寄件台账【YYYY.M.D更新】.xlsx      全部寄件一览
  02<姓名>存档索引【YYYY.M.D更新】.json         增量判断依据（别删）
  2026.2.10邮寄【…】…（YYYY.M.DEMS存档）/      每件一个文件夹
```

`01`／`02`／`00` 前缀是为了在 Finder 里按名称排序时稳定排在最前。

---

## 配置

配置可选，不写就用默认值（存档到 `~/Desktop/EMS快递存档`，登录时手输手机号）。
要改的话在 `~/.ems-archive.json`：

```json
{
  "outDir": "~/Desktop/EMS快递存档",
  "phone": "13800000000",
  "owner": "你的姓名",
  "profileDir": "~/.workbuddy/ems-profile"
}
```

| 字段 | 作用 | 不填的后果 |
| --- | --- | --- |
| `outDir` | 存档根目录 | 默认 `~/Desktop/EMS快递存档` |
| `phone` | 登录账号，只用于提示文案与 Word 页脚署名（脱敏显示） | 页脚写"本账号" |
| `owner` | 台账文件名里的姓名 | 自动取索引里出现最多的寄件人 |
| `profileDir` | 登录态目录 | 默认 `~/.workbuddy/ems-profile` |

**这个文件不要提交、不要发给别人**——里面有手机号。

---

## 开发

```bash
node scripts/test_naming.js      # 48 项自测，改命名规则前后各跑一次
```

- `scripts/naming.js` 是命名规则与增量判断（`isFinalStatus` / `archiveReason`）的**唯一实现**，主脚本与迁移脚本共用
- `scripts/ems_archive.js` 主流程：登录 → 列表翻页 → 逐件抓取 → 截图 → 定名 → 生成 Word
- `scripts/build_docx.py` 生成 Word；`scripts/build_ledger.py` 生成台账；`scripts/backfill_fields.py` 补录历史字段；`scripts/migrate_names.js` 改名迁移（不联网）
- 改判断逻辑务必先看 `test_naming.js`：`已签收` 与 `待签收` 只差一个字，判错两个方向都难受

---

## 三个提醒

1. **用自己的账号登录**。登录态目录等于账号凭证，不要拷给别人。
2. **存档含当事人姓名、手机号、详细地址**，属敏感个人信息，对外提交前务必脱敏。
   另外平台截图的证明力弱于**邮政加盖业务印章的书面查询单**或**公证保全**；重大案件建议申请法院向邮政调取原件。
3. 本项目在 macOS 上开发（用到 `chflags` 处理隐藏属性）。Windows 可以跑，但需改一处隐藏文件属性处理。

## 已知情况

- **风控**：连续抓多了会被拦（页面空白、HTTP 412）。实测**一轮 10 件**是安全档位，被拦等 20–30 分钟再跑，别加并发。
- **登录失效**：用 `--headful` 重跑一次重新登录。

---

## License

MIT，见 [LICENSE](LICENSE)。
