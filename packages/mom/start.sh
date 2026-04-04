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
ADMIN_ROOT="$(cd "$REPO_ROOT/../admin" && pwd)"
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
CONTAINER_EXISTS=$(docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$" && echo "yes" || echo "no")
CONTAINER_RUNNING=$(docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$" && echo "yes" || echo "no")

if [ "$CONTAINER_EXISTS" = "yes" ]; then
  # 이미지 검증 — docker.sh에 정의된 이미지와 현재 컨테이너 이미지 비교
  EXPECTED_IMAGE=$(grep '^IMAGE=' "$SCRIPT_DIR/docker.sh" | head -1 | sed 's/IMAGE="//' | sed 's/"//')
  CURRENT_IMAGE=$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}')
  if [ -n "$EXPECTED_IMAGE" ] && [ "$CURRENT_IMAGE" != "$EXPECTED_IMAGE" ]; then
    echo "WARNING: Container image mismatch!"
    echo "  current: $CURRENT_IMAGE  expected: $EXPECTED_IMAGE"
    echo "Recreating container..."
    "$SCRIPT_DIR/docker.sh" remove
    "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
  else
  # 마운트 경로 검증 (/workspace + /pi-mono + /carat-client) — running 여부 관계없이 항상 검증
  CURRENT_WORKSPACE=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}')
  CURRENT_PIMONO=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/pi-mono"}}{{.Source}}{{end}}{{end}}')
  CURRENT_CLIENT=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/carat-client"}}{{.Source}}{{end}}{{end}}')
  CURRENT_ADMIN=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/carat-admin"}}{{.Source}}{{end}}{{end}}')
  CURRENT_AUTH=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/root/.pi/mom"}}{{.Source}}{{end}}{{end}}')
  CURRENT_AGENTS=$(docker inspect "$CONTAINER_NAME" --format '{{range .Mounts}}{{if eq .Destination "/root/.pi/agents"}}{{.Source}}{{end}}{{end}}')
  # auth.json이 호스트에 존재하면 마운트되어야 함
  AUTH_JSON="$HOME/.pi/mom/auth.json"
  EXPECTED_AUTH_DIR=""
  if [ -f "$AUTH_JSON" ]; then
    EXPECTED_AUTH_DIR="$(cd "$(dirname "$AUTH_JSON")" && pwd)"
  fi
  # agents 디렉토리가 호스트에 존재하면 마운트되어야 함
  EXPECTED_AGENTS_DIR=""
  if [ -d "$HOME/.pi/agents" ]; then
    EXPECTED_AGENTS_DIR="$(cd "$HOME/.pi/agents" && pwd)"
  fi
  MOUNT_MISMATCH="no"
  if [ "$CURRENT_WORKSPACE" != "$DATA_DIR" ] || [ "$CURRENT_PIMONO" != "$REPO_ROOT" ] || [ "$CURRENT_CLIENT" != "$CLIENT_ROOT" ] || [ "$CURRENT_ADMIN" != "$ADMIN_ROOT" ]; then
    MOUNT_MISMATCH="yes"
  fi
  # auth.json이 호스트에 있는데 마운트 안 되어 있거나, 경로가 다르면 mismatch
  if [ -n "$EXPECTED_AUTH_DIR" ] && [ "$CURRENT_AUTH" != "$EXPECTED_AUTH_DIR" ]; then
    MOUNT_MISMATCH="yes"
  fi
  # agents 디렉토리가 호스트에 있는데 마운트 안 되어 있거나, 경로가 다르면 mismatch
  if [ -n "$EXPECTED_AGENTS_DIR" ] && [ "$CURRENT_AGENTS" != "$EXPECTED_AGENTS_DIR" ]; then
    MOUNT_MISMATCH="yes"
  fi
  if [ "$MOUNT_MISMATCH" = "yes" ]; then
    echo "WARNING: Container mount mismatch!"
    echo "  /workspace       current: $CURRENT_WORKSPACE  requested: $DATA_DIR"
    echo "  /pi-mono         current: $CURRENT_PIMONO  requested: $REPO_ROOT"
    echo "  /carat-client    current: $CURRENT_CLIENT  requested: $CLIENT_ROOT"
    echo "  /carat-admin     current: $CURRENT_ADMIN  requested: $ADMIN_ROOT"
    echo "  /root/.pi/mom    current: $CURRENT_AUTH  requested: $EXPECTED_AUTH_DIR"
    echo "  /root/.pi/agents current: $CURRENT_AGENTS  requested: $EXPECTED_AGENTS_DIR"
    echo "Recreating container..."
    "$SCRIPT_DIR/docker.sh" remove
    "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
  elif [ "$CONTAINER_RUNNING" = "no" ]; then
    echo "Starting existing container..."
    docker start "$CONTAINER_NAME" > /dev/null
  else
    echo "Container already running with correct mounts."
  fi
  fi
else
  echo "Creating new container..."
  "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
  echo ""
fi

# 컨테이너 내부 소유권 및 git safe.directory 설정
echo "Setting up container permissions..."
docker exec "$CONTAINER_NAME" chown -R "$(id -u):$(id -g)" /pi-mono 2>/dev/null || true
docker exec "$CONTAINER_NAME" chown -R "$(id -u):$(id -g)" /carat-client 2>/dev/null || true
docker exec "$CONTAINER_NAME" chown -R "$(id -u):$(id -g)" /carat-admin 2>/dev/null || true
docker exec "$CONTAINER_NAME" git config --global --add safe.directory /pi-mono 2>/dev/null || true
docker exec "$CONTAINER_NAME" git config --global --add safe.directory /carat-client 2>/dev/null || true
docker exec "$CONTAINER_NAME" git config --global --add safe.directory /carat-admin 2>/dev/null || true

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
