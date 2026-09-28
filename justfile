# List available targets
default:
    @just --list

# Run the wrapper integration tests (NixOS VMs; Linux with KVM)
test:
    cd test && nix flake check -L

# Build a fresh template against this checkout and a tiny local plugin
test-template:
    bash test/template.sh

# Re-record the README's demo GIF (needs network)
demo:
    rm -rf doc/frames
    nix run nixpkgs#vhs -- doc/demo.tape
    nix shell nixpkgs#ffmpeg -c ffmpeg -v error -y \
        -framerate 50 -i doc/frames/frame-text-%05d.png \
        -framerate 50 -i doc/frames/frame-cursor-%05d.png \
        -filter_complex "color=c=0x171717:s=1100x300:r=50[bg];[bg][0]overlay=30:30:shortest=1[t];[t][1]overlay=30:30,fps=20,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none" \
        doc/demo.gif
    rm -rf doc/frames
