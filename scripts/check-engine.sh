#!/usr/bin/env bash
# 跨系统对账引擎的行为验证（幂等重投、冲突闸门、基准偏离、逐字段来源应用）
set -euo pipefail
cd "$(dirname "$0")/.."
node_modules/.bin/esbuild scripts/check-engine.mts --bundle --platform=node --format=esm --outfile=scripts/.check-engine.mjs >/dev/null
node scripts/.check-engine.mjs
rm -f scripts/.check-engine.mjs
