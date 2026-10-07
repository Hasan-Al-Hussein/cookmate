"""Deterministically prepare immutable CookMate source data; never writes inputs."""

import argparse
from collections import Counter
from datetime import datetime, timedelta
import hashlib
import json
from pathlib import Path
import re
import shutil

from workbook_source import read_workbook, source_rows, values

RULE_VERSION = "source-preparation-v1"
CATALOGUE_VERSION = "cookmate-2026-09-28.v2"
DEFAULT_ANNOTATIONS = Path(__file__).resolve().parents[2] / "packages/catalogue/reviewed-annotations.json"
DEFAULT_PHOTO_TREATMENT = Path(__file__).resolve().parents[2] / "packages/catalogue/reviewed-photo-treatment.json"
EXPECTED_COUNTS = {"Recipes": 100, "Ingredients": 960, "Instructions": 706}
HEADERS = {
    "Recipes": ["Recipe ID", "Recipe name", "Category", "Cuisine / area", "Ingredient entries", "Local photo", "Tags", "Recipe page", "Original image URL", "Original source URL", "Video URL", "Fetched UTC"],
    "Ingredients": ["Recipe ID", "Recipe name", "Position", "Ingredient", "Measure"],
    "Instructions": ["Recipe ID", "Recipe name", "Passage", "Cooking instructions"],
}


