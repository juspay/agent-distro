# The site is one page: index.md through template.html, by one pandoc call.
# `harnesses` (from the parent flake) reaches the template as metadata, so the
# page shows the versions the checkout pins.
{ stdenvNoCC, pandoc, harnesses }:

stdenvNoCC.mkDerivation {
  name = "agent-distro-site";
  src = ./.;
  nativeBuildInputs = [ pandoc ];
  metadata = builtins.toJSON { inherit harnesses; };
  passAsFile = [ "metadata" ];
  buildPhase = ''
    runHook preBuild
    mkdir -p "$out"
    pandoc index.md --output "$out/index.html" \
      --from markdown+smart --to html5 \
      --template template.html --metadata-file "$metadataPath" \
      --toc --toc-depth 3 --wrap none --columns 500
    cp style.css site.js logo.svg demo.gif demo.png og.png "$out/"
    touch "$out/.nojekyll"
    runHook postBuild
  '';
  dontInstall = true;
}
