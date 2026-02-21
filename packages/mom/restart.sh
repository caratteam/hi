#!/usr/bin/env bash

# Mom 재시작 스크립트
# Usage: ./restart.sh [data-dir]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTAINER_NAME="mom-sandbox"
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

# 데이터 디렉토리 확인
if [ ! -d "$DATA_DIR" ]; then
  echo "Creating data directory: $DATA_DIR"
  mkdir -p "$DATA_DIR"
fi
DATA_DIR=$(cd "$DATA_DIR" && pwd)
LOG_FILE="$DATA_DIR/mom.log"

# Docker 컨테이너 확인
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Starting container..."
    docker start "$CONTAINER_NAME" > /dev/null
  else
    echo "Creating container..."
    "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
  fi
fi

# Mom 백그라운드로 재시작
echo "Restarting Mom in background..."
echo "Data directory: $DATA_DIR"
echo "Log file: $LOG_FILE"
cd "$REPO_ROOT"
nohup npx tsx packages/mom/src/main.ts --sandbox=docker:${CONTAINER_NAME} "$DATA_DIR" >> "$LOG_FILE" 2>&1 &
PID=$!

echo "Mom restarted with PID: $PID"
echo "To view logs: tail -f $LOG_FILE"
echo "To stop: pkill -f 'tsx.*mom/src/main.ts'"
