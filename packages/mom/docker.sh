#!/usr/bin/env bash

# Mom Docker Sandbox Management Script
# Usage:
#   ./docker.sh create <data-dir>   - Create and start the container
#   ./docker.sh start               - Start the container
#   ./docker.sh stop                - Stop the container
#   ./docker.sh remove              - Remove the container
#   ./docker.sh status              - Check container status
#   ./docker.sh shell               - Open a shell in the container

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLIENT_ROOT="$(cd "$REPO_ROOT/../carat-client" && pwd)"
ADMIN_ROOT="$(cd "$REPO_ROOT/../admin" && pwd)"

CONTAINER_NAME="mom-sandbox"
IMAGE="alpine:latest"

case "$1" in
  create)
    if [ -z "$2" ]; then
      echo "Usage: $0 create <data-dir>"
      echo "Example: $0 create ./data"
      exit 1
    fi
    
    DATA_DIR=$(cd "$2" && pwd)
    
    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' already exists. Remove it first with: $0 remove"
      exit 1
    fi
    
    echo "Creating container '${CONTAINER_NAME}'..."
    echo "  Data dir: ${DATA_DIR} -> /workspace"
    echo "  Client dir: ${CLIENT_ROOT} -> /carat-client"
    echo "  Admin dir: ${ADMIN_ROOT} -> /carat-admin"
    
    # Build env-file for Docker (convert export statements to KEY=VALUE)
    ENV_FILE="$HOME/.mom-env"
    DOCKER_ENV_FILE="/tmp/.mom-docker-env"
    if [ -f "$ENV_FILE" ]; then
      sed 's/^export //' "$ENV_FILE" > "$DOCKER_ENV_FILE"
    else
      touch "$DOCKER_ENV_FILE"
    fi

    docker run -d --init \
      --name "$CONTAINER_NAME" \
      --env-file "$DOCKER_ENV_FILE" \
      -v "${DATA_DIR}:/workspace" \
      -v "${REPO_ROOT}:/pi-mono" \
      -v "${CLIENT_ROOT}:/carat-client" \
      -v "${ADMIN_ROOT}:/carat-admin" \
      "$IMAGE" \
      tail -f /dev/null
    
    if [ $? -eq 0 ]; then
      echo "Container created and running."
      echo ""
      echo "Run mom with: mom --sandbox=docker:${CONTAINER_NAME} $2"
    else
      echo "Failed to create container."
      exit 1
    fi
    ;;
    
  start)
    echo "Starting container '${CONTAINER_NAME}'..."
    docker start "$CONTAINER_NAME"
    ;;
    
  stop)
    echo "Stopping container '${CONTAINER_NAME}'..."
    docker stop "$CONTAINER_NAME"
    ;;
    
  remove)
    echo "Removing container '${CONTAINER_NAME}'..."
    docker rm -f "$CONTAINER_NAME"
    ;;
    
  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' is running."
      docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.ID}}\t{{.Image}}\t{{.Status}}"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Container '${CONTAINER_NAME}' exists but is not running."
      echo "Start it with: $0 start"
    else
      echo "Container '${CONTAINER_NAME}' does not exist."
      echo "Create it with: $0 create <data-dir>"
    fi
    ;;
    
  shell)
    echo "Opening shell in '${CONTAINER_NAME}'..."
    docker exec -it "$CONTAINER_NAME" /bin/sh
    ;;
    
  *)
    echo "Mom Docker Sandbox Management"
    echo ""
    echo "Usage: $0 <command> [args]"
    echo ""
    echo "Commands:"
    echo "  create <data-dir>  - Create and start the container"
    echo "  start              - Start the container"
    echo "  stop               - Stop the container"  
    echo "  remove             - Remove the container"
    echo "  status             - Check container status"
    echo "  shell              - Open a shell in the container"
    ;;
esac
