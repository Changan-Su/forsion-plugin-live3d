#!/usr/bin/env bash
# 装/更新 Live3D 插件(捆绑包)到 Forsion 家目录。
#   用法:sh install.sh [dev|prod]     缺省 dev(~/.forsion-dev);prod=~/.forsion,必须显式写
# 捆绑包:
#   - skills/live3d-import = **全局技能**:引擎从 <home>/plugins/live3d/skills/ 原地扫描,任何 Agent(含用户自建的)都能 use_skill;
#   - agents/live3d-importer = 随包 Agent 的人格面(config.toml / SOUL.md),引擎启动 / 重扫时**只播种一次**进 tangu/agents/。
# ⚠️skills/ 与 agents/ 都必须跟着拷(漏拷 skills/ 是静默失败:本机源码全绿、所有 Agent 都看不到技能),
#   而且一律 cp、绝不 ln -s:引擎会丢弃符号链接的捆绑目录。
# node_modules/ 与构建源不拷 —— 装的是已构建、已提交的 main.js。
set -euo pipefail
MODE="${1:-dev}"
case "$MODE" in
  dev)  HOME_DIR="$HOME/.forsion-dev" ;;
  prod) HOME_DIR="$HOME/.forsion" ;;
  *) echo "用法:sh install.sh [dev|prod]" >&2; exit 2 ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME_DIR/plugins/live3d"

# 不许从已安装目录内自更新:下面的 rm -rf 会先删掉复制源(自己),把插件卸成空壳
if [ "$HERE" = "$(cd "$DEST" 2>/dev/null && pwd || true)" ]; then
  echo "❌ 正在从已安装目录运行,请从源码仓的 forsion-plugin-live3d/ 目录执行 install.sh" >&2
  exit 2
fi

[ -f "$HERE/main.js" ] || { echo "❌ 缺 main.js,先跑 npm run build" >&2; exit 2; }
# 自检不过不装(Bash 里 set -e 对管道 / 复合命令不可靠,显式 || exit)
node "$HERE/check.mjs" || { echo "❌ node check.mjs 没通过,未安装" >&2; exit 1; }

mkdir -p "$HOME_DIR/plugins" || exit 1
rm -rf "$DEST"
mkdir -p "$DEST" || exit 1
for f in main.js manifest.json README.md CHANGELOG.md LICENSE icon.png; do
  [ -e "$HERE/$f" ] && cp "$HERE/$f" "$DEST/"
done
cp -R "$HERE/skills" "$DEST/" || exit 1
cp -R "$HERE/agents" "$DEST/" || exit 1
# 捆绑包内嵌的 Space(「3D 小屋」):宿主扫 plugins/<id>/spaces/<slug>/space.json;漏拷 = Space 永远不出现、零告警
cp -R "$HERE/spaces" "$DEST/" || exit 1

# 迁移:早期版本把技能放在 agents/live3d-importer/skills/,引擎播种进了 tangu/agents/live3d-importer/skills/。
# 那份 agent 级副本同 id 优先于包根的全局技能,而包里不再有它的来源 → 引擎既不更新也不删,导入 Agent 永远用旧版。
# 只删「原样的播种副本」(.seed-stamp == 目录指纹,算法同 tangu-agent localSkills.ts treeHash);改过的只警告。
OLD="$HOME_DIR/tangu/agents/live3d-importer/skills/live3d-import"
if [ -d "$OLD" ]; then
  if node -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto")
    const dir = process.argv[1], JUNK = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])
    const files = []
    const walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name
      if (e.isDirectory()) walk(r); else if (e.isFile() && r !== ".seed-stamp" && !JUNK.has(e.name)) files.push(r) } }
    walk("")
    const h = crypto.createHash("sha256")
    for (const f of files.sort()) { h.update(f); h.update("\0"); h.update(fs.readFileSync(path.join(dir, f))); h.update("\0") }
    const stamp = fs.existsSync(path.join(dir, ".seed-stamp")) ? fs.readFileSync(path.join(dir, ".seed-stamp"), "utf8").trim() : ""
    process.exit(stamp && stamp === h.digest("hex").slice(0, 16) ? 0 : 1)
  ' "$OLD"; then
    rm -rf "$OLD" || exit 1
    rmdir "$HOME_DIR/tangu/agents/live3d-importer/skills" 2>/dev/null || true
    echo "   已移除旧的 agent 级技能副本(原样播种件,会遮住全局技能):$OLD"
  else
    echo "⚠️ $OLD 被改过,未删除 —— 它会遮住全局技能 live3d-import;确认不要了就手动删掉" >&2
  fi
fi

echo "✅ 已安装 → $DEST"
echo "   全局技能:$(ls "$DEST/skills" 2>/dev/null | tr '\n' ' ')(所有 Agent 可用)"
echo "   随包 Agent:$(ls "$DEST/agents" 2>/dev/null | tr '\n' ' ')(引擎启动时播种到 $HOME_DIR/tangu/agents/,已存在则保留)"
echo "   Space:$(ls "$DEST/spaces" 2>/dev/null | tr '\n' ' ')(左侧功能条「3D 小屋」)"
echo "重开 Forsion(dev:重启 desktop)后:设置 → 插件 → Live3D,或命令面板「Live3D:打开模型库」。"
