#!/usr/bin/env bash
#
# Builds and deploys one admin-panel service on the production server.
#
# Usage (as the deploy user, over SSH - never as root, never with sudo):
#   deploy/deploy.sh backend|frontend
#
# What it does:
#   1. git pull --ff-only in that service's repo (stops if it fails)
#   2. TAG = short commit hash; if the Quadlet unit already runs TAG, prints
#      "already deployed" and exits 0 without rebuilding
#   3. podman build -t localhost/admin-<name>:TAG -f Containerfile
#   4. rewrites ONLY the Image= line of ~/.config/containers/systemd/admin-<name>.container,
#      then systemctl --user daemon-reload + restart admin-<name>
#   5. waits up to HEALTH_TIMEOUT seconds for the health check; if it never
#      passes, restores the previous Image= tag, restarts, and exits 1
#   6. on success: podman image prune -f, keeping the KEEP_IMAGES newest tags
#
# NEXT_PUBLIC_SIP_DOMAIN (frontend only - it's baked into the build):
#   read from the NEXT_PUBLIC_SIP_DOMAIN= line of ~/.config/admin-panel/frontend.env,
#   the same file the frontend unit uses as its EnvironmentFile=. Only that one
#   line is read; the file is never sourced. The deploy stops if the file,
#   the line or its value is missing. Override it for a one-off with:
#     NEXT_PUBLIC_SIP_DOMAIN=... deploy/deploy.sh frontend
#
# The other settings below can likewise be overridden on the command line
# (e.g. HEALTH_TIMEOUT=120 deploy/deploy.sh backend). Don't edit them in this
# file on the server: it is tracked in the backend repo, and a local edit
# would make `git pull --ff-only` fail once a commit touches it.
#
# Requires on the server: git, podman, curl, and a systemd user session
# (log in over SSH as the deploy user; `su`/`sudo -u` don't provide one).

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/srv/admin-panel-project}"
NEXT_PUBLIC_SIP_DOMAIN="${NEXT_PUBLIC_SIP_DOMAIN:-}"
UNIT_DIR="${UNIT_DIR:-$HOME/.config/containers/systemd}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
KEEP_IMAGES="${KEEP_IMAGES:-3}"

FRONTEND_ENV_FILE="$HOME/.config/admin-panel/frontend.env"

step_no=0
step() {
  step_no=$((step_no + 1))
  echo
  echo "==> [$step_no] $*"
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

usage() {
  echo "Usage: $0 backend|frontend" >&2
  exit 2
}

# Sets NEXT_PUBLIC_SIP_DOMAIN from the command line if given, otherwise from
# its line in FRONTEND_ENV_FILE. Parses just that line (last one wins, as with
# podman --env-file) instead of sourcing the file, so nothing else in it is
# executed or leaks into this script.
resolve_sip_domain() {
  if [[ -n "$NEXT_PUBLIC_SIP_DOMAIN" ]]; then
    echo "NEXT_PUBLIC_SIP_DOMAIN=$NEXT_PUBLIC_SIP_DOMAIN (from the command line)"
    return
  fi

  [[ -f "$FRONTEND_ENV_FILE" ]] \
    || die "$FRONTEND_ENV_FILE not found - create it with a NEXT_PUBLIC_SIP_DOMAIN=<sip-domain> line"

  local line value
  line="$(grep -E '^[[:space:]]*NEXT_PUBLIC_SIP_DOMAIN=' "$FRONTEND_ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] \
    || die "NEXT_PUBLIC_SIP_DOMAIN is missing from $FRONTEND_ENV_FILE - add a NEXT_PUBLIC_SIP_DOMAIN=<sip-domain> line"

  value="${line#*=}"
  value="${value%$'\r'}"
  # Drop one pair of surrounding quotes, if present.
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  [[ -n "$value" ]] || die "NEXT_PUBLIC_SIP_DOMAIN is empty in $FRONTEND_ENV_FILE"

  NEXT_PUBLIC_SIP_DOMAIN="$value"
  echo "NEXT_PUBLIC_SIP_DOMAIN=$NEXT_PUBLIC_SIP_DOMAIN (from $FRONTEND_ENV_FILE)"
}

