# Decide whether nix will honour a binary cache, independent of nix, the
# daemon, and the host's config: callers pass in what they observed.

# Configured URLs may carry trailing slashes; compare without them.
cache_trim() {
  local word out=""
  local -a words
  read -ra words <<< "$1"
  for word in "${words[@]}"; do
    while [ "${word%/}" != "$word" ]; do word=${word%/}; done
    out+="$word "
  done
  printf '%s' "$out"
}

# cache_usable <trusted 0|1> <system substituters> <system public keys> <url> <key>
# A trusted user's own --option is honoured; anyone else needs the system
# config to list both the URL and its key.
cache_usable() {
  local trusted=$1 known url
  [ "$trusted" = 1 ] && return 0
  known=" $(cache_trim "$2")"
  url=$(cache_trim "$4")
  [[ $known == *" $url"* ]] && [[ " $3 " == *" $5 "* ]]
}
