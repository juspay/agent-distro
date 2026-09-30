# Root-only flags leak into v2's subcommand parser. Default only the TUI;
# scripted callers supply --standalone on their own subcommand.
terminal_session() {
  local argument value=false command=false
  for argument in "$@"; do
    if "$value"; then
      value=false
      continue
    fi
    case "$argument" in
      --) break ;;
      --standalone|--standalone=*|--server|--server=*|--help|-h|--version|-v|--completions|--completions=*) return 1 ;;
      --session|-s|--prompt|--log-level) value=true ;;
      -*) ;;
      *)
        if ! "$command"; then
          command=true
          case "$argument" in
            upgrade|update|uninstall|acp|api|debug|auth|mcp|plugin|models|stats|mini|run|session|service|reload|pair|serve)
              return 1 ;;
          esac
        fi ;;
    esac
  done
}

if terminal_session "$@"; then
  set -- --standalone "$@"
fi
