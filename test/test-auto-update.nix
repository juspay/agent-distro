{ pkgs, agent-distro, home-manager }:
let
  # The builder and its runtime closure are already in the offline VM's store.
  fixture = pkgs.writeTextDir "flake.nix" ''
    {
      outputs = { self }: {
        packages.x86_64-linux.vanilla = derivation {
          name = "updated-agents";
          system = "x86_64-linux";
          # Restore dependency context lost when the flake was written as text.
          dependencies = builtins.appendContext "" {
            "${pkgs.bash}" = { path = true; };
            "${pkgs.coreutils}" = { path = true; };
          };
          builder = "${pkgs.bash}/bin/bash";
          args = [ "-c" ${builtins.toJSON ''
            ${pkgs.coreutils}/bin/mkdir -p "$out/bin"
            for name in omp codex claude; do
              printf '#!${pkgs.bash}/bin/bash\necho updated-%s "$@"\n' "$name" > "$out/bin/$name"
              ${pkgs.coreutils}/bin/chmod +x "$out/bin/$name"
            done
          ''} ];
        };
      };
    }
  '';
  broken = pkgs.writeTextDir "flake.nix" ''
    {
      outputs = { self }: {
        packages.x86_64-linux.vanilla = derivation {
          name = "broken-agents";
          system = "x86_64-linux";
          # Restore dependency context lost when the flake was written as text.
          dependencies = builtins.appendContext "" {
            "${pkgs.bash}" = { path = true; };
            "${pkgs.coreutils}" = { path = true; };
          };
          builder = "${pkgs.bash}/bin/bash";
          args = [ "-c" "exit 1" ];
        };
      };
    }
  '';
in
{
  name = "auto-update";
  nodes.machine = { ... }: {
    imports = [ home-manager.nixosModules.home-manager ];
    users.users.testuser = { isNormalUser = true; uid = 1000; linger = true; };
    system.stateVersion = "24.05";
    environment.systemPackages = [ (pkgs.writeShellScriptBin "omp" "exit 99") ];
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      substituters = pkgs.lib.mkForce [ ];
    };
    virtualisation.additionalPaths = [ fixture broken pkgs.bash pkgs.coreutils ];
    home-manager.users.testuser = {
      imports = [ agent-distro.homeManagerModules.default ];
      home.stateVersion = "24.05";
      services.agent-distro = {
        enable = true;
        flake = "path:/home/testuser/update-flake";
        # Avoid a timer firing before the fallback assertions.
        frequency = "2099-01-01";
      };
    };
  };
  testScript = ''
    import shlex
    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("home-manager-testuser.service")
    machine.wait_for_unit("user@1000.service")
    activation = machine.succeed("journalctl -u home-manager-testuser.service --no-pager")
    assert "warning: agent-distro PATH collision for omp: /run/current-system/sw/bin/omp" in activation, activation
    assert "PATH collision for codex" not in activation, activation
    assert "PATH collision for claude" not in activation, activation

    def user(command):
        return "su - testuser -c " + shlex.quote(command)

    def systemctl(command):
        return user("XDG_RUNTIME_DIR=/run/user/1000 systemctl --user " + command)

    state = "/home/testuser/.local/state/agent-distro/current"
    machine.succeed("test ! -e " + state)
    for name in ["omp", "codex", "claude"]:
        output = machine.succeed(user(name + " --version"))
        assert "updated-" not in output, output
    machine.succeed(systemctl("is-enabled agent-distro-update.timer"))
    machine.succeed(systemctl("cat agent-distro-update.timer"))
    machine.succeed(user("cp -r ${fixture} ~/update-flake; chmod -R u+w ~/update-flake"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    first = machine.succeed("readlink -f " + state).strip()
    assert first.startswith("/nix/store/"), first
    for name in ["omp", "codex", "claude"]:
        output = machine.succeed(user(name + " --version 'two words'"))
        assert output.strip() == "updated-" + name + " --version two words", output
    machine.succeed(user("cp ${broken}/flake.nix ~/update-flake/flake.nix"))
    machine.fail(systemctl("start agent-distro-update.service"))
    machine.succeed(systemctl("is-failed agent-distro-update.service"))
    assert machine.succeed("readlink -f " + state).strip() == first
    for name in ["omp", "codex", "claude"]:
        assert "updated-" + name in machine.succeed(user(name + " --version"))
  '';
}
