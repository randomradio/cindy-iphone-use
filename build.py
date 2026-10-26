#!/usr/bin/env python3
"""Reproduce model schemas from the vendored v0.3.6 definitions; no Runtime/device I/O."""
import json
from pathlib import Path
import sys
root = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(root / 'upstream/server'))
from iphone_use import SCHEMAS
manifest = json.loads((root / 'ghost.json').read_text())
for tool in manifest['tools']:
    if tool['name'] == 'adapter_status':
        tool['parameters']['additionalProperties'] = False
        continue
    schema = json.loads(json.dumps(SCHEMAS[tool['name']]))
    if tool['name'] == 'ready':
        schema['properties'].pop('recover')
        schema['properties']['screenshot']['default'] = False
        for example in schema.get('examples', []):
            example.pop('recover', None)
    tool['parameters'] = schema
(root / 'ghost.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
