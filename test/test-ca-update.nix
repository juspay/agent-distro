# The content-addressed update path, in a VM: a user whose nix will not honour
# the cache updates from the package the index publishes for the revision, which
# needs no signature and no nix.conf change — and takes the old skip where the
# index publishes none (src/update/update.ts `contentAddressed`).
#
# The stub index answers on 200 and 404 ports over TLS (the updater fetches
# only an https base, and refuses anything else), the package's content-addressed
# rewrite stands in for what CI publishes, and the cache that holds it is one
# this user's nix would not take a signed path from.
{ pkgs, agent-distro }:
let
  inherit (pkgs) lib;
  common = import ./common.nix;
  runtime = import "${agent-distro}/lib/runtime.nix" pkgs;
  # What CI publishes: the package's closure rewritten, so the updater copies
  # paths this store does not have under names it has never seen.
  published = pkgs.runCommand "agent-distro-ca-package" { } ''
    mkdir -p "$out/bin" "$out/share/agent-distro"
    # A store path in the launcher, so the rewrite has real work to do.
    printf '#!${pkgs.bash}/bin/bash\nexec ${pkgs.coreutils}/bin/echo ca-fixture "$@"\n' > "$out/bin/claude"
    chmod +x "$out/bin/claude"
    printf 'claude\tClaude Code\t1.2.3\n' > "$out/share/agent-distro/versions"
  '';
  # Nothing here is built: the path under test copies what CI published.
  flake = pkgs.writeTextDir "flake.nix" ''
    { outputs = { self }: { }; }
  '';
  cacheUrl = builtins.unsafeDiscardStringContext "file:///tmp/cache";
  cacheKey = "ca-test-1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  okPort = 8100;
  missingPort = 8101;
  signedPort = 8102;
  noCaPort = 8103;
  # A self-signed certificate for 127.0.0.1: the stub index is an https server,
  # and the updater is pointed at this as its trust anchor (NODE_EXTRA_CA_CERTS).
  # A test key for a test server, which nothing else trusts.
  cert = pkgs.runCommand "ca-index-cert" { nativeBuildInputs = [ pkgs.openssl ]; } ''
    mkdir -p "$out"
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout "$out/key.pem" -out "$out/cert.pem" \
      -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" \
      -addext "basicConstraints=critical,CA:TRUE"
  '';
  # Each stub serves the file it is given: the pair, or — as a darwin system's
  # entry has it — the signed package alone.
  indexServer = status: port: entry: pkgs.writeShellScript "ca-index-${toString port}" ''
    exec ${pkgs.python3}/bin/python ${./support/ca-index-fixture.py} \
      ${toString status} ${toString port} ${cert}/cert.pem ${cert}/key.pem ${entry} /tmp/ca-requests.log
  '';
  indexUrl = port: "https://127.0.0.1:${toString port}";
  # What a `*-darwin` entry looks like: the signed package, nothing rewritten.
  signedEntry = pkgs.writeText "ca-signed.json" (builtins.toJSON { ia = published; });
  # An entry whose ca the cache does not hold: what a copy that cannot be made
  # looks like from here (a cache that has not caught up, or a nix that will
  # not take it).
  absentEntry = pkgs.writeText "ca-absent.json" (builtins.toJSON {
    ia = published;
    ca = "/nix/store/00000000000000000000000000000000-agent-distro-default";
  });
  # What a config names: the index it reads and the attribute it builds and
  # looks up. `config` is the one package; `configFor` names another, for the
  # case that proves the updater reads it rather than the constant.
  configFor = caIndex: attribute: pkgs.writeText "ca-update-config.json" (builtins.toJSON {
    # A revision (git+file:), which is what the index is keyed by.
    flake = "git+file:///home/testuser/update-flake";
    state = "/home/testuser/state";
    history = "/home/testuser/state/history.log";
    nix = lib.getExe pkgs.nix;
    substituters = { ${cacheUrl} = cacheKey; };
    inherit caIndex attribute;
    periodSeconds = 21600;
    offsetSeconds = 0;
  });
  config = caIndex: configFor caIndex "default";
