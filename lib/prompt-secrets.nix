# Shell fragment shared by the harnesses without a login of their own: prompt
# for each `secret` variable the profile's `env` declares and the environment
# does not set. The profile is the one in effect, so it is read at launch from
# what src/plugin/launch.ts prints (`profile_env_secrets`, one `NAME=hint` per
# secret), never baked in here; every name is checked there to be a shell name.
#
# The value goes into the launcher's own environment and nowhere else: it is
# never written to a file, and a non-interactive launch fails rather than
# guessing, since a harness asked to run non-interactively must not block.
{ gum }:
''
  # Nothing to prompt with, or nothing typed: stop before the harness starts.
  fail() {
    echo "agent-distro: error: $1" >&2
    exit 1
  }
  for entry in "''${profile_env_secrets[@]}"; do
    secret_name="''${entry%%=*}"
    secret_hint="''${entry#*=}"
    if [ -n "''${!secret_name:-}" ]; then continue; fi
    {
      echo
      echo "agent-distro: warning: $secret_name is not set."
      if [ -n "$secret_hint" ]; then echo; echo "  $secret_hint"; fi
      echo
      echo "  Tip: export $secret_name=... to skip this prompt next time."
      echo
    } >&2
    if [ ! -t 0 ]; then fail "cannot prompt for $secret_name (stdin is not a terminal)."; fi
    secret=$(${gum}/bin/gum input --password --prompt "$secret_name: ") || fail "failed to read $secret_name."
    if [ -z "$secret" ]; then fail "no value provided for $secret_name."; fi
    export "$secret_name=$secret"
  done
''
