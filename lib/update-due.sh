# Keep the UTC boundary calculation independent of launchd, the clock, and file I/O.
update_due() {
  local now=$1 stamp=$2 period=$3 offset=$4
  # Latest instant of the form offset + k*period not after now. Bash truncates
  # toward zero, which is a floor here because both operands are positive.
  local boundary=$(( (now - offset) / period * period + offset ))
  [ -z "$stamp" ] || [ "$stamp" -lt "$boundary" ]
}
