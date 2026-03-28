#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/infra/docker/docker-compose.yml"
MAINTENANCE_TEMPLATE="$PROJECT_ROOT/infra/docker/maintenance/index.template.html"
MAINTENANCE_DIR="$PROJECT_ROOT/var/tmp/dashboard-maintenance"
MAINTENANCE_FILE="$MAINTENANCE_DIR/index.html"
SERVICES=()
TARGET_SERVICES=()
INTERACTIVE_USED=0
RESET_PAPER_OMS=0
USE_MAINTENANCE=1
SKIP_DASHBOARD_BUILD=0
START_DASHBOARD=0
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
  MAGENTA=$'\033[35m'
  RESET=$'\033[0m'
else
  BOLD=""
  DIM=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  CYAN=""
  MAGENTA=""
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
${RESET}${DIM}  Operator console for local paper-trading startup${RESET}
EOF
}

print_usage() {
  cat <<EOF
Usage:
  ./infra/scripts/start-dev.sh
  ./infra/scripts/start-dev.sh [--reset-paper-oms] [--no-maintenance] [--skip-dashboard-build] [service ...]

Examples:
  ./infra/scripts/start-dev.sh
  ./infra/scripts/start-dev.sh --reset-paper-oms
  ./infra/scripts/start-dev.sh dashboard
  ./infra/scripts/start-dev.sh --no-maintenance api-server dashboard
  ./infra/scripts/start-dev.sh strategy-engine api-server
EOF
}

log_info() {
  echo "${BLUE}${BOLD}==>${RESET} $*"
}

