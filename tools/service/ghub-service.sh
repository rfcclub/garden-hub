#!/bin/bash
# ghub-service - install, remove and inspect the Garden Hub dashboard launchd
# user agent on macOS.
#
#   ghub-service.sh print      write the filled-in plist to stdout (default)
#   ghub-service.sh install    install and load the agent [--force]
#   ghub-service.sh uninstall  unload and remove the agent
#   ghub-service.sh status     show whether the agent is loaded and what the
#                              dashboard's /api/events answers
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

# The port the agent was actually installed with. `status` asks the running
# dashboard, not the ambient environment: after `GHUB_DASHBOARD_PORT=5000
# install`, a plain `status` still probed the default and reported no response.
installed_port() {
  local agent="$1" port=""
  if [ -f "${agent}" ]; then
    port="$(awk -F'[<>]' '
      /<key>GHUB_DASHBOARD_PORT<\/key>/ { want = 1; next }
      want && /<string>/ { print $3; exit }
    ' "${agent}" 2>/dev/null || true)"
  fi
  case "${port}" in
    ''|*[!0-9]*) resolve_port ;;
    *) printf '%s\n' "${port}" ;;
  esac
}

log_dir() {
  require_home
  printf '%s\n' "${HOME}/Library/Logs/anima"
}

# Fill the template by literal replacement, not by sed or by parameter
# expansion: a checkout path may contain `&`, `|`, `\`, `<`, `>` or `@`, all of
# which sed or bash's `${x//a/b}` would reinterpret (bash 5.2 replaces `&` with
# the matched text, bash 3.2 keeps a backslash). The template is scanned once,
# so an inserted value is never substituted again, and XML escaping happens
# here too, character by character, so the same code runs under /bin/bash 3.2
# and under a newer shell. Values arrive through the environment, which awk
# does not process as escape sequences.
RENDER_AWK='
function xesc(text,   out, i, ch) {
  out = ""
  for (i = 1; i <= length(text); i++) {
    ch = substr(text, i, 1)
    if (ch == "&") out = out "&amp;"
    else if (ch == "<") out = out "&lt;"
    else if (ch == ">") out = out "&gt;"
    else out = out ch
  }
  return out
}
{
  rest = $0
  out = ""
  while (rest != "") {
    at = 0
    len = 0
    val = ""
    i = index(rest, "@NODE@")
    if (i > 0) { at = i; len = 6; val = node }
    i = index(rest, "@REPO@")
    if (i > 0 && (at == 0 || i < at)) { at = i; len = 6; val = repo }
    i = index(rest, "@PORT@")
    if (i > 0 && (at == 0 || i < at)) { at = i; len = 6; val = port }
    i = index(rest, "@LOG@")
    if (i > 0 && (at == 0 || i < at)) { at = i; len = 5; val = logpath }
    if (at == 0) {
      out = out rest
      rest = ""
    } else {
      out = out substr(rest, 1, at - 1) xesc(val)
      rest = substr(rest, at + len)
    }
  }
  print out
}
'

render() {
  require_home
  # `die` exits the subshell a command substitution creates, not the caller:
  # under `plist="$(render)"` the non-zero status was dropped and `install`
  # went on to write a plist with an empty port. Propagate each failure
  # explicitly so the caller's `set -e` sees it.
  local node port log
  node="$(resolve_node)" || return 1
  port="$(resolve_port)" || return 1
  log="$(log_dir)/garden-hub-dashboard.log" || return 1
  [ -f "${TEMPLATE}" ] || die "plist template not found: ${TEMPLATE}"

  # Every placeholder must be present, or the agent would launch without that
  # value; refuse instead of writing a half-filled plist.
  local placeholder
  for placeholder in @NODE@ @REPO@ @PORT@ @LOG@; do
    grep -qF -- "${placeholder}" "${TEMPLATE}" ||
      die "plist template is missing ${placeholder}: ${TEMPLATE}"
  done

  local plist
  plist="$(
    GHUB_SVC_NODE="${node}" \
      GHUB_SVC_REPO="${REPO}" \
      GHUB_SVC_PORT="${port}" \
      GHUB_SVC_LOG="${log}" \
      awk -v begin=1 '
        BEGIN {
          node = ENVIRON["GHUB_SVC_NODE"]
          repo = ENVIRON["GHUB_SVC_REPO"]
          port = ENVIRON["GHUB_SVC_PORT"]
          logpath = ENVIRON["GHUB_SVC_LOG"]
        }
        '"${RENDER_AWK}"'
      ' "${TEMPLATE}"
  )" || die "cannot render plist template: ${TEMPLATE}"

  case "${plist}" in
    *@NODE@*|*@REPO@*|*@PORT@*|*@LOG@*)
      die "plist template has an unsubstituted placeholder: ${TEMPLATE}" ;;
  esac

  printf '%s\n' "${plist}"
}

cmd_print() {
  render
}

cmd_install() {
  require_home
  local force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --force) force=1 ;;
      *) die "unknown install option: $1" ;;
    esac
    shift
  done

  check_dashboard

  local plist agent node
  # `render` already returns non-zero on a bad port or a missing node; say so
  # here rather than relying on `set -e` to notice a bare assignment.
  plist="$(render)" || die "cannot render plist; nothing written"
  agent="$(agent_path)"

  [ ! -L "${agent}" ] || die "${agent} is a symbolic link; refusing to install"
  if [ -e "${agent}" ] && [ ! -f "${agent}" ]; then
    die "${agent} is not a regular file; refusing to install"
  fi
  if [ -f "${agent}" ] && [ "${force}" -ne 1 ] &&
    [ "${plist}" != "$(cat "${agent}")" ]; then
    die "${agent} exists with different contents; re-run with --force to replace it"
  fi

  mkdir -p "$(agent_dir)" "$(log_dir)"
  node="$(resolve_node)"
  # The pre-check alone cannot prevent a link from being swapped in later.
  # Open without following the final path component, then write and chmod the
  # descriptor so neither operation can be redirected through a symlink.
  printf '%s\n' "${plist}" | "${node}" -e '
    const fs = require("node:fs");
    const flags = fs.constants;
    if (typeof flags.O_NOFOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable");
    const data = fs.readFileSync(0);
    const fd = fs.openSync(process.argv[1], flags.O_WRONLY | flags.O_CREAT | flags.O_TRUNC | flags.O_NOFOLLOW, 0o644);
    try { fs.writeFileSync(fd, data); fs.fchmodSync(fd, 0o644); }
    finally { fs.closeSync(fd); }
  ' "${agent}" || die "cannot safely write ${agent}"

  # Replace a previously loaded copy so the new one takes effect.
  launchctl bootout "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "${agent}" ||
    die "launchctl bootstrap failed for ${agent}"

  echo "installed ${agent}"
  echo "log: $(log_dir)/garden-hub-dashboard.log"
}

cmd_uninstall() {
  require_home
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
  port="$(installed_port "${agent}")"
  if command -v curl >/dev/null 2>&1; then
    local code
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 \
      "http://127.0.0.1:${port}/api/events" 2>/dev/null || true)"
    echo "http: GET http://127.0.0.1:${port}/api/events -> ${code:-no response}"
  else
    echo "http: curl not found; cannot probe http://127.0.0.1:${port}/api/events"
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
