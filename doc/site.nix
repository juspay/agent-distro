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
    # Pages caches assets for ten minutes; a content hash in the URL means a
    # new page never runs with an old stylesheet or script.
    for asset in style.css site.js; do
      hash=$(sha256sum "$asset" | cut -c1-8)
      sed -i "s|\"/$asset\"|\"/$asset?v=$hash\"|" "$out/index.html"
    done
    touch "$out/.nojekyll"
    runHook postBuild
  '';
  dontInstall = true;
}
