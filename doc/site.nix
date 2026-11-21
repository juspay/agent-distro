# The site is one page: index.md through template.html, by one pandoc call.
# `harnesses` (from the parent flake) reaches the template as metadata, so the
# page shows the versions the checkout pins. `agents` is the same list as
# words, and `compare` is compare.nix, checked.
{ lib, stdenvNoCC, pandoc, harnesses }:

let
  # How many agents, and their names, so no sentence on the page has to say.
  words = [ "zero" "one" "two" "three" "four" "five" "six" "seven" "eight" "nine" "ten" "eleven" "twelve" ];
  count = builtins.length harnesses;
  countWord = if count < builtins.length words then builtins.elemAt words count else toString count;
  capitalise = s: lib.toUpper (builtins.substring 0 1 s) + builtins.substring 1 (builtins.stringLength s) s;
  serial = names:
    if builtins.length names < 3 then lib.concatStringsSep " and " names
    else lib.concatStringsSep ", " (lib.init names) + ", and " + lib.last names;
  agents = {
    count = countWord;
    Count = capitalise countWord;
    list = serial (map (h: h.title) harnesses);
  };

  compare = import ./compare.nix { agents = agents.Count; };
  # A cell about another product, with the source that every one must have.
  cited = row: other:
    let cell = row.${other.key}; in {
      inherit (cell) text;
      detail = cell.detail or cell.text;
      source = cell.source or (throw "doc/compare.nix: the ${other.name} cell of \"${row.label}\" has no source");
    };
  table = {
    inherit (compare) readOn others;
    names = serial (map (o: o.name) compare.others);
    rows = map (row: { inherit (row) label own; cells = map (cited row) compare.others; }) compare.rows;
    facts = map
      (other: other // {
        facts = map
          (row: let cell = cited row other; in {
            inherit (row) label;
            inherit (cell) detail source;
            site = lib.removePrefix "https://" cell.source;
          })
          compare.rows;
      })
      compare.others;
  };
in
stdenvNoCC.mkDerivation {
  name = "agent-distro-site";
  src = ./.;
  nativeBuildInputs = [ pandoc ];
  metadata = builtins.toJSON { inherit harnesses agents; compare = table; };
  passAsFile = [ "metadata" ];
  buildPhase = ''
    runHook preBuild
    mkdir -p "$out"
    pandoc index.md --output "$out/index.html" \
      --from markdown+smart --to html5 \
      --template template.html --metadata-file "$metadataPath" \
      --toc --toc-depth 3 --wrap none --columns 500
    cp style.css site.js logo.svg demo.gif demo.png og.png agent-distro.schema.json "$out/"
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
