from opencode_support import *

original = check_inventory()
updated = check_inventory('opencode-updated')
old_paths = set(original['skills']['paths'])
new_paths = set(updated['skills']['paths'])
assert old_paths and new_paths and old_paths.isdisjoint(new_paths), (original, updated)
check_inventory()
assert settings.read_bytes() == preserved