def encoded(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_digest(path: Path) -> str:
    return digest(path.read_bytes())


def fetched_utc(serial: float) -> str:
    # This source column is labelled UTC. Raw Excel serials remain in source-records.
    instant = datetime(1899, 12, 30) + timedelta(milliseconds=round(serial * 86400000))
    return instant.isoformat(timespec="seconds") + "Z"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def check_hash(path: Path, expected: str) -> str:
    actual = file_digest(path)
    require(actual == expected.lower(), f"Source hash mismatch: {path.name}")
    return actual


def prepare(source_dir: Path, output_dir: Path, annotations_path: Path | None = None, photo_treatment_path: Path | None = None) -> dict:
    immutable_root = (source_dir / "sources").resolve()
    resolved_output = output_dir.resolve()
    require(resolved_output != immutable_root and immutable_root not in resolved_output.parents, "Derived output must not be written into immutable sources")
    source_manifest = json.loads((source_dir / "records/SOURCE_MANIFEST.json").read_text(encoding="utf-8-sig"))
    photo_manifest = json.loads((source_dir / "records/PHOTO_MANIFEST.json").read_text(encoding="utf-8-sig"))
    source_hashes = {entry["file"]: check_hash(source_dir / "sources" / entry["file"], entry["sha256"]) for entry in source_manifest}
    workbook = read_workbook(source_dir / "sources/CookMate-Dataset.xlsx")
    records = {}
    for sheet, headers in HEADERS.items():
        columns = "ABCDEFGHIJKL"[:len(headers)]
        require([workbook[sheet][5][column]["value"] for column in columns] == headers, f"Changed {sheet} headers")
        records[sheet] = source_rows(workbook, sheet, columns)
        require(len(records[sheet]) == EXPECTED_COUNTS[sheet], f"Changed {sheet} count")
    recipes = []
    by_id = {}
    for row in records["Recipes"]:
        raw = values(row)
        recipe_id = raw["A"]
        require(isinstance(recipe_id, str) and re.fullmatch(r"\d+", recipe_id) is not None, "Invalid string recipe ID")
        require(recipe_id not in by_id, f"Duplicate recipe {recipe_id}")
        require(raw["F"] == f"photos/{recipe_id}.jpg", f"Unexpected source photo path for {recipe_id}")
        recipe = {"recipeId": recipe_id, "title": raw["B"], "category": raw["C"], "cuisine": raw["D"], "rawTags": raw["G"], "photoKey": raw["F"], "recipePage": raw["H"], "originalSourceUrl": raw["J"], "videoUrl": raw["K"], "ingredients": [], "instructions": [], "annotations": []}
        recipes.append(recipe)
        by_id[recipe_id] = recipe
    for sheet in ("Ingredients", "Instructions"):
        for row in records[sheet]:
            raw = values(row)
            recipe = by_id.get(raw["A"])
            require(recipe is not None, f"Orphan at {sheet}!A{row['row']}")
            require(raw["B"] == recipe["title"], f"Title mismatch at {sheet}!B{row['row']}")
            source = {"sheet": sheet, "row": row["row"], "column": "D"}
            if sheet == "Ingredients":
                recipe["ingredients"].append({"recipeId": raw["A"], "position": raw["C"], "rawName": raw["D"], "rawMeasure": raw["E"], "source": source})
            else:
                is_heading = re.fullmatch(r"(?:step\s*)?\d+[.:]?", raw["D"].strip(), re.IGNORECASE) is not None
                recipe["instructions"].append({"recipeId": raw["A"], "sequence": raw["C"], "rawText": raw["D"], "presentation": "heading" if is_heading else "passage", "source": source})
    for recipe, row in zip(recipes, records["Recipes"], strict=True):
        require(len(recipe["ingredients"]) == values(row)["E"], f"Ingredient count mismatch: {recipe['recipeId']}")
        for field, position in (("ingredients", "position"), ("instructions", "sequence")):
            require([entry[position] for entry in recipe[field]] == list(range(1, len(recipe[field]) + 1)), f"Noncontiguous {field}: {recipe['recipeId']}")
    heading_count = sum(p["presentation"] == "heading" for r in recipes for p in r["instructions"])
    require(heading_count == 124, f"Heading count changed: {heading_count}")
    unknown_measures = [entry["source"]["row"] for recipe in recipes for entry in recipe["ingredients"] if entry["rawMeasure"] is None or entry["rawMeasure"] == ""]
    require(unknown_measures == [22, 512, 565, 567, 568, 569], "Unknown measure positions changed")
    if annotations_path is None and DEFAULT_ANNOTATIONS.exists():
        annotations_path = DEFAULT_ANNOTATIONS
    annotations = [] if annotations_path is None else json.loads(annotations_path.read_text(encoding="utf-8-sig"))
    annotation_ids = set()
    for annotation in annotations:
        recipe_id = annotation["recipeId"]
        require(recipe_id in by_id, "Orphan annotation")
        require(annotation["annotationId"] not in annotation_ids, "Duplicate annotation ID")
        annotation_ids.add(annotation["annotationId"])
        for locator in annotation["evidence"]:
            row = next((item for item in records[locator["sheet"]] if item["row"] == locator["row"]), None)
            require(row is not None and values(row)["A"] == recipe_id, f"Annotation evidence belongs to another recipe: {annotation['annotationId']}")
            if "column" in locator:
                require(locator["column"] in row["cells"], "Unknown annotation evidence column")
        by_id[recipe_id]["annotations"].append(annotation)
    assets = []
    require(len(photo_manifest) == 100, "Photo manifest count changed")
    photo_ids = set()
    for entry in photo_manifest:
        recipe_id = entry["recipe_id"]
        require(recipe_id in by_id and recipe_id not in photo_ids, "Orphan or duplicated photo mapping")
        photo_ids.add(recipe_id)
        require(entry["relative_path"] == by_id[recipe_id]["photoKey"], "Photo path mismatch")
        path = source_dir / "sources" / entry["relative_path"]
        asset_hash = check_hash(path, entry["sha256"])
        assets.append({"recipeId": recipe_id, "photoKey": entry["relative_path"], "packagedPath": "assets/" + entry["relative_path"], "sha256": asset_hash, "bytes": path.stat().st_size})
    require(photo_ids == set(by_id), "Missing photo mapping")
    if photo_treatment_path is None and DEFAULT_PHOTO_TREATMENT.exists():
        photo_treatment_path = DEFAULT_PHOTO_TREATMENT
    photo_treatment = {"ruleVersion": "photo-treatment-v1", "exceptions": []} if photo_treatment_path is None else json.loads(photo_treatment_path.read_text(encoding="utf-8-sig"))
    require(photo_treatment["ruleVersion"] == "photo-treatment-v1", "Unsupported photo treatment rule")
    treatment_ids = set()
    for treatment in photo_treatment["exceptions"]:
        recipe_id = treatment["recipeId"]
        require(recipe_id in by_id and recipe_id not in treatment_ids, "Orphan or duplicate photo treatment")
        require(set(treatment) == {"recipeId", "preserveFullFrame", "warningAnnotationId", "creditAnnotationId"}, "Unexpected photo treatment field")
        require(isinstance(treatment["preserveFullFrame"], bool), "Invalid photo framing rule")
        treatment_ids.add(recipe_id)
        for field in ("warningAnnotationId", "creditAnnotationId"):
            annotation_id = treatment[field]
            require(annotation_id is None or any(note["annotationId"] == annotation_id and note["kind"] == "source_gap" for note in by_id[recipe_id]["annotations"]), "Photo note must reference this recipe's source-gap annotation")
    raw_records = {"ruleVersion": RULE_VERSION, "workbookSha256": source_hashes["CookMate-Dataset.xlsx"], "sheets": records}
    recipe_sources = [{"recipeId": values(row)["A"], "source": {"sheet": "Recipes", "row": row["row"]}, "originalImageUrl": values(row)["I"], "fetchedUtc": fetched_utc(values(row)["L"]), "declaredIngredientEntries": values(row)["E"]} for row in records["Recipes"]]
    provenance = {"ruleVersion": RULE_VERSION, "sourceHashes": source_hashes, "sourceRecordsSha256": digest(encoded(raw_records)), "assets": assets, "recipeSources": recipe_sources, "photoTreatment": photo_treatment}
    fingerprint = digest(encoded({"provenance": provenance, "recipes": recipes}))
    catalogue = {"identity": {"version": CATALOGUE_VERSION, "fingerprint": fingerprint}, "recipes": recipes}
    repeated = []
    for recipe in recipes:
        counts = Counter((entry["rawName"], entry["rawMeasure"]) for entry in recipe["ingredients"])
        repeated.extend({"recipeId": recipe["recipeId"], "rawName": pair[0], "rawMeasure": pair[1], "count": count} for pair, count in counts.items() if count > 1)
    report = {"ruleVersion": RULE_VERSION, "identity": catalogue["identity"], "sourceHashes": source_hashes, "counts": {**{sheet: len(rows) for sheet, rows in records.items()}, "photos": len(assets), "headingOnlyPassages": heading_count, "annotations": len(annotations)}, "unknownMeasureRows": unknown_measures, "repeatedIngredientPairsPreserved": repeated, "recipeIdsInSourceOrder": list(by_id), "rawFieldDifferences": [], "orphanIds": [], "sourceWrites": False, "nativeAcceptance": "not tested"}
    outputs = {"generated/catalogue.json": catalogue, "generated/provenance.json": provenance, "evidence/T13/source-records.json": raw_records, "evidence/T13/source-to-derived-reconciliation.json": report, "evidence/T13/asset-path-manifest.json": assets}
    # Build and validate every record before publishing any derivative.
    for relative, content in outputs.items():
        destination = output_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(encoded(content))
    for asset in assets:
        destination = output_dir / asset["packagedPath"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_dir / "sources" / asset["photoKey"], destination)
        require(file_digest(destination) == asset["sha256"], "Packaged image hash mismatch")
    photo_module = "// Generated by scripts/content/prepare_catalogue.py. Keep literal imports for Metro.\n"
    photo_module += "export const recipePhotoAssets: Readonly<Record<string, number>> = Object.freeze({\n"
    photo_module += "".join(f"  '{entry['recipeId']}': require('../{entry['packagedPath']}') as number,\n" for entry in assets)
    photo_module += "});\n"
    (output_dir / "src").mkdir(parents=True, exist_ok=True)
    (output_dir / "src/photo-assets.ts").write_text(photo_module, encoding="utf-8", newline="\n")
    for entry in source_manifest:
        check_hash(source_dir / "sources" / entry["file"], entry["sha256"])
    for entry in photo_manifest:
        check_hash(source_dir / "sources" / entry["relative_path"], entry["sha256"])
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[2] / "packages/catalogue")
    parser.add_argument("--annotations", type=Path)
    parser.add_argument("--photo-treatment", type=Path)
    args = parser.parse_args()
    report = prepare(args.source_dir, args.output_dir, args.annotations, args.photo_treatment)
    print(json.dumps({"identity": report["identity"], "counts": report["counts"]}, indent=2))


if __name__ == "__main__":
    main()
