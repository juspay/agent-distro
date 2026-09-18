# List available targets
default:
    @just --list

# Run the wrapper integration tests (NixOS VMs; Linux with KVM)
test:
    cd test && nix flake check -L --override-input agent-distro ..

# Build a fresh template against this checkout and a tiny local plugin
test-template:
    bash test/template.sh
