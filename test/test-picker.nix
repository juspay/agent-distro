{ name ? "picker", menu, profile }:
let
  common = import ./common.nix;
  harnesses = (import ../lib/discover-harnesses.nix).ordered;
in
{
  inherit name;
  nodes.machine = { pkgs, ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ menu pkgs.python3 pkgs.git ];
  };
  testScript = ''
    import shlex
    ${common.testPreamble}

    # Without a terminal the picker says what to set instead of guessing.
    status, output = machine.execute("su - testuser -c 'agent-distro --version </dev/null 2>&1'")
    assert status == 1, output
    assert "Set AI_HARNESS to ${builtins.concatStringsSep ", " (builtins.genList (i: builtins.elemAt harnesses i) (builtins.length harnesses - 1))}, or ${builtins.elemAt harnesses (builtins.length harnesses - 1)}" in output, output
    assert "agent-distro <harness>" in output, output
    assert "AI_PROFILE" not in output, output

    for override in ["AI_HARNESS=bad", "AI_HARNESS="]:
        status, output = machine.execute(f"su - testuser -c '{override} agent-distro --version </dev/null 2>&1'")
        assert status == 1 and "valid values:" in output, output

    # A profile that is neither built in nor a reference stops before any harness.
    status, output = machine.execute("su - testuser -c 'AI_PROFILE=nonesuch AI_HARNESS=claude agent-distro --version </dev/null 2>&1'")
    assert status == 1, output
    assert "AI_PROFILE=nonesuch: not a built-in profile (${profile.name}" in output, output

    # The built-in profile reaches every harness with no list in the way, by
    # name or by default.
    for selector in ["", "${profile.name}"]:
        for harness in ${builtins.toJSON harnesses}:
            machine.succeed(
                f"su - testuser -c 'AI_GATEWAY=0 AI_HARNESS={harness} agent-distro {selector} --version </dev/null'"
            )

    # The listing as Nix computed it; the check compares `--list --json` to it.
    machine.succeed(
        "su - testuser -c " + shlex.quote(
            "python ${./check-picker.py} " + shlex.quote(${builtins.toJSON (builtins.toJSON menu.listing)})
        )
    )
  '';
}
