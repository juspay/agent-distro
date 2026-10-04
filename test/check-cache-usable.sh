source "$1"

check() {
  local label=$1 expected=$2 actual
  shift 2
  if cache_usable "$@"; then actual=usable; else actual=unusable; fi
  if [ "$actual" != "$expected" ]; then
    printf '%s: expected %s, got %s\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
}

url=https://cache.example/oss
key='oss:abc='
check 'trusted needs no system config' usable 1 '' '' $url "$key"
check 'untrusted, nothing configured' unusable 0 '' '' $url "$key"
check 'untrusted, listed with key' usable 0 "https://cache.nixos.org $url" "cache.nixos.org-1:x $key" $url "$key"
check 'untrusted, url without key' unusable 0 "$url" 'cache.nixos.org-1:x' $url "$key"
check 'untrusted, key without url' unusable 0 'https://cache.nixos.org' "$key" $url "$key"
check 'system url has trailing slash' usable 0 "$url/" "$key" $url "$key"
check 'module url has trailing slash' usable 0 "$url" "$key" "$url/" "$key"
check 'prefix of another url is not a match' unusable 0 "$url/extra" "$key" $url "$key"
check 'longer url is not a match' unusable 0 "$url" "$key" "$url-other" "$key"
