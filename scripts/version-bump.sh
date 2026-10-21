#!/usr/bin/env bash
#
# version-bump.sh — синхронизирует версию пакета в package.json.
#
# Версия — единый источник истины: git-тег `vX.Y.Z`.
# Порядок: scripts/version-bump.sh X.Y.Z → коммит → тег vX.Y.Z → CI публикует.
#
# Использование:
#   ./scripts/version-bump.sh 0.2.0
#
set -euo pipefail

NEW="${1:-}"
if [ -z "$NEW" ]; then
  echo "usage: $0 <version>" >&2
  exit 1
fi

if ! echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "некорректная версия: $NEW (ожидается SemVer, например 0.2.0 или 0.2.0-rc.1)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# npm-пакет: единственное место — package.json.
NEW="$NEW" node -e "
const fs = require('node:fs');
const path = 'package.json';
const json = JSON.parse(fs.readFileSync(path, 'utf8'));
json.version = process.env.NEW;
fs.writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
"

echo "версия пакета → $NEW"
echo "далее: git commit -am 'chore: версия $NEW' && git tag v$NEW && git push --follow-tags"
