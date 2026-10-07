"""Reconcile every prepared source value against a separately preserved extraction."""

import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from prepare_catalogue import HEADERS, encoded, prepare
from workbook_source import read_workbook, source_rows


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def verify(source_dir: Path, package_dir: Path, annotations_path: Path, photo_treatment_path: Path) -> dict:
    source = read_workbook(source_dir / "sources/CookMate-Dataset.xlsx")
    extracted = load(source_dir / "analysis/dataset/workbook_analysis.json")
    raw = load(package_dir / "evidence/T13/source-records.json")
    prepared = load(package_dir / "generated/catalogue.json")
    archived = extracted["complete_values"]
    differences = []
    checked_cells = 0
    verified_date_serials = 0
    for sheet, headers in HEADERS.items():
        columns = "ABCDEFGHIJKL"[:len(headers)]
        direct_rows = source_rows(source, sheet, columns)
        assert raw["sheets"][sheet] == direct_rows, f"Raw storage/value difference: {sheet}"
        for current, original in zip(direct_rows, archived[sheet], strict=True):
            assert current["row"] == original["excel_row"], f"Row mismatch: {sheet}"
            for column, header in zip(columns, headers, strict=True):
                checked_cells += 1
                if sheet == "Recipes" and column == "L":
                    archived_date = datetime.fromisoformat(original[header])
                    expected_milliseconds = round((archived_date - datetime(1899, 12, 30)).total_seconds() * 1000)
                    assert round(current["cells"][column]["value"] * 86400000) == expected_milliseconds
                    verified_date_serials += 1
                elif current["cells"][column]["value"] != original[header]:
                    differences.append(f"{sheet}!{column}{current['row']}")
    assert not differences, f"Archived extraction differs: {differences}"
    by_id = {recipe["recipeId"]: recipe for recipe in prepared["recipes"]}
    for row in archived["Recipes"]:
        recipe = by_id[row["Recipe ID"]]
        for key, heading in (("title", "Recipe name"), ("category", "Category"), ("cuisine", "Cuisine / area"), ("rawTags", "Tags"), ("photoKey", "Local photo"), ("recipePage", "Recipe page"), ("originalSourceUrl", "Original source URL"), ("videoUrl", "Video URL")):
            assert recipe[key] == row[heading], f"Recipe field differs: {recipe['recipeId']} {key}"
    for row in archived["Ingredients"]:
        recipe = by_id[row["Recipe ID"]]
        entry = recipe["ingredients"][row["Position"] - 1]
        assert (entry["rawName"], entry["rawMeasure"], entry["source"]) == (row["Ingredient"], row["Measure"], {"sheet": "Ingredients", "row": row["excel_row"], "column": "D"})
    heading_rows = {item["row"] for item in extracted["integrity"]["instruction_heading_only_passages"]}
    for row in archived["Instructions"]:
        passage = by_id[row["Recipe ID"]]["instructions"][row["Passage"] - 1]
        assert passage["rawText"] == row["Cooking instructions"]
        assert passage["source"] == {"sheet": "Instructions", "row": row["excel_row"], "column": "D"}
        assert (passage["presentation"] == "heading") == (row["excel_row"] in heading_rows)
    expected_outputs = ["generated/catalogue.json", "generated/provenance.json", "evidence/T13/source-records.json", "evidence/T13/source-to-derived-reconciliation.json", "evidence/T13/asset-path-manifest.json", "src/photo-assets.ts"]
    with TemporaryDirectory(prefix="cookmate-catalogue-check-") as temporary:
        rebuilt = Path(temporary)
        prepare(source_dir, rebuilt, annotations_path, photo_treatment_path)
        for relative in expected_outputs:
            assert (package_dir / relative).read_bytes() == (rebuilt / relative).read_bytes(), f"Non-repeatable output: {relative}"
        for asset in load(package_dir / "evidence/T13/asset-path-manifest.json"):
            expected = asset["sha256"]
            assert hashlib.sha256((package_dir / asset["packagedPath"]).read_bytes()).hexdigest() == expected
            assert hashlib.sha256((rebuilt / asset["packagedPath"]).read_bytes()).hexdigest() == expected
    summary = {"checkedSourceCells": checked_cells, "rawFieldDifferences": differences, "dateSerialsReconciledToArchivedDates": verified_date_serials, "repeatableFiles": len(expected_outputs), "repeatablePhotos": 100, "identity": prepared["identity"], "independentBaseline": "preserved workbook_analysis.json plus fresh direct XLSX parse", "nativeAcceptance": "not tested"}
    (package_dir / "evidence/T13/independent-reconciliation.json").write_bytes(encoded(summary))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--annotations", type=Path, required=True)
    parser.add_argument("--photo-treatment", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.source_dir, args.package_dir, args.annotations, args.photo_treatment), indent=2))
