#!/usr/bin/env bash

# Mom 재시작 스크립트
# Usage: ./restart.sh [data-dir]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${1:-$HOME/.mom-data}"

# Mom 프로세스 찾기 및 종료
echo "Stopping Mom..."
if pkill -f "tsx.*mom/src/main.ts"; then
  echo "Mom process stopped"
else
  echo "No running Mom process found"
fi

# 완전히 종료될 때까지 대기
sleep 2

# 다시 시작 (백그라운드)
echo "Restarting Mom..."
"$SCRIPT_DIR/start.sh" "$DATA_DIR"
