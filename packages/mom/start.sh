#!/usr/bin/env bash

# Mom 간편 실행 스크립트
# Usage: ./start.sh [data-dir]
# Default data-dir: ~/.mom-data

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTAINER_NAME="mom-sandbox"

# 데이터 디렉토리 설정 (기본값: ~/.mom-data)
DATA_DIR="${1:-$HOME/.mom-data}"

# 데이터 디렉토리가 없으면 생성
if [ ! -d "$DATA_DIR" ]; then
  echo "Creating data directory: $DATA_DIR"
  mkdir -p "$DATA_DIR"
fi

# 절대 경로로 변환
DATA_DIR=$(cd "$DATA_DIR" && pwd)

# Docker 컨테이너 상태 확인 및 시작
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Starting existing container..."
    docker start "$CONTAINER_NAME" > /dev/null
  else
    echo "Creating new container..."
    "$SCRIPT_DIR/docker.sh" create "$DATA_DIR"
    echo ""
  fi
fi

# Mom 실행
echo "Starting Mom with data directory: $DATA_DIR"
echo "─────────────────────────────────────────────────────────"
cd "$REPO_ROOT"
npx tsx packages/mom/src/main.ts --sandbox=docker:${CONTAINER_NAME} "$DATA_DIR"