log_stage() {
  echo
  echo "${MAGENTA}${BOLD}[$1]${RESET} ${BOLD}$2${RESET}"
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
  echo "  ${CYAN}1)${RESET} Full staged startup"
  echo "  ${CYAN}2)${RESET} Full staged startup + reset paper OMS"
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

contains_service() {
  local wanted="$1"
  shift || true
  local service
  for service in "$@"; do
    if [[ "$service" == "$wanted" ]]; then
      return 0
    fi
  done
  return 1
}

append_unique_service() {
  local service="$1"
  if ! contains_service "$service" "${TARGET_SERVICES[@]}"; then
    TARGET_SERVICES+=("$service")
  fi
}

prepare_target_services() {
  if [[ ${#SERVICES[@]} -eq 0 ]]; then
    TARGET_SERVICES=("${AVAILABLE_SERVICES[@]}")
  else
    TARGET_SERVICES=("${SERVICES[@]}")
  fi

  if contains_service "dashboard" "${TARGET_SERVICES[@]}"; then
    START_DASHBOARD=1
    if ! contains_service "api-server" "${TARGET_SERVICES[@]}"; then
      append_unique_service "api-server"
      log_info "Added api-server because dashboard depends on it."
    fi
  fi
}

print_run_summary() {
  local service_label
  if (( ${#SERVICES[@]} == 0 )); then
    service_label="all default services"
  else
    service_label="${SERVICES[*]}"
  fi

  echo
  echo "${BOLD}Run Summary${RESET}"
  echo "  root:        $PROJECT_ROOT"
  echo "  scope:       $service_label"
  echo "  maintenance: $([[ "$USE_MAINTENANCE" -eq 1 ]] && echo "enabled" || echo "disabled")"
  echo "  dashboard:   $([[ "$START_DASHBOARD" -eq 1 ]] && echo "included" || echo "skipped")"
  echo "  build reuse: $([[ "$SKIP_DASHBOARD_BUILD" -eq 1 ]] && echo "skip dashboard build" || echo "fresh dashboard build")"
  echo "  reset OMS:   $([[ "$RESET_PAPER_OMS" -eq 1 ]] && echo "yes" || echo "no")"
  echo
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

  log_info "Removing stale exited algo containers to avoid recreate errors..."
  docker rm -f "${stale_containers[@]}" >/dev/null
}

is_container_running() {
  local container_name="$1"
  local status

  status="$(docker inspect --format '{{.State.Status}}' "$container_name" 2>/dev/null || true)"
  [[ "$status" == "running" ]]
}

wait_for_container_health() {
  local container_name="$1"
  local timeout_seconds="${2:-120}"
  local elapsed=0

  log_info "Waiting for $container_name health..."
  while (( elapsed < timeout_seconds )); do
    local status
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_name" 2>/dev/null || true)"

    if [[ "$status" == "healthy" || "$status" == "running" ]]; then
      log_success "$container_name is $status."
      return 0
    fi

    printf "${DIM}   ... %ss${RESET}\r" "$elapsed"
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo
  log_error "Timed out waiting for $container_name."
  return 1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-120}"
  local elapsed=0

  log_info "Waiting for $label at $url ..."
  while (( elapsed < timeout_seconds )); do
    local status
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)"
    if [[ "$status" =~ ^[234] ]]; then
      log_success "$label is reachable (HTTP $status)."
      return 0
    fi

    printf "${DIM}   ... %ss${RESET}\r" "$elapsed"
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo
  log_error "Timed out waiting for $label at $url."
  return 1
}

render_maintenance_page() {
  local stage="$1"
  local detail="$2"
  local updated_at
  updated_at="$(TZ=Asia/Kolkata date '+%d %b %Y %I:%M:%S %p IST')"

  mkdir -p "$MAINTENANCE_DIR"
  sed \
    -e "s|__MAINTENANCE_STAGE__|$stage|g" \
    -e "s|__MAINTENANCE_DETAIL__|$detail|g" \
    -e "s|__MAINTENANCE_UPDATED_AT__|$updated_at|g" \
    "$MAINTENANCE_TEMPLATE" >"$MAINTENANCE_FILE"
}

start_maintenance_page() {
  render_maintenance_page "$1" "$2"
  "${COMPOSE_CMD[@]}" up -d dashboard-maintenance >/dev/null
  wait_for_http "http://localhost:3000" "maintenance page" 30
}

update_maintenance_page() {
  render_maintenance_page "$1" "$2"
}

stop_maintenance_page() {
  "${COMPOSE_CMD[@]}" stop dashboard-maintenance >/dev/null 2>&1 || true
  "${COMPOSE_CMD[@]}" rm -f dashboard-maintenance >/dev/null 2>&1 || true
}

show_relevant_logs() {
  local service="$1"
  echo
  log_warn "Recent logs for $service:"
  "${COMPOSE_CMD[@]}" logs --tail=40 "$service" || true
}

preflight_checks() {
  if [[ ! -f "$PROJECT_ROOT/.env" ]]; then
    log_error ".env file not found at $PROJECT_ROOT/.env"
    echo "Copy .env.example to .env in the project root and update credentials first."
    exit 1
  fi

  if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
    log_error "Root node_modules is missing at $PROJECT_ROOT/node_modules"
    echo "Run 'npm install' in the project root before using the local Docker paper stack."
    exit 1
  fi

  if [[ ! -f "$MAINTENANCE_TEMPLATE" ]]; then
    log_error "Maintenance template not found at $MAINTENANCE_TEMPLATE"
    exit 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    log_error "curl is required for HTTP readiness checks."
    exit 1
  fi
}

shutdown_scope() {
  cleanup_stale_algo_containers

  if (( ${#SERVICES[@]} == 0 )); then
    log_info "Stopping and removing the current stack..."
    "${COMPOSE_CMD[@]}" down --remove-orphans || true
  else
    local to_stop=("${TARGET_SERVICES[@]}")
    if [[ "$START_DASHBOARD" -eq 1 ]]; then
      to_stop+=("dashboard-maintenance")
    fi

    log_info "Stopping and removing selected services..."
    "${COMPOSE_CMD[@]}" stop "${to_stop[@]}" >/dev/null 2>&1 || true
    "${COMPOSE_CMD[@]}" rm -f "${to_stop[@]}" >/dev/null 2>&1 || true
  fi

  cleanup_stale_algo_containers
}

build_dashboard_image() {
  if [[ "$START_DASHBOARD" -ne 1 ]]; then
    return 0
  fi

  if [[ "$SKIP_DASHBOARD_BUILD" -eq 1 ]]; then
    log_warn "Skipping dashboard image build by request."
    return 0
  fi

  if [[ "$USE_MAINTENANCE" -eq 1 ]]; then
    update_maintenance_page "Building dashboard image" "Compiling the operator UI into a production image."
  fi

  log_stage "4/9" "Building dashboard image"
  "${COMPOSE_CMD[@]}" build dashboard
  log_success "Dashboard image built."
}

start_infra_base() {
  log_stage "2/9" "Starting infrastructure base"
  "${COMPOSE_CMD[@]}" up -d postgres redis
  wait_for_container_health "algo-postgres" 120
  wait_for_container_health "algo-redis" 120
}

start_backend_services() {
  local app_services=()
  local service

  for service in "${TARGET_SERVICES[@]}"; do
    case "$service" in
      postgres|redis|dashboard) ;;
      *) app_services+=("$service") ;;
    esac
  done

  if (( ${#app_services[@]} == 0 )); then
    return 0
  fi

  if [[ "$USE_MAINTENANCE" -eq 1 && "$START_DASHBOARD" -eq 1 ]]; then
    update_maintenance_page "Starting backend services" "Waiting for API and core paper-trading services to report healthy."
  fi

  log_stage "5/9" "Building and starting backend services"
  "${COMPOSE_CMD[@]}" up -d --build "${app_services[@]}"
}

run_post_start_db_tasks() {
  if ! is_container_running "algo-api"; then
    log_warn "Skipping migrations because algo-api is not running."
    return 0
  fi

  log_stage "7/9" "Running database tasks"
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
}

start_dashboard_service() {
  if [[ "$START_DASHBOARD" -ne 1 ]]; then
    return 0
  fi

  log_stage "8/9" "Cutting over to the real dashboard"

  if [[ "$USE_MAINTENANCE" -eq 1 ]]; then
    update_maintenance_page "Starting dashboard" "Backend is healthy. Switching from maintenance page to the operator cockpit."
    stop_maintenance_page
  fi

  "${COMPOSE_CMD[@]}" up -d dashboard

  if wait_for_http "http://localhost:3000" "dashboard" 90; then
    log_success "Dashboard cutover complete."
    return 0
  fi

  if [[ "$USE_MAINTENANCE" -eq 1 ]]; then
    log_warn "Dashboard failed health checks. Restoring maintenance page."
    start_maintenance_page "Dashboard unavailable" "Startup did not complete. Review logs and retry."
  fi

  show_relevant_logs "dashboard"
  exit 1
}

print_service_status_table() {
  echo
  echo "${BOLD}Service Status${RESET}"
  printf "  %-24s %-18s %-18s\n" "SERVICE" "STATE" "HEALTH"

  local service container state health
  for service in "${TARGET_SERVICES[@]}"; do
    case "$service" in
      postgres) container="algo-postgres" ;;
      redis) container="algo-redis" ;;
      market-data-service) container="algo-market-data" ;;
      strategy-engine) container="algo-strategy-engine" ;;
      market-scheduler) container="algo-market-scheduler" ;;
      order-manager) container="algo-order-manager" ;;
      api-server) container="algo-api" ;;
      dashboard) container="algo-dashboard" ;;
      *) container="" ;;
    esac

    if [[ -z "$container" ]]; then
      continue
    fi

    state="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || echo "missing")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' "$container" 2>/dev/null || echo "n/a")"
    printf "  %-24s %-18s %-18s\n" "$service" "$state" "$health"
  done
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
    --no-maintenance)
      USE_MAINTENANCE=0
      shift
      ;;
    --skip-dashboard-build)
      SKIP_DASHBOARD_BUILD=1
      shift
      ;;
    *)
      SERVICES+=("$1")
      shift
      ;;
  esac
