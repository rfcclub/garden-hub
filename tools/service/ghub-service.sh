#!/bin/bash
# ghub-service - install, remove and inspect the Garden Hub dashboard launchd
# user agent on macOS.
#
#   ghub-service.sh print      write the filled-in plist to stdout (default)
#   ghub-service.sh install    install and load the agent [--force]
#   ghub-service.sh uninstall  unload and remove the agent
#   ghub-service.sh status     show whether the agent is loaded and what the
#                              dashboard's /api/ answers
#
# `print` changes nothing: no file is written and launchd is never contacted.
# The agent runs this checkout's tools/ghub-dashboard.mjs with the absolute
# node and repository paths resolved now, so a later PATH change cannot break
# it. Missing paths are an error, never a guess.

set -euo pipefail

LABEL="com.anima.garden-hub-dashboard"
DEFAULT_PORT=47820

# Pure shell: `dirname` is not on PATH when `print` runs with an empty PATH, and
# the only failure that case may report is the missing node.
SCRIPT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TEMPLATE="${SCRIPT_DIR}/${LABEL}.plist.template"

die() {
  echo "ghub-service: $*" >&2
  exit 1
}

usage() {
  sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

# The agent lives in the operator's home directory; without HOME there is no
# place to install it and no log path to fill in.
require_home() {
  [ -n "${HOME:-}" ] || die "HOME is not set; cannot locate ~/Library"
  case "${HOME}" in
    /*) ;;
    *) die "HOME is not an absolute path (${HOME}); refusing to use it" ;;
  esac
}

# Absolute node path. `command -v` is looked up in the current PATH on purpose:
# the operator's shell decides which node the agent runs.
resolve_node() {
  local node
  node="$(command -v node 2>/dev/null || true)"
  [ -n "${node}" ] || die "cannot find node on PATH; install node or add it to PATH"
  case "${node}" in
    /*) ;;
    *) die "node resolved to a relative path (${node}); refusing to use it" ;;
  esac
  [ -x "${node}" ] || die "node is not executable: ${node}"
  printf '%s\n' "${node}"
}

# A missing entry point would load an agent that can never start.
check_dashboard() {
  [ -d "${REPO}" ] || die "repository root not found: ${REPO}"
  [ -f "${REPO}/tools/ghub-dashboard.mjs" ] ||
    die "dashboard entry point not found: ${REPO}/tools/ghub-dashboard.mjs"
}

# The dashboard's own default is used unless the caller overrides it.
resolve_port() {
  local port="${GHUB_DASHBOARD_PORT:-${DEFAULT_PORT}}"
  case "${port}" in
    ''|*[!0-9]*) die "GHUB_DASHBOARD_PORT must be a number, got: ${port}" ;;
  esac
  [ "${port}" -ge 1 ] && [ "${port}" -le 65535 ] ||
    die "GHUB_DASHBOARD_PORT is out of range: ${port}"
  printf '%s\n' "${port}"
}

agent_dir() {
  require_home
  printf '%s\n' "${HOME}/Library/LaunchAgents"
}

agent_path() {
  printf '%s/%s.plist\n' "$(agent_dir)" "${LABEL}"
}

log_dir() {
  require_home
  printf '%s\n' "${HOME}/Library/Logs/anima"
}

render() {
  local node port
  node="$(resolve_node)"
  port="$(resolve_port)"
  [ -f "${TEMPLATE}" ] || die "plist template not found: ${TEMPLATE}"

  sed \
    -e "s|@NODE@|${node}|g" \
    -e "s|@REPO@|${REPO}|g" \
    -e "s|@PORT@|${port}|g" \
    -e "s|@LOG@|$(log_dir)/garden-hub-dashboard.log|g" \
    "${TEMPLATE}"
}

cmd_print() {
  render
}

cmd_install() {
  local force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1 ;;
      *) die "unknown install option: $1" ;;
    esac
    shift
  done

  check_dashboard

  local plist agent
  plist="$(render)"
  agent="$(agent_path)"

  if [ -f "${agent}" ] && [ "${force}" -ne 1 ] &&
    [ "${plist}" != "$(cat "${agent}")" ]; then
    die "${agent} exists with different contents; re-run with --force to replace it"
  fi

  mkdir -p "$(agent_dir)" "$(log_dir)"
  printf '%s\n' "${plist}" >"${agent}"
  chmod 644 "${agent}"

  # Replace a previously loaded copy so the new one takes effect.
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${agent}" ||
    die "launchctl bootstrap failed for ${agent}"

  echo "installed ${agent}"
  echo "log: $(log_dir)/garden-hub-dashboard.log"
}

cmd_uninstall() {
  local agent
  agent="$(agent_path)"
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  if [ -f "${agent}" ]; then
    rm -f "${agent}"
    echo "removed ${agent}"
  else
    echo "not installed: ${agent}"
  fi
}

cmd_status() {
  require_home
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    echo "job: loaded (${LABEL})"
  else
    echo "job: not loaded (${LABEL})"
  fi

  local agent
  agent="$(agent_path)"
  if [ -f "${agent}" ]; then
    echo "plist: ${agent}"
  else
    echo "plist: absent (${agent})"
  fi

  local port
  port="$(resolve_port)"
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:${port}/api/" 2>/dev/null || true)"
    echo "http: GET http://127.0.0.1:${port}/api/ -> ${code:-no response}"
  else
    echo "http: curl not found; cannot probe http://127.0.0.1:${port}/api/"
  fi
}

main() {
  local command="${1:-print}"
  if [ $# -gt 0 ]; then shift; fi
  case "${command}" in
    print) cmd_print ;;
    install) cmd_install "$@" ;;
    uninstall) cmd_uninstall ;;
    status) cmd_status ;;
    -h|--help|help) usage ;;
    *) usage ;;
  esac
}

main "$@"
