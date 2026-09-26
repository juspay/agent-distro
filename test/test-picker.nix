{ name ? "picker", menu, profiles, default }:
let
  common = import ./common.nix;
  names = [ default ] ++ builtins.filter (n: n != default) (builtins.attrNames profiles);
  menuShape = {
    inherit default;
    others = builtins.filter (n: n != default) names;
    gateway = builtins.any (n: (profiles.${n}.gateway or null) != null) names;
  };
in
{
  inherit name;
  nodes.machine = { pkgs, ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ menu pkgs.python3 ];
  };
  testScript = ''
    import shlex
    ${common.testPreamble}

    # Without a terminal the picker says what to set instead of guessing.
    status, output = machine.execute("su - testuser -c 'ai --version </dev/null 2>&1'")
    assert status == 1, output
    assert "Set AI_HARNESS to omp, codex, or claude" in output, output
    assert "github:" not in output, output

    for override in ["AI_HARNESS=bad", "AI_HARNESS="]:
        status, output = machine.execute(f"su - testuser -c '{override} ai --version </dev/null 2>&1'")
        assert status == 1 and "valid values:" in output, output

    status, output = machine.execute("su - testuser -c 'AI_PROFILE=nonesuch ai --version </dev/null 2>&1'")
    assert status == 1, output
    assert "valid values: ${builtins.concatStringsSep ", " names}" in output, output

    # Every profile reaches every harness with no list in the way.
    for profile in ${builtins.toJSON names}:
        for harness in ["omp", "codex", "claude"]:
            machine.succeed(
                f"su - testuser -c 'AI_GATEWAY=0 AI_PROFILE={profile} AI_HARNESS={harness} ai --version </dev/null'"
            )

    machine.succeed(
        "su - testuser -c " + shlex.quote(
            "python ${./check-picker.py} " + shlex.quote('${builtins.toJSON menuShape}')
        )
    )
  '';
}