health_check() {
  if [[ "$name" == backend ]]; then
    curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port/health"
  else
    curl -fsSI -o /dev/null --max-time 5 "http://127.0.0.1:$port/"
  fi
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    if health_check 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

set_image_tag() {
  sed -i "s|^Image=.*|Image=$image_repo:$1|" "$unit_file"
}

restart_service() {
  systemctl --user daemon-reload
  systemctl --user restart "$service"
}

main() {
  [[ $# -eq 1 ]] || usage
  name="$1"
  case "$name" in
    backend) port=9083 ;;
    frontend) port=9084 ;;
    *) usage ;;
  esac

  if [[ "$(id -u)" -eq 0 ]]; then
    die "do not run as root - run as the deploy user that owns the Quadlet units"
  fi

  repo_dir="$PROJECT_ROOT/$name"
  unit_file="$UNIT_DIR/admin-$name.container"
  service="admin-$name"
  image_repo="localhost/admin-$name"

  [[ -d "$repo_dir/.git" ]] || die "$repo_dir is not a git repository"
  [[ -f "$unit_file" ]] || die "unit file not found: $unit_file"
  grep -q '^Image=' "$unit_file" || die "no Image= line in $unit_file"
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "no systemd user session - log in over SSH as the deploy user (not su/sudo)"
  if [[ "$name" == frontend ]]; then
    resolve_sip_domain
  fi

  step "Pulling $repo_dir"
  cd "$repo_dir"
  git pull --ff-only || die "git pull --ff-only failed - resolve it in $repo_dir and re-run"
  tag="$(git rev-parse --short HEAD)"
  echo "Commit: $tag"

  step "Checking the currently deployed image"
  local current_image
  current_image="$(grep -m1 '^Image=' "$unit_file" | cut -d= -f2-)"
  previous="${current_image##*:}"
  echo "Current: $current_image"
  if [[ "$previous" == "$tag" ]]; then
    echo "$service is already deployed at $tag - nothing to do."
    exit 0
  fi

  step "Building $image_repo:$tag"
  local build_args=()
  if [[ "$name" == frontend ]]; then
    build_args+=(--build-arg "NEXT_PUBLIC_SIP_DOMAIN=$NEXT_PUBLIC_SIP_DOMAIN")
  fi
  podman build ${build_args[@]+"${build_args[@]}"} -t "$image_repo:$tag" -f Containerfile .

  step "Switching $unit_file to $tag (Image= line only)"
  set_image_tag "$tag"
  grep '^Image=' "$unit_file"

  step "Restarting $service"
  restart_service

  step "Waiting up to ${HEALTH_TIMEOUT}s for $service to pass its health check (port $port)"
  if ! wait_healthy; then
    echo "Health check failed for $tag - rolling back to $previous" >&2
    set_image_tag "$previous"
    restart_service
    if ! podman image exists "$image_repo:$previous"; then
      die "DEPLOY FAILED: $tag never became healthy, and there is no earlier image ($image_repo:$previous) to roll back to - $service is down"
    fi
    if wait_healthy; then
      die "DEPLOY FAILED: $tag never became healthy - rolled back to $previous, which is healthy"
    fi
    die "DEPLOY FAILED: $tag never became healthy - rolled back to $previous, but it is NOT healthy either; check: journalctl --user -u $service"
  fi
  echo "Healthy."

  step "Cleaning up old images (keeping the $KEEP_IMAGES newest $image_repo tags)"
  podman image prune -f
  # Newest first. `|| true`: grep exits 1 when the new tag is the only one
  # (e.g. the first deploy), which pipefail would otherwise turn into a failure.
  local old_tags
  old_tags="$(podman images --noheading --sort created --filter "reference=$image_repo" --format '{{.Tag}}' \
    | { grep -v -x -e "$tag" -e '<none>' || true; } | tail -n +"$KEEP_IMAGES")"
  for old in $old_tags; do
    podman rmi "$image_repo:$old" || echo "WARNING: could not remove $image_repo:$old" >&2
  done

  echo
  echo "Deployed $service at $tag."
}

main "$@"
