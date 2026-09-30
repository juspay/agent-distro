from opencode_support import *

original = check_inventory()
updated = check_inventory('opencode2-updated')
old_paths, new_paths = set(skill_paths(original)), set(skill_paths(updated))
assert old_paths and new_paths and old_paths.isdisjoint(new_paths), (original, updated)
check_inventory()
assert settings.read_bytes() == preserved
