# Shared menu behaviour, spliced into both the profile menu and the harness
# picker so the two cannot drift apart. Each menu differs only in its entries
# and its wording; the rules — an environment override wins outright, a missing
# terminal is an error rather than a guess, quitting is not a failure — are the
# same, and users meet them twice in a row.

# ai_choose VARIABLE DEFAULT HEADER INVALID NOTTY ENTRY...
# Each ENTRY is "<label><tab><value>", gum's own label/value form: the menu
# shows the label and `choice` receives the value the caller acts on.
ai_choose() {
  local variable=$1 default=$2 header=$3 invalid=$4 notty=$5
  shift 5
  local entry

  # The override is checked for existence, not truth, so an empty value is a
  # mistake to report rather than a silent fall back to the menu.
  if [ "${!variable+x}" = x ]; then
    for entry in "$@"; do
      if [ "${entry#*$'\t'}" = "${!variable}" ]; then
        choice=${!variable}
        return
      fi
    done
    printf '%s\n' "$invalid" >&2
    exit 1
  fi

  if [ ! -t 0 ]; then
    printf '%s\n' "$notty" >&2
    exit 1
  fi

  # gum matches --selected against the label, never the value.
  local selected=()
  for entry in "$@"; do
    if [ "${entry#*$'\t'}" = "$default" ]; then
      selected=(--selected "${entry%$'\t'*}")
    fi
  done

  # gum leaves with 130 on ctrl-c and 1 on Escape, printing nothing either way.
  # Declining the menu is how you quit it, so it exits 0 like the numbered
  # prompt's `q` did.
  choice=$(gum choose --limit 1 --label-delimiter $'\t' \
    --header "$header" "${selected[@]}" "$@") || exit 0
  if [ -z "$choice" ]; then
    exit 0
  fi
}
