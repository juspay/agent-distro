# Shell fragment shared by OMP, OpenCode and Pi: prompt for the gateway's key
# when it is not set. The gateway is the profile's in effect, so it is read at
# launch from what src/plugin/launch.ts prints (`profile_gateway_*`), never
# baked in here; the key variable's name is checked there to be a shell name.
{ gum }:
''
  if [ -z "''${!profile_gateway_key_env:-}" ]; then
    cat >&2 <<MSG

  $profile_gateway_key_env is not set.

  Create an API key at: $profile_gateway_url/dashboard
  $profile_gateway_key_hint

  Tip: export $profile_gateway_key_env=... to skip this prompt next time.

  MSG
    if [ ! -t 0 ]; then
      echo "Error: cannot prompt for $profile_gateway_key_env (stdin is not a terminal)." >&2
      exit 1
    fi
    profile_gateway_key=$(${gum}/bin/gum input --password --prompt "$profile_gateway_key_env: ") || {
      echo "Error: failed to read $profile_gateway_key_env." >&2
      exit 1
    }
    if [ -z "$profile_gateway_key" ]; then
      echo "Error: no API key provided." >&2
      exit 1
    fi
    export "$profile_gateway_key_env=$profile_gateway_key"
  fi
''
