# Default to standalone only with no positional argument or one existing directory.
terminal_session() {
  local argument value=false positional=false directory="" count=0
  for argument in "$@"; do
    if "$value"; then
      value=false
      continue
    fi
    if ! "$positional"; then
      case "$argument" in
        --) positional=true; continue ;;
        --standalone|--standalone=*|--server|--server=*|--help|-h|--version|-v|--completions|--completions=*) return 1 ;;
        --session|-s|--prompt|--log-level) value=true; continue ;;
        -*) continue ;;
      esac
    fi
    count=$((count + 1))
    directory=$argument
    if [ "$count" -gt 1 ]; then
      return 1
    fi
  done
  ! "$value" && { [ "$count" -eq 0 ] || [ -d "$directory" ]; }
}

if terminal_session "$@"; then
  set -- --standalone "$@"
fi
