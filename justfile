# List available targets
default:
    @just --list

# Run the wrapper integration tests (NixOS VMs; Linux with KVM)
test:
    cd test && nix flake check -L

# Build a fresh template against this checkout and a tiny local plugin
test-template:
    bash test/template.sh

# Build the website into result-site
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
        -filter_complex "color=c=0x171717:s=1400x460:r=50[bg];[bg][0]overlay=30:30:shortest=1[t];[t][1]overlay=30:30,fps=20,split[a][b];[a]palettegen=max_colors=32[p];[b]paletteuse=dither=none" \
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
# odu (github.com/juspay/odu) discovers the one recipe tagged [metadata("ci")],
# expands its dependency graph, and runs every (recipe × platform) as a node on
# a lane host, one commit status each. These recipes mirror
# .github/workflows/ci.yml, so a change is checked without waiting on the
# GitHub queue — the workflow stays what pushes the content-addressed bundles
# and the ca-index branch, because ATTIC_TOKEN lives there.
#
# A lane host has nix, git and bash but no python3 (the workflow's scripts use
# its runner's own), so those recipes take python3 from nixpkgs.
#
# Dependency edges order work rather than express requirements: the VM checks
# start once the picker build has warmed the store for them, instead of racing
# it for CPU and store locks. A `[linux]` recipe is pruned from a darwin lane
# (and from odu's status list there): the VM checks fix x86_64-linux, and a
# darwin lane has no KVM, so both belong to the Linux lane.

# The pipeline: odu expands these leaves and runs each with `just --no-deps`.
[linux]
[macos]
[parallel]
[metadata("ci")]
ci: flake picker template scripts website vm

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

# The distribution template, built against this checkout.
[linux]
[macos]
template: flake
    bash test/template.sh

# The workflow's own scripts, and their unit tests. `test-update-flake.py`
# drives `update-sources.sh`, which reads its pins with jq, so that node gets
# jq from nixpkgs too.
[linux]
[macos]
scripts:
    nix shell --accept-flake-config nixpkgs#python3 nixpkgs#jq -c python3 .github/scripts/test-update-flake.py
    nix shell --accept-flake-config nixpkgs#python3 -c python3 .github/scripts/test-ca-index.py
    nix shell --accept-flake-config nixpkgs#python3 -c python3 .github/scripts/check-cache-config.py

# The site build, as the workflow runs it for a doc change.
[linux]
website:
    nix build ./doc --no-link -L

# The wrapper checks, VMs included.
[linux]
vm: picker
    cd test && nix flake check -L
