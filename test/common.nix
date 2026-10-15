# Shared VM setup only. Agent discovery protocols belong in their own tests.
{
  baseNode = {
    environment.variables.PI_SKIP_VERSION_CHECK = "1";
    users.users.testuser = { isNormalUser = true; uid = 1000; };
    system.stateVersion = "24.05";
  };

  gatewayNode = { pkgs, ... }: {
    systemd.services.fake-gateway = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${pkgs.python3}/bin/python ${./support/gateway-fixture.py}";
    };
  };

  testPreamble = ''
    machine.start()
    machine.wait_for_unit("multi-user.target")
    machine.succeed("loginctl enable-linger testuser")
  '';
}
