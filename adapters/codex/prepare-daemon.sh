# Only local terminal sessions need the shared server. Leave CLI tools and
# explicit remote/no-daemon sessions alone, including flags before commands.
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

if terminal_session "$@"; then
  # start is idempotent; its JSON describes the installed and running package.
  daemon=$("$codex" app-server daemon start)
  managed=$(jq -er '.managedCodexPath' <<< "$daemon")
  package=${managed%/current/*}
  if [[ -e "$package/auto-update-version" ]] ||
      ! jq -e --arg version "$codex_version" \
        '.managedCodexVersion == $version and .appServerVersion == $version' <<< "$daemon" >/dev/null; then
    "$codex" app-server daemon update --from-cli --yes >/dev/null
  fi
  # Fail closed if a concurrent installation changed the selected server.
  daemon=$("$codex" app-server daemon version)
  managed=$(jq -er '.managedCodexPath' <<< "$daemon")
  package=${managed%/current/*}
  [[ ! -e "$package/auto-update-version" ]]
  jq -e --arg version "$codex_version" \
    '.status == "running" and .managedCodexVersion == $version and .appServerVersion == $version' <<< "$daemon" >/dev/null
fi
