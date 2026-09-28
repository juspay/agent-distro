# Only local terminal sessions need the shared server. Leave CLI tools and
# explicit remote/no-daemon sessions alone, including flags before commands.
# Unknown commands default to a session (and pinning). The CLI contract check
# compares these public commands and value flags with the pinned Codex help.
terminal_session() {
  local argument value=false command=false
  [[ -t 0 && -t 1 ]] || return 1
  for argument in "$@"; do
    if "$value"; then
      value=false
      continue
    fi
    case "$argument" in
      --) break ;;
      --no-daemon|--remote|--remote=*|--help|-h|--version|-V) return 1 ;;
      --config|-c|--enable|--disable|--model|-m|--profile|-p|--sandbox|-s|--ask-for-approval|-a|--cd|-C|--add-dir|--image|-i|--local-provider|--remote-auth-token-env)
        value=true ;;
      -*) ;;
      *)
        if ! "$command"; then
          command=true
          case "$argument" in
            exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|execpolicy|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|cloud-tasks|responses-api-proxy|stdio-to-uds|exec-server|features|tcp-tunnel|help)
              return 1 ;;
          esac
        fi ;;
    esac
  done
}

daemon_error() {
  printf 'agent-distro: %s; use --no-daemon to start a session without the background server.\n' "$1" >&2
  exit 1
}

managed_package() {
  local managed
  managed=$(jq -er '.managedCodexPath | select(type == "string")' <<< "$1") ||
    daemon_error 'cannot read the background server package path from Codex'
  # Codex returns the lexical current path, not its resolved executable. Check
  # its two supported layouts before deriving the sibling latest marker.
  case "$managed" in
    /*/packages/app-server-daemon/current/bin/codex|/*/packages/standalone/current/bin/codex|/*/packages/standalone/current/codex)
      printf '%s\n' "${managed%/current/*}" ;;
    *) daemon_error "cannot inspect the background server pin: unexpected package path $managed" ;;
  esac
}

# Codex rust-v0.158.0: codex-rs/app-server-daemon/src/managed_install.rs
# (package_root), with PID constants in src/lib.rs. The binary does not expose
# these names; the CLI contract check requires source review on version updates.
check_legacy_state() {
  local root="${CODEX_HOME:-$HOME/.codex}" name path
  [[ "$root" = /* ]] || root="$PWD/$root"
  local -a legacy_artifacts=(app-server.pid app-server.stderr.log app-server-updater.pid app-server-updater.stderr.log)
  local -a found=()
  # Both complete-package and older standalone layouts are supported by Codex.
  [[ ! -f "$root/packages/standalone/current/bin/codex" &&
     ! -f "$root/packages/standalone/current/codex" ]] || return 0
  for name in "${legacy_artifacts[@]}"; do
    path="$root/app-server-daemon/$name"
    if [[ -e "$path" || -L "$path" ]]; then
      found+=("$path")
    fi
  done
  [[ ${#found[@]} -gt 0 ]] || return 0
  printf "agent-distro: files left over from an older Codex's background server select a missing standalone installation:\n" >&2
  printf '  %s\n' "${found[@]}" >&2
  printf 'To remove exactly these files, run:\nrm --' >&2
  for path in "${found[@]}"; do
    printf ' %q' "$path" >&2
  done
  printf '\n' >&2
  daemon_error 'startup stopped without changing these files'
}

if terminal_session "$@"; then
  check_legacy_state
  # start is idempotent; its JSON describes the installed and running package.
  daemon=$("$codex" app-server daemon start) ||
    daemon_error 'cannot install or start the pinned Codex background server (Codex startup failed)'
  jq -e 'type == "object" and has("backend")' <<< "$daemon" >/dev/null ||
    daemon_error 'cannot read the background server startup response from Codex'
  jq -e '.backend != null' <<< "$daemon" >/dev/null ||
    daemon_error 'cannot pin an existing server that Codex does not manage; leaving it running unchanged'
  package=$(managed_package "$daemon") || exit 1
  if [[ -e "$package/auto-update-version" ]] ||
      ! jq -e --arg version "$codex_version" \
        '.managedCodexVersion == $version and .appServerVersion == $version' <<< "$daemon" >/dev/null; then
    "$codex" app-server daemon update --from-cli --yes >/dev/null ||
      daemon_error "cannot pin the background server to Codex $codex_version (package replacement failed)"
  fi
  # Fail closed if a concurrent installation changed the selected server.
  daemon=$("$codex" app-server daemon version) ||
    daemon_error 'cannot verify the pinned background server (Codex version query failed)'
  package=$(managed_package "$daemon") || exit 1
  [[ ! -e "$package/auto-update-version" ]] ||
    daemon_error 'cannot verify the background server pin: its automatic-update marker is still present'
  jq -e --arg version "$codex_version" \
    '.status == "running" and .managedCodexVersion == $version and .appServerVersion == $version' <<< "$daemon" >/dev/null ||
    daemon_error "cannot verify the background server pin: the running and installed versions must both be $codex_version"
fi
