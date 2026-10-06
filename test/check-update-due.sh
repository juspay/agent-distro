# Synthetic epoch seconds keep boundary tests independent of the host clock and zone.
source "$1"
base=$((20000 * 86400))
b1=$((base + 7200))   # 02:00 UTC
b2=$((base + 28800))  # 08:00 UTC
b3=$((base + 50400))  # 14:00 UTC

check() {
  local label=$1 now=$2 stamp=$3 expected=$4 actual
  if update_due "$now" "$stamp" 21600 7200; then actual=due; else actual=wait; fi
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

check 'no stamp' "$((b3 + 3600))" '' due
check 'stamp before latest boundary' "$((b3 + 3600))" "$((b3 - 1))" due
check 'stamp in the current cycle' "$((b3 + 3600))" "$((b3 + 1))" wait
check 'before first boundary, updated at the previous last boundary' "$((b1 - 3600))" "$((b1 - 21600))" wait
check 'exactly at a boundary, previous cycle stamp' "$b2" "$((b2 - 1))" due
check 'exactly at a boundary, current cycle stamp' "$b2" "$b2" wait
check 'slept across several periods' "$((b3 + 3600))" "$((b3 - 3 * 21600))" due
