#!/usr/bin/env bash
# 把本仓库 skills/ 下的技能安装到 Codex 技能目录。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/skills"
dest="${CODEX_HOME:-$HOME/.codex}/skills"

[ -d "$src" ] || { echo "找不到 $src" >&2; exit 1; }
mkdir -p "$dest"

for d in "$src"/*/; do
  name="$(basename "$d")"
  [ -f "$d/SKILL.md" ] || continue
  rm -rf "${dest:?}/$name"
  cp -R "$d" "$dest/$name"
  echo "installed $name -> $dest/$name"
done
echo "done. 技能目录：$dest"
