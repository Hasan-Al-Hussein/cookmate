"""Record the exact deterministic search implementation used by both consumers."""

import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = root / "packages/domain/src/search.ts"
target = root / "packages/domain/src/generated/search-identity.json"
fingerprint = hashlib.sha256(source.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8")).hexdigest()
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps({"version": "source-search-v1", "fingerprint": fingerprint}, indent=2) + "\n", encoding="utf-8", newline="\n")
print(fingerprint)
