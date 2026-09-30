# Shell fragment shared by OMP and OpenCode.
{ gum, gateway }:
''
  if [ -z "''${${gateway.keyEnv}:-}" ]; then
    cat >&2 <<'MSG'

  ${gateway.keyEnv} is not set.

  Create an API key at: ${gateway.url}/dashboard
  ${gateway.keyHint}

  Tip: export ${gateway.keyEnv}=... to skip this prompt next time.

  MSG
    if [ ! -t 0 ]; then
      echo "Error: cannot prompt for ${gateway.keyEnv} (stdin is not a terminal)." >&2
      exit 1
    fi
    ${gateway.keyEnv}=$(${gum}/bin/gum input --password --prompt "${gateway.keyEnv}: ") || {
      echo "Error: failed to read ${gateway.keyEnv}." >&2
      exit 1
    }
    if [ -z "''${${gateway.keyEnv}:-}" ]; then
      echo "Error: no API key provided." >&2
      exit 1
    fi
    export ${gateway.keyEnv}
  fi
''
