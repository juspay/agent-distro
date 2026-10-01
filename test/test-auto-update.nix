{ pkgs, agent-distro, home-manager }:
let
  commands = agent-distro.packages.${pkgs.stdenv.hostPlatform.system}.vanilla.commands;
  homeConfig = {
    imports = [ agent-distro.homeManagerModules.default ];
    home = {
      username = "testuser";
      homeDirectory = "/home/testuser";
      stateVersion = "24.05";
    };
    xdg.stateHome = "/home/testuser/custom-state";
    services.agent-distro = {
      enable = true;
      flake = "path:/home/testuser/update-flake";
      # Avoid a timer firing before the fallback assertions.
      frequency = "2099-01-01";
    };
    systemd.user.services.agent-distro-update.Service.RestartSec = pkgs.lib.mkForce "1s";
  };
  switched = settings: (home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [ homeConfig { services.agent-distro = pkgs.lib.mapAttrs (_: pkgs.lib.mkForce) settings; } ];
  }).activationPackage;
  switchedProfile = switched { profile = "juspay"; };
  switchedFlake = switched { flake = "path:/home/testuser/other-flake"; };
  original = switched { };
  # Offline flake mechanics stay independent of the build outcome under test.
  fixtureFlake = name: script: pkgs.writeTextDir "flake.nix" ''
    {
      outputs = { self }: {
        packages.x86_64-linux.vanilla = derivation {
          name = "${name}";
          system = "x86_64-linux";
          # Restore dependency context lost when the flake was written as text.
          dependencies = builtins.appendContext "" {
            "${pkgs.bash}" = { path = true; };
            "${pkgs.coreutils}" = { path = true; };
          };
          builder = "${pkgs.bash}/bin/bash";
          args = [ "-c" ${builtins.toJSON script} ];
        };
      };
    }
  '';
  agentsScript = ''
    ${pkgs.coreutils}/bin/mkdir -p "$out/bin"
    for name in ${pkgs.lib.escapeShellArgs commands}; do
      printf '#!${pkgs.bash}/bin/bash\necho updated-%s "$@"\n' "$name" > "$out/bin/$name"
      ${pkgs.coreutils}/bin/chmod +x "$out/bin/$name"
    done
  '';
  fixture = fixtureFlake "updated-agents" agentsScript;
  # A renamed derivation is a distinct store path, enough to exercise old -> new.
  fixtureV2 = fixtureFlake "updated-agents-v2" agentsScript;
  broken = fixtureFlake "broken-agents" "exit 1";
