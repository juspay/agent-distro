# The update schedule shared by the Home Manager module, `mkUpdater` and any
# consumer, so they all read the same numbers: four runs a day, two hours after
# the 00:00/06:00/12:00/18:00 UTC crons in .github/workflows/update-flake.yml.
lib:
let
  updateHoursUTC = [ "02" "08" "14" "20" ];
in
{
  inherit updateHoursUTC;
  defaultFrequency = "*-*-* ${lib.concatStringsSep "," updateHoursUTC}:00:00 UTC";
  # One period per daily run, phased onto the first hour's UTC boundary.
  updatePeriodSeconds = 86400 / builtins.length updateHoursUTC;
  updateOffsetSeconds = lib.toIntBase10 (builtins.head updateHoursUTC) * 3600;
}