# Shell fragment shared by the harnesses without a login of their own: prompt
# for each `secret` variable the profile's `env` declares and the environment
# does not set. The profile is the one in effect, so it is read at launch from
# what src/plugin/launch.ts prints (`profile_env_names`, `profile_env_hints`),
# never baked in here; every name is checked there to be a shell name.
#
# The value goes into the launcher's own environment and nowhere else: it is
# never written to a file, and a non-interactive launch fails rather than
# guessing, since a harness asked to run non-interactively must not block.
{ gum }:
''
  secret_index=0
  while [ "$secret_index" -lt "''${#profile_env_names[@]}" ]; do
    secret_name="''${profile_env_names[$secret_index]}"
    secret_hint="''${profile_env_hints[$secret_index]}"
    secret_index=$((secret_index + 1))
    if [ -n "''${!secret_name:-}" ]; then continue; fi
    {
      echo
      echo "agent-distro: warning: $secret_name is not set."
      if [ -n "$secret_hint" ]; then echo; echo "  $secret_hint"; fi
      echo
      echo "  Tip: export $secret_name=... to skip this prompt next time."
      echo
    } >&2
    if [ ! -t 0 ]; then
      echo "agent-distro: error: cannot prompt for $secret_name (stdin is not a terminal)." >&2
      exit 1
    fi
    secret=$(${gum}/bin/gum input --password --prompt "$secret_name: ") || {
      echo "agent-distro: error: failed to read $secret_name." >&2
      exit 1
    }
    if [ -z "$secret" ]; then
      echo "agent-distro: error: no value provided for $secret_name." >&2
      exit 1
    fi
    export "$secret_name=$secret"
    unset secret
  done
''