in
{
  name = "auto-update";
  nodes.machine = { ... }: {
    imports = [ (import ./common.nix).baseNode home-manager.nixosModules.home-manager ];
    users.users.testuser.linger = true;
    environment.systemPackages = [ (pkgs.writeShellScriptBin "omp" "exit 99") ];
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      substituters = pkgs.lib.mkForce [ ];
    };
    # Alternate generations must be registered in the VM store for activation's GC roots.
    virtualisation.additionalPaths = [ fixture fixtureV2 broken pkgs.bash pkgs.coreutils switchedProfile switchedFlake original ];
    environment.loginShellInit = ''
      echo "Welcome: this greeting is not a PATH"
    '';
    home-manager.users.testuser = homeConfig;
  };
  testScript = ''
    import shlex
    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("home-manager-testuser.service")
    machine.wait_for_unit("user@1000.service")
    activation = machine.succeed("journalctl -u home-manager-testuser.service --no-pager")
    assert "warning: agent-distro PATH collision for omp: /run/current-system/sw/bin/omp; bare omp runs /home/testuser/.nix-profile/bin/omp" in activation, activation
    assert "PATH collision for codex" not in activation, activation
    assert "PATH collision for claude" not in activation, activation

    def user(command):
        return "su - testuser -c " + shlex.quote(command)

    def systemctl(command):
        return user("XDG_RUNTIME_DIR=/run/user/1000 systemctl --user " + command)

    def journal_has(line):
        journal = "XDG_RUNTIME_DIR=/run/user/1000 journalctl --user -u agent-distro-update --no-pager"
        machine.wait_until_succeeds(user(journal + " | grep -F " + shlex.quote(line)))

    source = "${builtins.hashString "sha256" (builtins.toJSON { flake = "path:/home/testuser/update-flake"; profile = "vanilla"; })}"
    state = "/home/testuser/custom-state/agent-distro/" + source + "/current"
    machine.succeed("test ! -e " + state)
    assert "pi" in ${builtins.toJSON commands}
    for name in ${builtins.toJSON commands}:
        output = machine.succeed(user(name + " --version"))
        assert "updated-" not in output, output
    machine.succeed(systemctl("is-enabled agent-distro-update.timer"))
    timer = machine.succeed(systemctl("cat agent-distro-update.timer"))
    assert "RandomizedDelaySec=15min" in timer, timer
    service = machine.succeed(systemctl("cat agent-distro-update.service"))
    assert "StartLimitBurst=3" in service and "Restart=on-failure" in service, service
    machine.succeed(user("cp -r ${fixture} ~/update-flake; chmod -R u+w ~/update-flake"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    first = machine.succeed("readlink -f " + state).strip()
    assert first.startswith("/nix/store/"), first
    stamp = state.rsplit("/", 1)[0] + "/last-success"
    journal_has("agent-distro: vanilla updated nothing -> " + first)
    for name in ${builtins.toJSON commands}:
        output = machine.succeed(user("unset XDG_STATE_HOME; " + name + " --version 'two words'"))
        assert output.strip().endswith("updated-" + name + " --version two words"), output
    machine.succeed(user("cp ${fixtureV2}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    second = machine.succeed("readlink -f " + state).strip()
    assert second.startswith("/nix/store/") and second != first, second
    journal_has("agent-distro: vanilla updated " + first + " -> " + second)
    machine.succeed(systemctl("start agent-distro-update.service"))
    journal_has("agent-distro: vanilla unchanged (" + second + ")")
    successful_update = machine.succeed("cat " + stamp).strip()
    assert successful_update.isdigit(), successful_update
    machine.succeed(user("cp ${broken}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.fail(systemctl("start agent-distro-update.service"))
    machine.wait_until_succeeds(systemctl("is-failed agent-distro-update.service"))
    retries = machine.succeed(systemctl("show agent-distro-update.service -p NRestarts --value"))
    assert retries.strip().endswith("3"), retries
    journal_has("agent-distro: vanilla update failed")
    assert machine.succeed("cat " + stamp).strip() == successful_update
    assert machine.succeed("readlink -f " + state).strip() == second
    for name in ${builtins.toJSON commands}:
        assert "updated-" + name in machine.succeed(user(name + " --version"))
    # Reactivating the same source preserves its working update and GC root.
    machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 ${original}/activate"))
    assert machine.succeed("readlink -f " + state).strip() == second
    # Neither a changed profile nor a changed flake may reuse or keep rooting this update.
    for activation in ["${switchedProfile}", "${switchedFlake}"]:
        machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 " + activation + "/activate"))
        for name in ${builtins.toJSON commands}:
            output = machine.succeed(user("unset XDG_STATE_HOME; AI_GATEWAY=0 " + name + " --version"))
            assert "updated-" not in output, output
        machine.succeed("test ! -e " + shlex.quote(state.rsplit("/", 1)[0]))

    # A greeting and a native binary before the shim must still give a precise warning.
    machine.succeed(user("printf 'export PATH=/run/current-system/sw/bin:$PATH\\n' > ~/.bash_profile"))
    warning = machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 ${original}/activate 2>&1"))
    assert "PATH collision for omp: /run/current-system/sw/bin/omp; bare omp runs /run/current-system/sw/bin/omp" in warning, warning
  '';
}
