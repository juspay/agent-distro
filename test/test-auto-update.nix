{ pkgs, agent-distro, home-manager }:
let
  collision = builtins.head commands;
  # An empty local binary cache stands in for the project's: the updater must
  # hand it to nix and skip rather than build when it is unusable or incomplete.
  cacheDir = pkgs.writeTextDir "nix-cache-info" "StoreDir: /nix/store\n";
  # additionalPaths below keeps the directory in the guest store.
  cacheUrl = builtins.unsafeDiscardStringContext "file://${cacheDir}";
  cacheKey = "test-cache-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
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
      # The offline update fixture below exports the vanilla bundle.
      profile = "vanilla";
      flake = "path:/home/testuser/update-flake";
      # Avoid a timer firing before the fallback assertions.
      frequency = "2099-01-01";
      substituters.${cacheUrl} = cacheKey;
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
  # A cache the system config does not list: the daemon would ignore it.
  unusableCache = switched { substituters = { "file:///not-configured" = cacheKey; }; };
  # Offline flake mechanics stay independent of the build outcome under test.
  # Like the real bundle's trivial builders, fixtures are not substitutable
  # unless a test says otherwise.
  fixtureFlake' = substitutable: name: script: pkgs.writeTextDir "flake.nix" ''
    {
      outputs = { self }: {
        packages.x86_64-linux.vanilla = derivation {
          name = "${name}";
          system = "x86_64-linux";
          allowSubstitutes = ${if substitutable then "true" else "false"};
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
  fixtureFlake = fixtureFlake' false;
  agentsScript = ''
    ${pkgs.coreutils}/bin/mkdir -p "$out/bin"
    for name in ${pkgs.lib.escapeShellArgs commands}; do
      printf '#!${pkgs.bash}/bin/bash\necho updated-%s "$@"\n' "$name" > "$out/bin/$name"
      ${pkgs.coreutils}/bin/chmod +x "$out/bin/$name"
    done
  '';
  manifestScript = version: agentsScript + ''
    ${pkgs.coreutils}/bin/mkdir -p "$out/share/agent-distro"
    printf 'claude\tClaude Code\t2.0\ncodex\tCodex\t%s\n' ${pkgs.lib.escapeShellArg version} > "$out/share/agent-distro/versions"
  '';
  fixture = fixtureFlake "updated-agents" (manifestScript "1.0+abc123");
  fixtureV2 = fixtureFlake "updated-agents-v2" (manifestScript "1.1+def456");
  fixtureSame = fixtureFlake "updated-agents-same" (manifestScript "1.1+def456");
  fixtureAdded = fixtureFlake "updated-agents-added" (manifestScript "1.1+def456" + ''
    printf 'pi\tPi\t1.0.0\n' >> "$out/share/agent-distro/versions"
  '');
  legacy = fixtureFlake "legacy-agents" agentsScript;
  broken = fixtureFlake "broken-agents" "exit 1";
  # Substitutable and absent from the empty cache: building it means compiling.
  uncached = fixtureFlake' true "uncached-agents" (manifestScript "9.9+uncached");
  node = trusted: { ... }: {
    imports = [ (import ./common.nix).baseNode home-manager.nixosModules.home-manager ];
    users.users.testuser.linger = true;
    environment.systemPackages = [ (pkgs.writeShellScriptBin collision "exit 99") ];
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      substituters = pkgs.lib.mkForce (pkgs.lib.optional (!trusted) cacheUrl);
      trusted-public-keys = pkgs.lib.optional (!trusted) cacheKey;
      trusted-users = pkgs.lib.optional trusted "testuser";
    };
    # Alternate generations must be registered in the VM store for activation's GC roots.
    virtualisation.additionalPaths = [ fixture fixtureV2 fixtureSame fixtureAdded legacy broken uncached cacheDir unusableCache pkgs.bash pkgs.coreutils switchedProfile switchedFlake original ];
    environment.loginShellInit = ''
      echo "Welcome: this greeting is not a PATH"
    '';
    home-manager.users.testuser = homeConfig;
  };
in
{
  name = "auto-update";
  nodes.machine = node false;
  nodes.trusted = node true;
  testScript = ''
    import re
    import shlex
    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.wait_for_unit("home-manager-testuser.service")
    machine.wait_for_unit("user@1000.service")
    activation = machine.succeed("journalctl -u home-manager-testuser.service --no-pager")
    assert "warning: agent-distro PATH collision for ${collision}: /run/current-system/sw/bin/${collision}; bare ${collision} runs /home/testuser/.nix-profile/bin/${collision}" in activation, activation
    for name in ${builtins.toJSON (builtins.tail commands)}:
        assert "PATH collision for " + name not in activation, activation

    def user(command):
        return "su - testuser -c " + shlex.quote(command)

    def systemctl(command):
        return user("XDG_RUNTIME_DIR=/run/user/1000 systemctl --user " + command)

    def journal_has(line):
        journal = "journalctl _UID=1000 _SYSTEMD_USER_UNIT=agent-distro-update.service --no-pager"
        machine.wait_until_succeeds(journal + " | grep -F " + shlex.quote(line))

    source = "${builtins.hashString "sha256" (builtins.toJSON { flake = "path:/home/testuser/update-flake"; profile = "vanilla"; })}"
    state = "/home/testuser/custom-state/agent-distro/" + source + "/current"
    history = "/home/testuser/custom-state/agent-distro/history.log"
    events = []

    def check_history():
        lines = machine.succeed("cat " + history).splitlines()
        assert len(lines) == len(events), lines
        for line, event in zip(lines, events):
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2} vanilla " + re.escape(event), line), line

    machine.succeed("test ! -e " + state)
    for name in ${builtins.toJSON commands}:
        output = machine.succeed(user(name + " --version"))
        assert "updated-" not in output, output
    machine.succeed(systemctl("is-enabled agent-distro-update.timer"))
    timer = machine.succeed(systemctl("cat agent-distro-update.timer"))
    assert "RandomizedDelaySec=15min" in timer, timer
    service = machine.succeed(systemctl("cat agent-distro-update.service"))
    assert "StartLimitBurst=3" in service and "Restart=on-failure" in service, service
    machine.succeed(user("cp -r ${fixture} ~/update-flake; chmod -R u+w ~/update-flake"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    first = machine.succeed("readlink -f " + state).strip()
    assert first.startswith("/nix/store/"), first
    stamp = state.rsplit("/", 1)[0] + "/last-success"
    journal_has("agent-distro: vanilla updated nothing -> " + first)
    events.append("updated: Claude Code 2.0, Codex 1.0+abc123")
    check_history()
    for name in ${builtins.toJSON commands}:
        output = machine.succeed(user("unset XDG_STATE_HOME; " + name + " --version 'two words'"))
        assert output.strip().endswith("updated-" + name + " --version two words"), output
    machine.succeed(user("cp ${fixtureV2}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    second = machine.succeed("readlink -f " + state).strip()
    assert second.startswith("/nix/store/") and second != first, second
    journal_has("agent-distro: vanilla updated " + first + " -> " + second)
    events.append("updated: Codex 1.0+abc123 → 1.1+def456")
    check_history()
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    journal_has("agent-distro: vanilla unchanged (" + second + ")")
    check_history()
    # A changed bundle can retain every harness version.
    machine.succeed(user("cp ${fixtureSame}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    events.append("updated: no harness version changed")
    check_history()
    machine.succeed(user("cp ${fixtureAdded}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    events.append("updated: Pi added 1.0.0")
    check_history()
    machine.succeed(user("cp ${fixtureV2}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    events.append("updated: Pi removed")
    check_history()
    # Upgrading a pre-manifest bundle has no previous versions to report.
    machine.succeed(user("cp ${legacy}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    events.append("updated: versions not recorded by this bundle")
    check_history()
    machine.succeed(user("cp ${fixtureV2}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    events.append("updated: Claude Code 2.0, Codex 1.1+def456")
    check_history()
    successful_update = machine.succeed("cat " + stamp).strip()
    assert successful_update.isdigit(), successful_update
    machine.succeed(user("cp ${broken}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.fail(systemctl("start agent-distro-update.service"))
    machine.wait_until_succeeds(systemctl("is-failed agent-distro-update.service"))
    retries = machine.succeed(systemctl("show agent-distro-update.service -p NRestarts --value"))
    assert retries.strip().endswith("3"), retries
    journal_has("agent-distro: vanilla update failed")
    events.extend(["failed: nix build exit 1"] * 3)
    check_history()
    assert machine.succeed("cat " + stamp).strip() == successful_update
    assert machine.succeed("readlink -f " + state).strip() == second
    for name in ${builtins.toJSON commands}:
        assert "updated-" + name in machine.succeed(user(name + " --version"))
    # Reactivating the same source preserves its working update and GC root.
    machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 ${original}/activate"))
    assert machine.succeed("readlink -f " + state).strip() == second
    check_history()
    # Neither a changed profile nor a changed flake may reuse or keep rooting this update.
    for activation in ["${switchedProfile}", "${switchedFlake}"]:
        machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 " + activation + "/activate"))
        for name in ${builtins.toJSON commands}:
            output = machine.succeed(user("unset XDG_STATE_HOME; AI_GATEWAY=0 " + name + " --version"))
            assert "updated-" not in output, output
        machine.succeed("test ! -e " + shlex.quote(state.rsplit("/", 1)[0]))
        check_history()

    # A greeting and a native binary before the shim must still give a precise warning.
    machine.succeed(user("printf 'export PATH=/run/current-system/sw/bin:$PATH\\n' > ~/.bash_profile"))
    warning = machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 ${original}/activate 2>&1"))
    assert "PATH collision for ${collision}: /run/current-system/sw/bin/${collision}; bare ${collision} runs /run/current-system/sw/bin/${collision}" in warning, warning

    # A manifest-less first install also has unknown versions.
    machine.succeed("test ! -e " + state)
    machine.succeed(user("cp ${legacy}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    events.append("updated: versions not recorded by this bundle")
    check_history()

    # Never compile on a cache miss: the substitutable derivation is skipped,
    # the current bundle stays, and the run is neither a failure nor a retry.
    before = machine.succeed("readlink -f " + state).strip()
    restarts = lambda: machine.succeed(systemctl("show agent-distro-update.service -p NRestarts --value")).strip()
    restarted = restarts()
    machine.succeed(user("cp ${uncached}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    journal_has("agent-distro: vanilla update skipped: bundle not fully cached yet (would build uncached-agents)")
    events.append("skipped: bundle not fully cached yet (would build uncached-agents)")
    check_history()
    assert machine.succeed("readlink -f " + state).strip() == before
    assert restarts() == restarted, restarts()
    # A repeat of the same reason is not logged again.
    machine.succeed(systemctl("start agent-distro-update.service"))
    check_history()
    # A cache the daemon would ignore skips before any build, and activation warns once.
    warning = machine.succeed(user("XDG_RUNTIME_DIR=/run/user/1000 ${unusableCache}/activate 2>&1"))
    assert warning.count("agent-distro cannot use cache file:///not-configured") == 1, warning
    machine.succeed(user("cp ${fixtureV2}/flake.nix ~/update-flake/flake.nix"))
    machine.succeed(systemctl("reset-failed agent-distro-update.service"))
    machine.succeed(systemctl("start agent-distro-update.service"))
    journal_has("agent-distro: vanilla update skipped: cache file:///not-configured not usable")
    events.append("skipped: cache file:///not-configured not usable; add it to nix.settings substituters/trusted-public-keys")
    check_history()
    assert machine.succeed("readlink -f " + state).strip() == before

    # A trusted user needs no system cache config: the daemon honours the
    # updater's own --option, so the update proceeds instead of skipping.
    trusted.start()
    trusted.wait_for_unit("multi-user.target")
    trusted.wait_for_unit("user@1000.service")
    trusted.succeed(user("cp -r ${fixture} ~/update-flake; chmod -R u+w ~/update-flake"))
    trusted.succeed(systemctl("start agent-distro-update.service"))
    lines = trusted.succeed("cat " + history).splitlines()
    assert len(lines) == 1 and lines[0].endswith(" vanilla updated: Claude Code 2.0, Codex 1.0+abc123"), lines
  '';
}
