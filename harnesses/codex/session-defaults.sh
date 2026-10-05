# Local sessions run without the experimental background server by default.
# Leave explicit remote/no-daemon sessions and CLI tools alone. The CLI
# contract check compares this classifier with the pinned Codex help.
terminal_session() {
  local argument value=false command=false
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
            exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|execpolicy|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|cloud-tasks|responses-api-proxy|stdio-to-uds|exec-server|features|tcp-tunnel|help|agents)
              return 1 ;;
          esac
        fi ;;
    esac
  done
}

# Reasoning blocks are hidden unless the user chose otherwise, in config.toml
# (top level or the active profile) or with their own -c/--config. The launcher
# defines `codex_reasoning_default` from the helper before sourcing this file.
if terminal_session "$@"; then
  set -- --no-daemon "$@"
  if reasoning=$(codex_reasoning_default "$@") && [ -n "$reasoning" ]; then
    set -- -c "$reasoning" "$@"
  fi
fi
