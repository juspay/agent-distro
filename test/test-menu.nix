# The profile menu's own test. It lives here rather than in lib.nix because a
# third-party distribution has one profile and no menu to check.
{ menu, profiles, default }:
let
  common = import ./common.nix;
  other = builtins.head (builtins.filter (name: name != default) profiles);
in
{
  name = "menu";
  nodes.machine = { pkgs, ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ menu pkgs.python3 ];
  };
  testScript = ''
    ${common.testPreamble}

    # Without a terminal the menu says what to set instead of guessing.
    status, output = machine.execute("su - testuser -c 'ai --version </dev/null 2>&1'")
    assert status == 1, output
    assert "Set AI_PROFILE to" in output, output

    status, output = machine.execute("su - testuser -c 'AI_PROFILE=nonesuch ai --version </dev/null 2>&1'")
    assert status == 1, output
    assert "valid values: ${builtins.concatStringsSep ", " profiles}" in output, output

    # Every profile reaches every harness with no prompt in the way.
    for profile in ${builtins.toJSON profiles}:
        for harness in ["omp", "codex", "claude"]:
            machine.succeed(
                f"su - testuser -c 'AI_GATEWAY=0 AI_PROFILE={profile} AI_HARNESS={harness} ai --version </dev/null'"
            )

    machine.succeed("su - testuser -c 'python ${./check-menu.py} ${default} ${other}'")
  '';
}
