# Exercise the shared UTC policy without launchd or a wall clock.
{ pkgs, nixpkgs, agent-distro, home-manager }:
let
  configuration = system: settings: (home-manager.lib.homeManagerConfiguration {
    pkgs = nixpkgs.legacyPackages.${system};
    modules = [
      agent-distro.homeManagerModules.default
      {
        home = { username = "testuser"; homeDirectory = "/home/testuser"; stateVersion = "24.05"; };
        services.agent-distro = { enable = true; } // settings;
      }
    ];
  }).config;
  linux = configuration "x86_64-linux" { };
  darwin = configuration "aarch64-darwin" { };
  calendar = darwin.launchd.agents.agent-distro-update.config.StartCalendarInterval;
in
assert linux.systemd.user.timers.agent-distro-update.Timer.OnCalendar == "*-*-* 02,08,14,20:00:00 UTC";
assert darwin.services.agent-distro.frequency == linux.services.agent-distro.frequency;
assert map (interval: interval.Minute) calendar == [ 0 ];
assert builtins.all (interval: interval.Hour == null) calendar;
# The Darwin gate derives its period/phase from the same hours list; forcing
# the launchd program evaluates that derivation on any platform (no build).
assert builtins.head darwin.launchd.agents.agent-distro-update.config.ProgramArguments != "";
assert !(builtins.tryEval (configuration "aarch64-darwin" { frequency = "daily"; }).home.activationPackage.drvPath).success;
let runtime = import "${agent-distro}/lib/runtime.nix" pkgs; in
pkgs.runCommand "update-schedule" { } ''
  ${runtime.node} ${./check-update-due.ts} ${runtime.tree}/src
  ${runtime.node} ${./check-cache-usable.ts} ${runtime.tree}/src
  touch "$out"
''
