from agy_support import *

# The profile's kolu plugin, linked where agy reads it; its server starts
# through the command agy would run, and answers.
assert 'kolu' in inventory()
assert initialize(servers('kolu')['kolu']['command'])['name'] == 'kolu-test'
