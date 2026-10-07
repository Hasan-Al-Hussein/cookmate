"""Record versioned annotation evidence from an explicitly selected prepared package."""

import argparse
import hashlib
import json
from pathlib import Path

from prepare_catalogue import CATALOGUE_VERSION, encoded, require


def record(package: Path, audit_path: Path) -> None:
    identity = json.loads((package / "generated/catalogue.json").read_text(encoding="utf-8"))["identity"]
    require(identity["version"] == CATALOGUE_VERSION, "Wrong annotation evidence version")
    source = json.loads((package / "evidence/T13/source-records.json").read_text(encoding="utf-8"))
    catalogue = json.loads((package / "generated/catalogue.json").read_text(encoding="utf-8"))
    annotations = json.loads((package / "reviewed-annotations.json").read_text(encoding="utf-8"))
    audit = json.loads(audit_path.read_text(encoding="utf-8-sig"))
    require(audit["reviewStatus"] == "reviewed_static_delta" and audit["catalogueVersion"] == identity["version"], "Unreviewed annotation evidence")
    require(audit["reviewedArtifactSha256"] == hashlib.sha256((package / "reviewed-annotations.json").read_bytes()).hexdigest(), "Annotation audit binding differs")
    require(audit["annotationCount"] == len(annotations) == 20, "Annotation evidence count differs")
    for recipe in catalogue["recipes"]:
        require(recipe["annotations"] == [note for note in annotations if note["recipeId"] == recipe["recipeId"]], "Prepared annotations differ")
    rows = {(sheet, row["row"]): row["cells"] for sheet, items in source["sheets"].items() for row in items}
    entries = []
    for annotation in annotations:
        excerpts = []
        for locator in annotation["evidence"]:
            cells = rows[(locator["sheet"], locator["row"])]
            assert cells["A"]["value"] == annotation["recipeId"]
            column = locator.get("column")
            excerpts.append({"locator": locator, "rawValue": cells[column]["value"] if column else {key: cell["value"] for key, cell in cells.items()}})
        entries.append({"annotation": annotation, "reviewedBy": "CookMate Data & Domain", "reviewBasis": "Compared original-preserving XLSX extraction and exact source locators; annotation wording reviewed separately from original text.", "sourceEvidence": excerpts, "shoppingDisposition": "unquantified review demand; preserve prose amount in notice" if annotation["kind"] == "instruction_only_ingredient" else "no additional demand from this notice"})
    gaps = {}
    for field, column in (("missingTags", "G"), ("missingOriginalPublisher", "J"), ("missingVideo", "K")):
        gaps[field] = [{"recipeId": row["cells"]["A"]["value"], "cell": f"Recipes!{column}{row['row']}"} for row in source["sheets"]["Recipes"] if row["cells"][column]["value"] is None]
    assert [len(gaps[key]) for key in ("missingTags", "missingOriginalPublisher", "missingVideo")] == [68, 8, 8]
    output = package / "evidence/T14"
    output.mkdir(parents=True, exist_ok=True)
    (output / "annotation-register.v2.json").write_bytes(encoded({"catalogue": catalogue["identity"], "workbookSha256": source["workbookSha256"], "notes": entries, "metadataGaps": gaps, "limits": "Source-gap review, not culinary/safety validation. Full photo inspection is recorded separately."}))
    print(f"Recorded {len(entries)} reviewed annotations and source metadata gaps.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--annotation-audit", type=Path, required=True)
    args = parser.parse_args()
    record(args.package_dir, args.annotation_audit)
