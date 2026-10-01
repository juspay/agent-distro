# Adapt a guest Python script and its sibling support modules to the VM driver.
script: ''
  machine.succeed("su - testuser -c " + shlex.quote(
    ${builtins.toJSON "python ${builtins.dirOf script}/${baseNameOf script}"} + " " + arguments))
''
