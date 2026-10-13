# List available targets
default:
    @just --list

# Run the wrapper integration tests (NixOS VMs; Linux with KVM).
[linux]
[metadata("odu:shard=8")]
test:
    #!/usr/bin/env bash
    # Sharded by odu: each lane builds its own slice of the checks; see the CI
    # section below.
    set -euo pipefail
    cd test
    # Cap how many VMs run at once — a `nix flake check` left to itself boots
    # one per check and each wants gigabytes. A shard gets a lane host to
    # itself, so the cap is per shard. Raise VM_JOBS on a bigger box.
    max_jobs={{ env('VM_JOBS', '4') }}
    index=${ODU_SHARD_INDEX-}
    total=${ODU_SHARD_TOTAL-}
    if [ -z "$index" ] && [ -z "$total" ]; then
      exec nix flake check -L --max-jobs "$max_jobs"
    fi
    if ! { [[ "$index" =~ ^(0|[1-9][0-9]*)$ ]] && [[ "$total" =~ ^[1-9][0-9]*$ ]] && [ "$index" -lt "$total" ]; }; then
      echo "test: ODU_SHARD_INDEX='$index' ODU_SHARD_TOTAL='$total' is not a shard pair (index must be 0…total-1)" >&2
      exit 2
    fi
    # The check list is read from the flake, so a new check needs no edit here;
    # `--apply` keeps the selection to pure builtins, since a lane host has no
    # jq. The position is the index in `builtins.attrNames`, so the shards
    # partition the list however it is ordered.
    select=$(cat <<EOF
    checks: let
      index = $index;
      total = $total;
      names = builtins.attrNames checks;
    in builtins.concatStringsSep " " (map (i: ".#checks.x86_64-linux." + builtins.elemAt names i)
      (builtins.filter (i: i - (i / total) * total == index)
        (builtins.genList (i: i) (builtins.length names))))
    EOF
    )
    picked=$(nix eval --raw .#checks.x86_64-linux --apply "$select")
    if [ -z "$picked" ]; then
      echo "test: shard $index/$total of the checks is empty"
      exit 0
    fi
    echo "test: shard $index/$total: $picked"
    exec nix build -L --no-link --max-jobs "$max_jobs" $picked

# Build a fresh template against this checkout and a tiny local plugin
[linux]
[macos]
test-template:
    bash test/template.sh

# Build the website into result-site
[linux]
site:
    nix build ./doc -o result-site

# Build the website and serve it at http://localhost:8080
site-serve:
    nix run ./doc

# Re-record the demo GIF and the website's still images (needs network)
demo:
    rm -rf doc/frames
    nix run nixpkgs#vhs -- doc/demo.tape
    nix shell nixpkgs#ffmpeg -c ffmpeg -v error -y \
        -framerate 50 -i doc/frames/frame-text-%05d.png \
        -framerate 50 -i doc/frames/frame-cursor-%05d.png \
        -filter_complex "color=c=0x171717:s=1400x460:r=50[bg];[bg][0]overlay=30:30:shortest=1[t];[t][1]overlay=30:30,fps=20,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none" \
        doc/demo.gif
    nix shell nixpkgs#ffmpeg -c ffmpeg -v error -y \
        -ss 7 -i doc/demo.gif -frames:v 1 doc/demo.png
    nix shell nixpkgs#ffmpeg -c ffmpeg -v error -y \
        -i doc/demo.png \
        -vf "crop=1280:330:30:35,scale=1140:-2,pad=1200:630:(ow-iw)/2:(oh-ih)/2:color=0x171717" \
        doc/og.png
    rm -rf doc/frames

# ── CI, as odu runs it ──────────────────────────────────────────────────────
#
# odu (github.com/juspay/odu) IS this repository's CI. It discovers the one
# recipe tagged [metadata("ci")], expands its dependency graph, and runs every
# (recipe × platform) as a node on a lane host, posting one
# `<recipe>@<platform>` commit status each — the statuses `just protect` keeps
# in main's ruleset. The nodes are the recipes above, so every check keeps one
# definition: this section is what *runs* them, not a second spelling of any of
# them.
#
# Run it with `nix run --accept-flake-config github:juspay/odu -- run`; hosts
# come from ~/.config/odu/hosts.json (or $ODU_HOSTS).
#
# A lane host has nix, git and bash but no python3 (the cache workflow's
# scripts use its runner's own), so `scripts` takes python3 from nixpkgs.
# `test` and `site` are Linux-only, as their VMs and their KVM require.
#
# Dependency edges order work rather than express requirements: `picker` waits
# for the wide flake build instead of racing it for CPU and store locks.
#
# Sharding: `test` carries [metadata("odu:shard=8")], so odu runs its VM checks
# on up to 8 lanes at once, giving each ODU_SHARD_INDEX (0-based) and
# ODU_SHARD_TOTAL (the lanes it got, at most 8 — a ceiling, since the
# x86_64-linux pool has 9 hosts and the others have work to do). The recipe
# picks its own slice of ./test's checks. With neither variable set it runs
# them all in one `nix flake check`, which is the local spelling.

# The pipeline: odu expands these leaves and runs each with `just --no-deps`.
[linux]
[macos]
[parallel]
[metadata("ci")]
ci: flake picker test test-template scripts site

# Every flake output, so a new one cannot silently escape CI.
[linux]
[macos]
flake:
    nix build github:srid/devour-flake -L --no-link --override-input flake .

# The picker depends on every launcher, so this builds them all.
[linux]
[macos]
picker: flake
    nix build --print-build-logs .#default

# The workflow's own scripts, and their unit tests.
[linux]
[macos]
scripts:
    nix shell --accept-flake-config nixpkgs#python3 nixpkgs#jq -c python3 .github/scripts/test-update-flake.py
    nix shell --accept-flake-config nixpkgs#python3 -c python3 .github/scripts/test-ca-index.py
    nix shell --accept-flake-config nixpkgs#python3 -c python3 .github/scripts/check-cache-config.py

# Require what CI posts on main: odu's contexts plus the cache workflow's.
protect *args:
    #!/usr/bin/env bash
    # Coordinator-side, and the one recipe here that writes to GitHub:
    # unreachable from `ci`, so odu never schedules it. It is also the reason
    # the cache workflow's contexts live beside it — `odu protect` sets the
    # ruleset's list to exactly the contexts odu posts, replacing it wholesale,
    # so a context appended out of band would survive only until the next
    # protect run. Appending inside `protect` is what keeps them together.
    #
    # The cache contexts are DERIVED from .github/workflows/cache.yml by
    # check-cache-config.py (never spelled a second time), so renaming that
    # workflow's job or matrix reaches the ruleset through the next protect run.
    #
    # `--dry-run` prints the whole set — odu's contexts, then the cache ones —
    # and writes nothing.
    set -euo pipefail
    # `{{ args }}` and not `"$@"`: just interpolates a recipe's parameters into
    # its body and passes none of them positionally, so a bare `$@` here is
    # always empty — the dry run below would then look like a real one. They are
    # word-split, so an argument holding a space needs no quoting to survive
    # (none of this recipe's flags takes one).
    odu=(nix run --accept-flake-config github:juspay/odu -- protect \
      --platform x86_64-linux --platform aarch64-darwin {{ args }})
    contexts=$(nix shell --accept-flake-config nixpkgs#python3 \
      -c python3 .github/scripts/check-cache-config.py --contexts)
    # No guard on that: the script IS the check for it — it refuses a workflow
    # it cannot read the contexts out of — and `set -e` carries its failure out
    # of this substitution. What it prints is one context per line, never empty.
    mapfile -t cache_contexts <<<"$contexts"
    case " {{ args }} " in
      *" --dry-run "*)
        # odu prints the contexts it would require; the cache ones follow, so
        # the two lines together are the whole required set. Nothing is
        # written, by odu or by the ruleset write below.
        "${odu[@]}"
        printf '%s\n' "${cache_contexts[@]}"
        exit 0
        ;;
    esac
    # odu owns the list; it goes first, and whatever it dropped and we require
    # is re-added below.
    "${odu[@]}"
    slug=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
    # WHICH ruleset odu wrote is not this recipe's to know: it picks the one
    # whose required checks already contain a context odu posts
    # (`<recipe>@x86_64-linux`, which only odu writes). Exactly one ruleset must
    # match, since the contexts required of a branch are the union of its
    # rulesets': appending to a second one would leave contexts no run reports.
    owners=()
    while read -r id; do
      [ -n "$id" ] || continue
      posted=$(gh api "repos/$slug/rulesets/$id" --jq '
        [.rules[] | select(.type == "required_status_checks")
         | .parameters.required_status_checks[]? | .context | strings
         | select(endswith("@x86_64-linux"))] | length')
      [ "$posted" = "0" ] || owners+=("$id")
    done < <(gh api --paginate "repos/$slug/rulesets" --jq '.[].id')
    if [ "${#owners[@]}" -ne 1 ]; then
      found=none
      [ "${#owners[@]}" -eq 0 ] || found="${owners[*]}"
      echo "protect: expected one ruleset requiring an odu context; found $found" >&2
      exit 1
    fi
    ruleset=${owners[0]}
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    gh api "repos/$slug/rulesets/$ruleset" >"$work/ruleset.json"
    # A ruleset PUT replaces the whole object, so this is the same
    # read-modify-write odu does: every field the read returned goes back out
    # and only the checks rule's contexts change. Ours are deduplicated against
    # odu's and carry the Actions integration id, because the cache workflow
    # posts them from Actions — odu posts its own contexts and carries none.
    nix shell --accept-flake-config nixpkgs#jq -c jq --args -c '
      {
        name, target, enforcement, conditions, bypass_actors,
        rules: (
          [.rules[] | select(.type != "required_status_checks")]
          + [.rules[] | select(.type == "required_status_checks")
             | .parameters.required_status_checks = (
                 ((.parameters.required_status_checks // [])
                  + [$ARGS.positional[] | select(. != "")
                     | {context: ., integration_id: 15368}])
                 | unique_by(.context))]
        )
      }' "${cache_contexts[@]}" <"$work/ruleset.json" >"$work/body.json"
    gh api --method PUT "repos/$slug/rulesets/$ruleset" --input "$work/body.json" >/dev/null
    # A 200 is not proof: read the ruleset back and check every context landed.
    got=$(gh api "repos/$slug/rulesets/$ruleset" \
      --jq '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context')
    missing=()
    for context in "${cache_contexts[@]}"; do
      grep -qxF "$context" <<<"$got" || missing+=("$context")
    done
    if [ "${#missing[@]}" -gt 0 ]; then
      echo "protect: $slug still does not require: ${missing[*]}" >&2
      exit 1
    fi
    echo "protect: $slug ruleset #$ruleset requires odu's contexts and ${#cache_contexts[@]} cache contexts"
