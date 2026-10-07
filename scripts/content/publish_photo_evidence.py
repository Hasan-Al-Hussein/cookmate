"""Publish an explicit v2 addendum while retaining the historical photo inspection."""

import argparse
import copy
import csv
import hashlib
import json
from pathlib import Path

from prepare_catalogue import CATALOGUE_VERSION, encoded, require


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def publish(package: Path, inputs_path: Path) -> dict:
    inputs = load(inputs_path)
    require(inputs["catalogueVersion"] == CATALOGUE_VERSION, "Wrong publication version")

    def bound(name: str):
        item = inputs["files"][name]
        path = inputs_path.parent / item["path"]
        require(sha(path) == item["sha256"], f"Changed publication input: {name}")
        return load(path)

    review = bound("baselinePhotoReview")
    old_audit = bound("baselineAnnotationAudit")
    old_annotations = bound("baselineAnnotations")
    old_treatment = bound("baselinePhotoTreatment")
    additions = bound("approvedAdditions")
    audit = bound("annotationAudit")
    addendum = bound("amendmentAddendum")
    annotations_path = package / "reviewed-annotations.json"
    annotations = load(annotations_path)
    treatment_path = package / "reviewed-photo-treatment.json"
    treatment = load(treatment_path)
    catalogue = load(package / "generated/catalogue.json")
    provenance = load(package / "generated/provenance.json")
    require(catalogue["identity"]["version"] == CATALOGUE_VERSION, "Catalogue version differs")
    require(catalogue["identity"]["fingerprint"] == hashlib.sha256(encoded({"provenance": provenance, "recipes": catalogue["recipes"]})).hexdigest(), "Catalogue fingerprint differs")
    require(audit["reviewStatus"] == "reviewed_static_delta", "Amendment audit is pending")
    require(audit["catalogueVersion"] == addendum["catalogueVersion"] == CATALOGUE_VERSION, "Audit version differs")
    require(audit["reviewedArtifactSha256"] == sha(annotations_path), "Annotation audit binding differs")
    require(audit["photoTreatmentSha256"] == sha(treatment_path), "Treatment audit binding differs")
    require(audit["amendmentAddendumSha256"] == inputs["files"]["amendmentAddendum"]["sha256"], "Addendum audit binding differs")
    require(audit["baselineAnnotationAuditSha256"] == inputs["files"]["baselineAnnotationAudit"]["sha256"], "Historical audit binding differs")
    require(old_audit["sourceWorkbookSha256"].lower() == provenance["sourceHashes"]["CookMate-Dataset.xlsx"], "Source workbook differs")
    for evidence in addendum["sourceEvidence"]:
        require(sha(inputs_path.parent / evidence["path"]) == evidence["sha256"], "Changed source-triage evidence")
    require(old_audit["reviewedArtifactSha256"].lower() == inputs["files"]["baselineAnnotations"]["sha256"], "Historical annotation audit differs")
    require(old_audit["photoTreatment"]["sha256"].lower() == inputs["files"]["baselinePhotoTreatment"]["sha256"], "Historical treatment audit differs")
    require(len(old_annotations) == 17 and annotations == old_annotations + additions, "Only three appended notes are approved")
    require(len(additions) == 3 and audit["annotationCount"] == len(annotations) == 20, "Annotation count differs")
    require(addendum["addedAnnotations"] == additions, "Addendum notes differ")
    require([note["annotationId"] for note in additions] == ["53389-photo-uncertainty", "53318-photo-uncertainty", "52982-ingredient-method-conflict"], "Unexpected amendment notes")
    require(all(note["kind"] == "source_gap" and note["ruleVersion"] == "reviewed-source-gaps-v1" for note in additions), "Amendment must add source gaps only")
    expected_treatment = {**old_treatment, "exceptions": old_treatment["exceptions"] + addendum["addedPhotoExceptions"]}
    require(len(addendum["addedPhotoExceptions"]) == 2 and treatment == expected_treatment, "Photo treatment delta differs")
    require(provenance["photoTreatment"] == treatment, "Prepared photo treatment differs")
    require(addendum["baselinePhotoReviewSha256"] == inputs["files"]["baselinePhotoReview"]["sha256"], "Historical photo review differs")
    recipes = {recipe["recipeId"]: recipe for recipe in catalogue["recipes"]}
    assets = {asset["recipeId"]: asset for asset in provenance["assets"]}
    photos = {photo["recipeId"]: photo for photo in review["photos"]}
    require(len(review["photos"]) == len(photos) == len(recipes) == len(assets) == 100 and set(photos) == set(recipes) == set(assets), "Incomplete or duplicate review")
    for recipe in recipes.values():
        require(recipe["annotations"] == [note for note in annotations if note["recipeId"] == recipe["recipeId"]], "Prepared annotations differ")
    treatments = {item["recipeId"]: item for item in treatment["exceptions"]}
    overrides = {item["recipeId"]: item for item in addendum["photoDispositions"]}
    require(len(addendum["photoDispositions"]) == 2 and set(overrides) == {"53389", "53318"}, "Unexpected photo disposition delta")
    rows, uncertain = [], []
    for recipe_id, recipe in recipes.items():
        photo = photos[recipe_id]
        require(photo["title"] == recipe["title"] and photo["relativePath"] == recipe["photoKey"], "Review identity differs")
        require(photo["inspection"]["fullFrameInspected"] is True, "Missing historical inspection")
        require(photo["sha256"].lower() == assets[recipe_id]["sha256"] == sha(package / assets[recipe_id]["packagedPath"]), "Reviewed photo differs")
        effective = copy.deepcopy(photo)
        if recipe_id in overrides:
            amendment = overrides[recipe_id]
            require(amendment["photoSha256"] == photo["sha256"].lower(), "Amendment photo differs")
            require(amendment["previousSemanticMatch"] == photo["semanticMatch"], "Historical disposition differs")
            effective["semanticMatch"] = amendment["semanticMatch"]
            effective["crop"]["recommendedTreatment"] = amendment["recommendedTreatment"]
        if effective["semanticMatch"]["status"] == "uncertain_photo_text_match":
            uncertain.append(recipe_id)
            frame = treatments.get(recipe_id)
            require(frame is not None and frame["preserveFullFrame"] is True, "Uncertain image requires visible treatment")
            require(any(note["annotationId"] == frame["warningAnnotationId"] and note["kind"] == "source_gap" for note in recipe["annotations"]), "Missing runtime uncertainty notice")
        rows.append({
            "recipe_id": recipe_id, "title": recipe["title"], "image_reviewed": photo["relativePath"], "sha256": photo["sha256"].lower(),
            "historical_full_frame_inspected": photo["inspection"]["fullFrameInspected"],
            "historical_individual_original_followup": photo["inspection"]["individualOriginalViewed"],
            "historical_inspection_sheet": photo["inspection"]["contactSheet"], "historical_inspection_position": photo["inspection"]["sheetPosition"],
            "historical_result": photo["semanticMatch"]["status"], "result": effective["semanticMatch"]["status"],
            "disposition_basis": "source-amendment-addendum.v2" if recipe_id in overrides else "historical_photo_review.v1",
            "observation": effective["semanticMatch"]["observation"], "uncertainty": effective["semanticMatch"]["limits"],
            "visible_credit": photo["watermark"]["text"] or "", "other_visible_text": photo["otherVisibleText"] or "",
            "quality_observation": photo["quality"]["observation"], "crop_caveat": photo["crop"]["caveat"],
            "disposition": effective["crop"]["recommendedTreatment"], "native_display_tested": False, "rights_clearance": "not assessed",
        })
    require(set(uncertain) == {"53208", "53230", "53389", "53318"}, "Unexpected uncertainty coverage")
    publication = {
        "catalogue": catalogue["identity"], "publicationInputsSha256": sha(inputs_path),
        "reviewFileSha256": inputs["files"]["baselinePhotoReview"]["sha256"], "recipeCount": len(rows),
        "uncertainRecipeIds": uncertain, "historicalReviewer": review["reviewer"],
        "leadDisposition": "Retain the historical all-100 inspection with its original limits. Apply only the two photo dispositions from the versioned source-triage addendum. Three appended source notes were checked as a static delta; no fresh all-100/full-size inspection or culinary verification is claimed.",
        "annotationAudit": {"count": 20, "sha256": sha(annotations_path), "auditFileSha256": inputs["files"]["annotationAudit"]["sha256"]},
        "amendmentAddendumSha256": inputs["files"]["amendmentAddendum"]["sha256"],
        "freshAll100Inspection": False, "nativeAcceptance": False, "rightsClearance": False,
    }
    output = package / "evidence/T14"
    output.mkdir(parents=True, exist_ok=True)
    with (output / "all-100-photo-review.v2.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    (output / "photo-review-publication.v2.json").write_bytes(encoded(publication))
    return publication


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-dir", type=Path, required=True)
    parser.add_argument("--publication-inputs", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(publish(args.package_dir, args.publication_inputs), indent=2))
