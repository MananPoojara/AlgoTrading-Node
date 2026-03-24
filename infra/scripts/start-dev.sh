#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/infra/docker/docker-compose.yml"
SERVICES=()
RESET_PAPER_OMS=0
INTERACTIVE_USED=0
AVAILABLE_SERVICES=(
  "postgres"
  "redis"
  "market-data-service"
  "strategy-engine"
  "market-scheduler"
  "order-manager"
  "api-server"
  "dashboard"
)

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
else
  BOLD=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  CYAN=""
  RESET=""
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not in PATH."
  exit 1
fi

if command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose -f "$COMPOSE_FILE")
elif docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose -f "$COMPOSE_FILE")
else
  echo "Error: neither 'docker compose' nor 'docker-compose' is available."
  exit 1
fi

print_banner() {
  cat <<EOF
${CYAN}${BOLD}
    ___    __         ______                ___
   /   |  / /___ ____/_  __/________ _____/ (_)___  ____ _
  / /| | / / __ \`/ _ \/ / / ___/ __ \`/ __  / / __ \/ __ \`/
 / ___ |/ / /_/ /  __/ / / /  / /_/ / /_/ / / / / / /_/ /
/_/  |_/_/\__, /\___/_/ /_/   \__,_/\__,_/_/_/ /_/\__, /
         /____/                                  /____/
${RESET}${DIM}  Docker control console for local paper trading${RESET}
EOF
}

print_usage() {
  cat <<EOF
Usage:
  ./infra/scripts/start-dev.sh
  ./infra/scripts/start-dev.sh [--reset-paper-oms] [service ...]

Examples:
  ./infra/scripts/start-dev.sh
  ./infra/scripts/start-dev.sh --reset-paper-oms
  ./infra/scripts/start-dev.sh strategy-engine api-server
  ./infra/scripts/start-dev.sh --reset-paper-oms market-data-service strategy-engine
EOF
}

log_info() {
  echo "${BLUE}${BOLD}==>${RESET} $*"
}

log_warn() {
  echo "${YELLOW}${BOLD}warn:${RESET} $*"
}

log_success() {
  echo "${GREEN}${BOLD}ok:${RESET} $*"
}

log_error() {
  echo "${RED}${BOLD}error:${RESET} $*"
}

prompt_yes_no() {
  local prompt="$1"
  local default_answer="${2:-N}"
  local reply=""

  if [[ ! -t 0 ]]; then
    [[ "$default_answer" =~ ^[Yy]$ ]]
    return
  fi

  while true; do
    read -r -p "$prompt " reply
    reply="${reply:-$default_answer}"
    case "$reply" in
      Y|y|yes|YES) return 0 ;;
      N|n|no|NO) return 1 ;;
      *) echo "Enter y or n." ;;
    esac
  done
}

resolve_service_token() {
  local token="$1"

  if [[ "$token" =~ ^[0-9]+$ ]]; then
    local index=$((token - 1))
    if (( index >= 0 && index < ${#AVAILABLE_SERVICES[@]} )); then
      echo "${AVAILABLE_SERVICES[$index]}"
      return 0
    fi
  fi

  for service in "${AVAILABLE_SERVICES[@]}"; do
    if [[ "$service" == "$token" ]]; then
      echo "$service"
      return 0
    fi
  done

  return 1
}

collect_custom_services() {
  local raw_input=""
  local token=""
  local resolved=""
  local selected=()

  echo
  echo "${BOLD}Available services${RESET}"
  local i=1
  for service in "${AVAILABLE_SERVICES[@]}"; do
    printf "  ${CYAN}%s)${RESET} %s\n" "$i" "$service"
    i=$((i + 1))
  done
  echo

  while true; do
    read -r -p "Select services by number or name (space/comma separated, or 'all'): " raw_input
    raw_input="${raw_input//,/ }"

    if [[ -z "$raw_input" || "$raw_input" == "all" ]]; then
      SERVICES=()
      return 0
    fi

    selected=()
    local invalid=0
    for token in $raw_input; do
      if ! resolved="$(resolve_service_token "$token")"; then
        log_warn "Unknown service selection: $token"
        invalid=1
        break
      fi

      if [[ ! " ${selected[*]} " =~ " ${resolved} " ]]; then
        selected+=("$resolved")
      fi
    done

    if (( invalid == 0 )) && (( ${#selected[@]} > 0 )); then
      SERVICES=("${selected[@]}")
      return 0
    fi
  done
}

run_interactive_cli() {
  local choice=""
  INTERACTIVE_USED=1

  print_banner
  echo
  echo "${BOLD}Launch Mode${RESET}"
  echo "  ${CYAN}1)${RESET} Full restart"
  echo "  ${CYAN}2)${RESET} Full restart + reset paper OMS"
  echo "  ${CYAN}3)${RESET} Select services"
  echo "  ${CYAN}4)${RESET} Select services + reset paper OMS"
  echo "  ${CYAN}5)${RESET} Exit"
  echo

  while true; do
    read -r -p "Choose an option [1-5]: " choice
    case "$choice" in
      1)
        SERVICES=()
        RESET_PAPER_OMS=0
        return 0
        ;;
      2)
        SERVICES=()
        RESET_PAPER_OMS=1
        return 0
        ;;
      3)
        RESET_PAPER_OMS=0
        collect_custom_services
        return 0
        ;;
      4)
        RESET_PAPER_OMS=1
        collect_custom_services
        return 0
        ;;
      5)
        echo "Cancelled."
        exit 0
        ;;
      *)
        echo "Choose a valid option."
        ;;
    esac
  done
}

print_run_summary() {
  local service_label="all services"

  if (( ${#SERVICES[@]} > 0 )); then
    service_label="${SERVICES[*]}"
  fi

  echo
  echo "${BOLD}Run Summary${RESET}"
  echo "  root:   $PROJECT_ROOT"
  echo "  scope:  $service_label"
  if [[ "$RESET_PAPER_OMS" -eq 1 ]]; then
    echo "  reset:  paper OMS tables will be cleared"
  else
    echo "  reset:  no paper OMS cleanup"
  fi
  echo
}

wait_for_container_health() {
  local container_name="$1"
  local timeout_seconds="${2:-120}"
  local elapsed=0

  log_info "Waiting for $container_name to become healthy..."

  while (( elapsed < timeout_seconds )); do
    local status
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_name" 2>/dev/null || true)"

    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      log_success "$container_name is $status."
      return 0
    fi

    sleep 2
    elapsed=$((elapsed + 2))
  done

  log_error "Timed out waiting for $container_name."
  exit 1
}

cleanup_stale_algo_containers() {
  local stale_containers=()

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    stale_containers+=("${line%% *}")
  done < <(docker ps -a --format '{{.Names}} {{.Status}}' | awk '/algo-/ && /Exited/ { print $0 }')

  if [[ ${#stale_containers[@]} -eq 0 ]]; then
    return 0
  fi

  log_info "Removing stale exited algo containers to avoid docker-compose recreate errors..."
  docker rm -f "${stale_containers[@]}" >/dev/null
}

is_container_running() {
  local container_name="$1"
  local status

  status="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)"
  [[ "$status" == "running" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    --reset-paper-oms)
      RESET_PAPER_OMS=1
      shift
      ;;
    *)
      SERVICES+=("$1")
      shift
      ;;
  esac
done

if [[ $# -eq 0 && ${#SERVICES[@]} -eq 0 && "$RESET_PAPER_OMS" -eq 0 && -t 0 ]]; then
  run_interactive_cli
fi

if [[ "$INTERACTIVE_USED" -eq 0 ]]; then
  print_banner
fi
print_run_summary

log_info "Starting Algo Trading Platform from $PROJECT_ROOT"

if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
  log_error ".env file not found at $PROJECT_ROOT/.env"
  echo "Copy .env.example to .env in the project root and update credentials first."
  exit 1
fi

cleanup_stale_algo_containers

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  log_info "Stopping and removing existing containers..."
  "${COMPOSE_CMD[@]}" down --remove-orphans
else
  log_info "Stopping and removing selected services..."
  "${COMPOSE_CMD[@]}" stop "${SERVICES[@]}" || true
  "${COMPOSE_CMD[@]}" rm -f "${SERVICES[@]}" || true
fi

cleanup_stale_algo_containers

UP_ARGS=(up -d --build)
if [[ ${#SERVICES[@]} -gt 0 ]]; then
  UP_ARGS+=("${SERVICES[@]}")
fi

log_info "Building and starting Docker services..."
"${COMPOSE_CMD[@]}" "${UP_ARGS[@]}"

wait_for_container_health "algo-postgres" 120
wait_for_container_health "algo-redis" 120

if is_container_running "algo-api"; then
  log_info "Running database migrations inside api-server container..."
  if "${COMPOSE_CMD[@]}" exec -T api-server npm run migrate; then
    log_success "Database migrations completed."
  else
    log_warn "Database migrations failed. Continuing with the running stack."
  fi

  if [[ "$RESET_PAPER_OMS" -eq 1 ]]; then
    log_info "Resetting paper OMS tables while preserving market data..."
    "${COMPOSE_CMD[@]}" exec -T api-server npm run reset:paper
    log_success "Paper OMS state reset completed."
  fi
else
  log_warn "Skipping database migrations because algo-api is not running."
fi

echo
log_success "Platform startup complete."
echo "API:       http://localhost:3001"
echo "Dashboard: http://localhost:3000"
echo
echo "${BOLD}Useful commands${RESET}"
echo "  View status: ${COMPOSE_CMD[*]} ps"
echo "  View logs:   ${COMPOSE_CMD[*]} logs -f"
echo "  Stop stack:  ${COMPOSE_CMD[*]} down"
