{ launchers, profile }:
let common = import ./common.nix;
in {
  name = "picker";
  nodes.machine = { pkgs, ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ launchers.picker pkgs.python3 ];
  };
  testScript = ''
    ${common.testPreamble}
    status, output = machine.execute("su - testuser -c 'ai --version </dev/null 2>&1'")
    assert status == 1
    assert "Set AI_HARNESS to omp, codex, or claude" in output, output
    assert "github:" not in output, output
    for harness in ["omp", "codex", "claude"]:
        machine.succeed(f"su - testuser -c 'AI_GATEWAY=0 AI_HARNESS={harness} ai --version </dev/null'")
    for override in ["AI_HARNESS=bad", "AI_HARNESS="]:
        status, output = machine.execute(f"su - testuser -c '{override} ai --version </dev/null 2>&1'")
        assert status == 1 and "valid values:" in output, output
    machine.succeed("su - testuser -c 'python ${./check-picker.py} ${if (profile.gateway or null) == null then "no-gateway" else "gateway"}'")
  '';
}
