#!/usr/bin/env bash
# EMS 快递存档 skill —— 一键安装（幂等，可重复运行）
#   用法：bash install.sh [目标目录]
#   默认装到 ~/.workbuddy/skills/ems-archive
# 设计前提：压缩包里已自带 node 依赖（playwright-core），所以不走 npm、不下载浏览器。
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="${SRC}"
DEST="${1:-${HOME}/.workbuddy/skills/ems-archive}"

green() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
step()  { printf '  \033[36m·\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✘\033[0m %s\n' "$1"; exit 1; }

echo
echo "EMS 快递存档 · 安装"
echo "────────────────────────────────"

# ---------- 1. 找 Node ----------
# 装了 WorkBuddy 就一定自带 node，不必让用户另外装
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "${NODE}" ]; then
  NODE="$(ls -d "${HOME}"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort | tail -1)"
  [ -n "${NODE}" ] && step "系统没装 Node，改用 WorkBuddy 自带的"
fi
[ -n "${NODE:-}" ] && [ -x "${NODE}" ] || die "没找到 Node.js。装一个（brew install node）后重跑，或直接用 WorkBuddy 打开本文件夹让我处理"
green "Node $("${NODE}" -v)（${NODE}）"

# ---------- 2. 放好技能目录 ----------
mkdir -p "$(dirname "${DEST}")"
if [ -d "${DEST}" ]; then
  step "目标已存在，更新代码（保留原依赖与登录态）"
  mkdir -p "${DEST}/scripts"
  cp -R "${PKG}/scripts/." "${DEST}/scripts/" 2>/dev/null
  cp "${PKG}/SKILL.md" "${DEST}/SKILL.md" 2>/dev/null
  cp "${PKG}/package.json" "${DEST}/package.json" 2>/dev/null
  cp "${PKG}/install.sh" "${DEST}/install.sh" 2>/dev/null
else
  cp -R "${PKG}" "${DEST}" || die "复制到 ${DEST} 失败"
  # 从 git clone 安装时，别把仓库元数据一并拷进技能目录（压缩包安装这里是空操作）
  rm -rf "${DEST}/.git" "${DEST}/.gitignore" "${DEST}/README.md" "${DEST}/LICENSE" 2>/dev/null
fi
chmod -R u+rw "${DEST}" 2>/dev/null
green "技能目录：${DEST}"

# ---------- 3. 校验 node 依赖 ----------
if (cd "${DEST}" && "${NODE}" -e "require.resolve('playwright-core')" >/dev/null 2>&1); then
  green "浏览器驱动已就位（playwright-core，随包自带）"
else
  warn "包内依赖缺失，尝试联网补装（走国内镜像）"
  NPM="$(dirname "${NODE}")/npm"
  [ -x "${NPM}" ] || NPM="$(command -v npm 2>/dev/null || true)"
  [ -n "${NPM}" ] || die "缺 playwright-core 且找不到 npm。请让 WorkBuddy 处理，或手动 npm i playwright-core"
  (cd "${DEST}" && "${NPM}" i playwright-core --no-audit --no-fund --registry=https://registry.npmmirror.com) >/dev/null 2>&1 \
    || (cd "${DEST}" && "${NPM}" i playwright-core --no-audit --no-fund) >/dev/null 2>&1 \
    || die "补装 playwright-core 失败，请检查网络后重跑"
  green "已补装 playwright-core"
fi

# ---------- 4. 校验 python 依赖（生成 Word / 台账用） ----------
PY="$(command -v python3 2>/dev/null || true)"
[ -n "${PY}" ] || die "没找到 python3。macOS 可执行 xcode-select --install 后重试"
if "${PY}" -c "import docx, openpyxl" >/dev/null 2>&1; then
  green "Python 依赖已就位（python-docx、openpyxl）"
else
  step "安装 Python 依赖（约 10–30 秒，走国内镜像）"
  "${PY}" -m pip install --quiet --disable-pip-version-check \
    -i https://pypi.tuna.tsinghua.edu.cn/simple python-docx openpyxl >/dev/null 2>&1 \
    || "${PY}" -m pip install --quiet --disable-pip-version-check python-docx openpyxl >/dev/null 2>&1 \
    || "${PY}" -m pip install --quiet --user python-docx openpyxl >/dev/null 2>&1
  if "${PY}" -c "import docx, openpyxl" >/dev/null 2>&1; then
    green "Python 依赖装好了"
  else
    die "Python 依赖装不上（截图存档仍可用，但不会生成 Word 和台账）。请让 WorkBuddy 处理这一步"
  fi
fi

# ---------- 5. 浏览器内核（只检测，不下载） ----------
if [ -d "/Applications/Google Chrome.app" ] || command -v google-chrome >/dev/null 2>&1 \
   || [ -d "/Applications/Microsoft Edge.app" ]; then
  green "浏览器：用你电脑上的 Chrome/Edge，不用下载内核"
else
  warn "没检测到 Chrome。脚本会尝试用系统浏览器；若启动失败，装个 Google Chrome 即可（免费，几秒）"
fi

# ---------- 6. 自检 ----------
echo
if (cd "${DEST}" && "${NODE}" scripts/ems_archive.js --print-config); then
  echo
  green "安装完成"
  cat <<EOF

下一步（首次登录，只需一次）：
  在 WorkBuddy 里说「用 --headful 跑一次 EMS 存档，我要登录」
  或者在此终端执行：
  cd "${DEST}" && "${NODE}" scripts/ems_archive.js --headful --list

之后每次只要说「把 EMS 快递存档」即可（增量，只抓新的）。
EOF
else
  die "自检没通过，把上面这段报错发给 WorkBuddy"
fi
