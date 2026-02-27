#!/usr/bin/env bash

# Mom 실행 스크립트 (이전 프로세스 자동 종료 후 시작)
# Usage: ./start.sh [data-dir]
# Default data-dir: ~/.mom-data

set -e

# Load environment variables (Slack tokens, etc.)
if [ -f "$HOME/.mom-env" ]; then
  source "$HOME/.mom-env"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLIENT_ROOT="$(cd "$REPO_ROOT/../carat-client" && pwd)"
CONTAINER_NAME="mom-sandbox"

# 데이터 디렉토리 설정 (기본값: ~/.mom-data)
DATA_DIR="${1:-$HOME/.mom-data}"

# 기존 Mom 프로세스 종료
if pkill -f "tsx.*mom/src/main.ts"; then
  echo "Stopped previous Mom process"
  sleep 2
fi

# 데이터 디렉토리가 없으면 생성
if [ ! -d "$DATA_DIR" ]; then
  echo "Creating data directory: $DATA_DIR"
  mkdir -p "$DATA_DIR"
fi

# 절대 경로로 변환
DATA_DIR=$(cd "$DATA_DIR" && pwd)

# 로그 파일 경로
LOG_FILE="$DATA_DIR/mom.log"

# Docker 컨테이너 상태 확인 및 시작
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    # 마운트 경로 검증 (/workspace + /pi-mono + /carat-client)
    CURRENT_WORKSPACE=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}')
    CURRENT_PIMONO=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/pi-mono"}}{{.Source}}{{end}}{{end}}')
    CURRENT_CLIENT=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/carat-client"}}{{.Source}}{{end}}{{end}}')
    if [ "$CURRENT_WORKSPACE" != "$DATA_DIR" ] || [ "$CURRENT_PIMONO" != "$REPO_ROOT" ] || [ "$CURRENT_CLIENT" != "$CLIENT_ROOT" ]; then
      echo "WARNING: Container mount mismatch!"
      echo "  /workspace     current: $CURRENT_WORKSPACE  requested: $DATA_DIR"
      echo "  /pi-mono       current: $CURRENT_PIMONO  requested: $REPO_ROOT"
      echo "  /carat-client  current: $CURRENT_CLIENT  requested: $CLIENT_ROOT"
      echo "Recreating container..."
      "$SCRIPT_DIR/docker.sh" remove
      "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
    else
      echo "Starting existing container..."
      docker start "$CONTAINER_NAME" > /dev/null
    fi
  else
    echo "Creating new container..."
    "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
    echo ""
  fi
fi

# Mom 백그라운드 실행
echo "Starting Mom with data directory: $DATA_DIR"
echo "─────────────────────────────────────────────────────────"
cd "$REPO_ROOT"

nohup npx tsx packages/mom/src/main.ts --sandbox=docker:${CONTAINER_NAME} "$DATA_DIR" >> "$LOG_FILE" 2>&1 &
disown
PID=$!

sleep 1
echo "Mom started with PID: $PID"
echo "Log file: $LOG_FILE"
echo "To view logs: tail -f $LOG_FILE"
echo "To stop: pkill -f 'tsx.*mom/src/main.ts'"