in
{
  name = "ca-update";
  nodes.machine = { ... }: {
    imports = [ common.baseNode ];
    environment.systemPackages = [ pkgs.git ];
    # The fixtures are in the guest store: the package the rewrite starts from,
    # and the flake whose revision the index is keyed by.
    virtualisation.additionalPaths = [ published flake ];
    # The cache is one this user's nix would not take a signed path from: it
    # is not in the system configuration, and the updater's own substituters
    # and key are dropped for a user the daemon does not trust.
    nix.settings.experimental-features = [ "nix-command" "flakes" ];
    nix.settings.substituters = lib.mkForce [ ];
    systemd.services.ca-index-ok = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${indexServer 200 okPort "/tmp/ca-pair.json"}";
    };
    systemd.services.ca-index-signed = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${indexServer 200 signedPort signedEntry}";
    };
    systemd.services.ca-index-absent = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${indexServer 200 noCaPort absentEntry}";
    };
    systemd.services.ca-index-missing = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig.ExecStart = "${indexServer 404 missingPort "/tmp/ca-pair.json"}";
    };
  };
  testScript = ''
    import json
    import shlex
    ${common.testPreamble}
    machine.wait_for_unit("ca-index-ok.service")
    machine.wait_for_unit("ca-index-signed.service")
    machine.wait_for_unit("ca-index-missing.service")
    machine.wait_for_open_port(${toString okPort})
    machine.wait_for_open_port(${toString signedPort})
    machine.wait_for_open_port(${toString noCaPort})
    machine.wait_for_open_port(${toString missingPort})

    def user(command):
        return machine.succeed("su - testuser -c " + shlex.quote(command))

    def update(config):
        # The index base is https, and the stub's certificate is self-signed:
        # this is the trust anchor the updater verifies it against.
        output = user("NODE_EXTRA_CA_CERTS=${cert}/cert.pem "
                      "${runtime.node} ${runtime.tree}/src/update/update.ts " + config + " 2>&1")
        # The run's own words, in the test log: the copy, the update and the skip.
        machine.log(output.strip())
        return output

    def current():
        return machine.succeed("readlink -f /home/testuser/state/current").strip()

    def history():
        return user("cat /home/testuser/state/history.log")

    # The premise: not a trusted user, so nix drops the updater's own
    # substituters and keys and the signed package stays out of reach. A
    # trusted testuser would prove nothing.
    info = json.loads(user("nix store info --json"))
    assert info["trusted"] is False, info

    ia = "${published}"
    ca = json.loads(machine.succeed("nix store make-content-addressed --json " + ia))["rewrites"][ia]
    assert ca != ia, (ia, ca)
    # The cache holds the content-addressed package and this store does not:
    # nothing but the updater's copy can bring it back.
    machine.succeed("nix copy --to ${cacheUrl} " + ca)
    machine.succeed("nix store delete " + ca)
    machine.fail("test -e " + ca)
    machine.succeed("printf %s " + shlex.quote(json.dumps({"ia": ia, "ca": ca})) + " > /tmp/ca-pair.json")
    machine.succeed("chmod 644 /tmp/ca-pair.json")
    user("cp -r ${flake} ~/update-flake && chmod -R u+w ~/update-flake")
    user("cd ~/update-flake && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm flake")

    with subtest("the index publishes the revision: an untrusted user updates"):
        output = update("${config "${indexUrl okPort}"}")
        assert "updated nothing -> " + ca in output, output
        assert current() == ca, current()
        # The content-addressed path is back, unsigned and uncached by nix.conf.
        machine.succeed("test -e " + ca)
        # The package is usable: the launcher runs from the updated link.
        assert "ca-fixture" in user("$(readlink -f /home/testuser/state/current)/bin/claude --version")
        # `versions` came out of the content-addressed package.
        assert "updated: Claude Code 1.2.3" in history(), history()
        # A repeat is unchanged, and copies nothing — under `--progress`, where
        # the copy is asked for nix's own progress on stderr.
        output = update("${config "${indexUrl okPort}"} --progress")
        assert '"result":"unchanged","package":"' + ca + '"' in output, output

    with subtest("a base that is not https is refused, and not fetched"):
        output = update("${config "http://127.0.0.1:${toString okPort}"}")
        assert 'ignoring caIndex "http://127.0.0.1:${toString okPort}"' in output, output
        assert "must be an https URL with no credentials, query or fragment" in output, output
        assert "update skipped: cache ${cacheUrl} not usable" in output, output
        assert current() == ca, current()

    with subtest("an entry that names the signed package alone is the ordinary skip"):
        # What a Mac gets from this index: nothing to copy content-addressed, so
        # the update skips — and says nothing about it being malformed.
        output = update("${config "${indexUrl signedPort}"}")
        assert "update skipped: cache ${cacheUrl} not usable" in output, output
        assert "no content-addressed package is published for revision" in output, output
        assert "ignoring caIndex" not in output, output
        assert "names no signed package" not in output, output
        assert current() == ca, current()

    with subtest("a ca the cache cannot supply is a skip that claims no more"):
        output = update("${config "${indexUrl noCaPort}"}")
        # The entry is well formed and names a ca; the cache simply cannot
        # supply it, so the reason says exactly that and nothing about what the
        # cache holds (a nix that will not take the path looks the same here).
        assert "update skipped: content-addressed package " \
               "/nix/store/00000000000000000000000000000000-agent-distro-default " \
               "could not be copied from ${cacheUrl}" in output, output
        assert current() == ca, current()

    with subtest("the index publishes no revision: the old skip, reworded"):
        before = len(history().splitlines())
        output = update("${config "${indexUrl missingPort}"}")
        assert "update skipped: cache ${cacheUrl} not usable" in output, output
        assert "no content-addressed package is published for revision" in output, output
        assert current() == ca, current()
        # Recorded, as the last thing that happened — and a repeat of the same
        # reason, which the next run is, adds nothing.
        last = history().splitlines()[-1]
        assert "skipped: cache ${cacheUrl} not usable and no content-addressed package is " \
               "published for revision " in last, last
        assert "could not be copied" not in last, last
        update("${config "${indexUrl missingPort}"}")
        assert len(history().splitlines()) == before + 1, history()

    with subtest("the config's own attribute is the entry the index is asked for"):
        # `attribute` is read, not the constant: a config naming another asks
        # for `<rev>/<system>/other.json` and builds `#other`, whatever the
        # package is called. The fixture records every path it served.
        machine.succeed("rm -f /tmp/ca-requests.log")
        update("${configFor "${indexUrl okPort}" "other"}")
        requested = machine.succeed("cat /tmp/ca-requests.log").splitlines()
        assert requested, requested
        assert requested[-1].endswith("/x86_64-linux/other.json"), requested
  '';
}