done

if [[ ${#SERVICES[@]} -eq 0 && "$RESET_PAPER_OMS" -eq 0 && "$USE_MAINTENANCE" -eq 1 && "$SKIP_DASHBOARD_BUILD" -eq 0 && -t 0 ]]; then
  run_interactive_cli
fi

if [[ "$INTERACTIVE_USED" -eq 0 ]]; then
  print_banner
fi

prepare_target_services
print_run_summary

log_stage "1/9" "Preflight checks"
preflight_checks
log_success "Environment checks passed."

shutdown_scope
start_infra_base

if [[ "$START_DASHBOARD" -eq 1 && "$USE_MAINTENANCE" -eq 1 ]]; then
  log_stage "3/9" "Bringing up the maintenance page"
  start_maintenance_page "Preparing stack" "Infrastructure is healthy. The dashboard will replace this page after backend readiness checks pass."
fi

build_dashboard_image
start_backend_services

if contains_service "api-server" "${TARGET_SERVICES[@]}"; then
  log_stage "6/9" "Waiting for API readiness"
  wait_for_http "http://localhost:3001/health" "api-server" 90 || {
    show_relevant_logs "api-server"
    exit 1
  }
fi

run_post_start_db_tasks
start_dashboard_service

log_stage "9/9" "Startup complete"
print_service_status_table

echo
log_success "Platform startup complete."
echo "  Dashboard:          http://localhost:3000"
echo "  API:                http://localhost:3001"
echo "  WebSocket gateway:  ws://localhost:8080"
echo
echo "${BOLD}Useful commands${RESET}"
echo "  View status: ${COMPOSE_CMD[*]} ps"
echo "  View logs:   ${COMPOSE_CMD[*]} logs -f"
echo "  Stop stack:  ${COMPOSE_CMD[*]} down"
