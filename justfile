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
        -filter_complex "color=c=0x171717:s=1400x460:r=50[bg];[bg][0]overlay=30:30:shortest=1[t];[t][1]overlay=30:30,fps=20,split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none" \
        doc/demo.gif
    nix shell nixpkgs#ffmpeg -c ffmpeg -v error -y \
        -ss 7 -i doc/demo.gif -frames:v 1 doc/demo.png
    nix shell nixpkgs#ffmpeg -c ffmpeg -v error -y \
        -i doc/demo.png \
        -vf "crop=1280:330:30:35,scale=1140:-2,pad=1200:630:(ow-iw)/2:(oh-ih)/2:color=0x171717" \
        doc/og.png
    rm -rf doc/frames
