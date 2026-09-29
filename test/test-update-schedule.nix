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
assert linux.systemd.user.timers.agent-distro-update.Timer.OnCalendar == "*-*-* 12:00:00 UTC";
assert darwin.services.agent-distro.frequency == linux.services.agent-distro.frequency;
assert map (interval: interval.Minute) calendar == [ 0 ];
assert builtins.all (interval: interval.Hour == null) calendar;
assert !(builtins.tryEval (configuration "aarch64-darwin" { frequency = "daily"; }).home.activationPackage.drvPath).success;
pkgs.runCommand "update-schedule" { } ''
  ${pkgs.bash}/bin/bash -eu ${./check-update-due.sh} ${agent-distro}/lib/update-due.sh
  touch "$out"
''
