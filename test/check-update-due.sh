# Synthetic epoch seconds keep boundary tests independent of the host clock and zone.
source "$1"
noon=$((20000 * 86400 + 12 * 3600))

check() {
  local label=$1 now=$2 stamp=$3 expected=$4 actual
  if update_due "$now" "$stamp" 12; then actual=due; else actual=wait; fi
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

check 'no stamp' "$((noon + 3600))" '' due
check 'stamp before latest noon' "$((noon + 3600))" "$((noon - 1))" due
check 'stamp after latest noon' "$((noon + 3600))" "$((noon + 1))" wait
check 'before noon, updated yesterday afternoon' "$((noon - 3600))" "$((noon - 86400 + 3600))" wait
check 'exactly noon, previous cycle stamp' "$noon" "$((noon - 1))" due
check 'exactly noon, current cycle stamp' "$noon" "$noon" wait
check 'slept across several days' "$((noon + 3600))" "$((noon - 3 * 86400))" due
