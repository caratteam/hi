#!/usr/bin/env bash

# Mom 재시작 스크립트
# Usage: ./restart.sh [data-dir]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Mom 프로세스 찾기 및 종료
echo "Stopping Mom..."
pkill -f "tsx.*mom/src/main.ts" || echo "No running Mom process found"

# 잠시 대기
sleep 2

# 다시 시작
echo "Restarting Mom..."
"$SCRIPT_DIR/start.sh" "$@"
