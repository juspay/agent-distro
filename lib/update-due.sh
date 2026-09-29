# Keep the UTC boundary calculation independent of launchd, the clock, and file I/O.
update_due() {
  local now=$1 stamp=$2 hour=$3
  local boundary=$((now / 86400 * 86400 + hour * 3600))
  if [ "$now" -lt "$boundary" ]; then
    boundary=$((boundary - 86400))
  fi
  [ -z "$stamp" ] || [ "$stamp" -lt "$boundary" ]
}
