"""Package manually observed source evidence. Does not infer observations from pixels."""
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/"packages/catalogue/review"
def read(path): return json.loads(path.read_text(encoding="utf-8-sig"))
def save(name,value): (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest().upper()
inventory=read(OUT/"source-inventory.json")
workbook=read(OUT/"workbook-cell-evidence.json")
records={r["recipeId"]:r for r in workbook["records"]}
with (OUT/"visual-observations.tsv").open(encoding="utf-8",newline="") as source:
    observations=list(csv.DictReader(source,delimiter="\t"))
assert len(observations)==100 and len({r["recipeId"] for r in observations})==100
notes={r["recipeId"]:r for r in observations}
assert set(notes)=={r["recipeId"] for r in inventory["photos"]}
assert all(r["hashMatchesManifest"] for r in inventory["photos"])
individual={"53262","53281","53289","53260","53230","53208","52831","53025","52896","53030","53389","53011","53053","53006","53092","52968","52982"}
uncertain={"53230","53208"}
coarse={"53281","53289","53260"}
background={
    "52831":"Printed placemat/product advertising is visible below the wooden board; no overlaid photo credit was observed.",
    "53025":"Small printed text lies on paper underneath the food on the tray; no overlaid photo credit was observed.",
    "52896":"Branded condiment/drink labels, including HP and Colman's, are physically present behind the plate; these are scene content, not a photo-credit finding.",
    "53030":"Partial printed lettering appears on a background mat/menu at right; no overlaid photo credit was observed."
}
photos=[]
for item in inventory["photos"]:
    rid=item["recipeId"]
    note=notes[rid]
    watermark={"status":"not_observed","text":None,"location":None,"limit":"No visible overlaid photo credit observed at the recorded inspection scale; this is not proof of absence or rights clearance."}
    if rid=="53262":
        watermark={"status":"observed","text":"© CHILI TO CHOC","location":"lower right, approximately x 552–665 and y 627–640 in the 700 by 700 original","limit":"Visible credit only; authorship, reuse rights and publisher relationship were not established."}
    photo={k:item[k] for k in ["recipeId","title","sourcePath","relativePath","sha256","width","height","bytes"]}
    photo.update({
        "inspection":{"contactSheet":item["inspectionSheet"],"sheetPosition":item["sheetPosition"],"fullFrameInspected":True,"individualOriginalViewed":rid in individual,"contactSheetPanelPx":[700,700],"sourceScaledForContactSheet":(item["width"],item["height"])!=(700,700)},
        "semanticMatch":{"status":"uncertain_photo_text_match" if rid in uncertain else "broadly_consistent","observation":note["observation"],"limits":note["matchLimit"]},
        "watermark":watermark,
        "otherVisibleText":background.get(rid),
        "quality":{"observation":note["qualityObservation"],"prominentPixelation":rid in coarse,"nativeDisplayTested":False},
        "crop":{"caveat":note["cropCaveat"],"recommendedTreatment":"preserve_full_frame_with_notice" if rid in uncertain else "preserve_full_frame_and_credit" if rid=="53262" else "review_proposed_crop_against_full_frame","status":"visual_recommendation_not_native_acceptance"},
        "provenance":{"workbookSheet":"Recipes","workbookRow":item["sourceRow"],"photoPathCell":f'F{item["sourceRow"]}',"originalImageUrlCell":f'I{item["sourceRow"]}',"recipePublisherUrlCell":f'J{item["sourceRow"]}',"originalImageUrl":item["imageUrl"],"recipePublisherUrl":item["originalSourceUrl"],"hashMatchesManifest":item["hashMatchesManifest"],"rightsStatus":"not_assessed"}
    })
    photos.append(photo)

def cell(rid,sheet,address):
    return next(row["cells"][address] for row in records[rid]["sheets"][sheet] if address in row["cells"])
def ingredient_evidence(rid):
    return [{"sheet":"Ingredients","ingredientCell":f'D{r["row"]}',"ingredient":r["cells"].get(f'D{r["row"]}'),"measureCell":f'E{r["row"]}',"measure":r["cells"].get(f'E{r["row"]}')} for r in records[rid]["sheets"]["Ingredients"]]
def source_cell(rid,sheet,address,excerpt=None):
    value=cell(rid,sheet,address)
    if excerpt is not None: assert excerpt in value
    return {"sheet":sheet,"cell":address,"value":value if excerpt is None else excerpt,"isExcerpt":excerpt is not None}

findings=[]
def finding(aid,rid,kind,description,evidence,amount=None,disposition="review_notice_only_preserve_source"):
    findings.append({"candidateId":aid,"recipeId":rid,"title":records[rid]["title"],"kind":kind,"description":description,"evidence":evidence,"structuredIngredients":ingredient_evidence(rid),"sourceAmountText":amount,"recommendedDisposition":disposition,"changesToOriginal":False})

for rid,aid,address,excerpt,amount,description in [
    ("53262","53262-instruction-only-salt","D7","1½ tsp flaky sea salt","1½ tsp flaky sea salt","Salt is positively instructed with an explicit prose quantity, but none of the five structured ingredient rows names salt."),
    ("53150","53150-instruction-only-salt","D466","season with some sea salt","some sea salt","Salt is positively instructed but absent from both structured rows. The prose amount is nonspecific."),
    ("53064","53064-instruction-only-salt","D327","seasoning (salt and black pepper)",None,"Salt is used in pasta water and seasoning in the sole method passage, but absent from all six structured rows. No exact salt amount appears there."),
    ("52835","52835-instruction-only-salt","D330","2 tsp salt","2 tsp salt","Salt is instructed for pasta water with an explicit prose quantity but absent from all seven structured rows. The earlier D329 prohibition applies only at that earlier stage."),
    ("52835","52835-instruction-only-black-pepper","D329","a good grinding of black pepper","a good grinding","Black pepper is positively instructed but absent from all seven structured rows. The prose amount is nonspecific."),
    ("53230","53230-instruction-only-salt","D499","a large pinch of salt","a large pinch","Salt is positively instructed in the batter but absent from all ten structured rows. Do not convert the phrase to a numeric amount.")
]:
    term="black pepper" if "black-pepper" in aid else "salt"
    assert all(term not in e["ingredient"].lower() for e in ingredient_evidence(rid))
    evidence=[source_cell(rid,"Instructions",address,excerpt)]
    if aid=="53064-instruction-only-salt": evidence.append(source_cell(rid,"Instructions","D327","boiling water and salt"))
    if aid=="52835-instruction-only-salt": evidence.append(source_cell(rid,"Instructions","D329","don’t add any salt at this stage"))
    finding(aid,rid,"instruction_only_ingredient",description,evidence,amount,"review_notice_and_unquantified_review_demand_per_DEC10; preserve_exact_prose_amount")
assert cell("52835","Ingredients","D519")=="Parsley"
finding("52835-alternative-garnish","52835","alternative_not_omission","Parsley is present. Chives is an offered alternative, not an instruction to buy both garnishes.",[source_cell("52835","Instructions","D331","Sprinkle over some chives or parsley"),source_cell("52835","Ingredients","D519"),source_cell("52835","Ingredients","E519")],"some chives or parsley","optional_alternative_notice; no_mandatory_chives_or_extra_parsley_demand")
assert len(records["53076"]["sheets"]["Instructions"])==1
finding("53076-limited-instructions","53076","limited_instructions","The sole supplied instruction is Make and enjoy; it does not supply a usable cooking method. The photo cannot fill this gap.",[source_cell("53076","Instructions","D149"),source_cell("53076","Recipes","J27"),source_cell("53076","Recipes","K27")])
finding("53262-image-credit-distinction","53262","photo_provenance_uncertainty","Original photo visibly bears © CHILI TO CHOC at lower right; recipe publisher link is BBC Good Food. Retain both facts. This does not establish licensing or resolve authorship.",[source_cell("53262","Recipes","F6"),source_cell("53262","Recipes","I6"),source_cell("53262","Recipes","J6"),{"sourcePhoto":"photos/53262.jpg","visualObservation":"© CHILI TO CHOC at lower right","originalViewed":True}],disposition="preserve_full_frame_credit_and_separate_attribution; rights_unresolved")
finding("53230-photo-uncertainty","53230","photo_text_uncertainty","The image shows unbattered-looking green broccoli with sliced garnish. The supplied method describes battering and frying, so association remains uncertain. Do not replace the image or infer garnish ingredients.",[source_cell("53230","Recipes","F82"),source_cell("53230","Recipes","I82"),source_cell("53230","Instructions","D499"),source_cell("53230","Instructions","D501"),{"sourcePhoto":"photos/53230.jpg","originalViewed":True}],disposition="preserve_full_frame_with_uncertainty_notice; no_photo_inferred_ingredients")
finding("53208-photo-uncertainty","53208","photo_text_uncertainty","The image has curled segmented orange prawn-like forms. The recipe is titled Thai coconut & veg broth and categorized Vegetarian, and none of its 13 structured ingredients names prawns/shrimp. This is an association concern, not an ingredient addition or a dietary judgment.",[source_cell("53208","Recipes","B99"),source_cell("53208","Recipes","C99"),source_cell("53208","Recipes","I99"),{"sourcePhoto":"photos/53208.jpg","originalViewed":True}],disposition="preserve_full_frame_with_uncertainty_notice; no_photo_inferred_ingredients")

manual_audit={f["candidateId"]:f["description"] for f in findings}
missing=[("53138","53138-missing-measure-7","E22","D22"),("53064","53064-missing-measure-6","E512","D512"),("52957","52957-missing-measure-4","E565","D565"),("52957","52957-missing-measure-6","E567","D567"),("52957","52957-missing-measure-7","E568","D568"),("52957","52957-missing-measure-8","E569","D569")]
for rid,aid,measure,ingredient in missing:
    assert cell(rid,"Ingredients",measure) is None
    manual_audit[aid]=f'Independent XML read found {ingredient} = {cell(rid,"Ingredients",ingredient)!r}, with {measure} blank; note preserves missing rather than zero.'

annotation_path=ROOT/"packages/catalogue/reviewed-annotations.json"
annotation_hash=digest(annotation_path)
annotations=read(annotation_path)
assert set(a["annotationId"] for a in annotations)==set(manual_audit)
audited=[]
for annotation in annotations:
    rid=annotation["recipeId"]
    locators=[]
    for e in annotation["evidence"]:
        address=f'{e["column"]}{e["row"]}'
        value=cell(rid,e["sheet"],address)
        assert cell(rid,e["sheet"],f'A{e["row"]}')==rid
        locators.append({"sheet":e["sheet"],"cell":address,"sourceValue":value})
    audited.append({"annotationId":annotation["annotationId"],"recipeId":rid,"noteReviewed":annotation["note"],"conclusion":"supported_with_stated_limits","reason":manual_audit[annotation["annotationId"]],"evidenceCellsChecked":locators})
assert digest(annotation_path)==annotation_hash
photo_treatment_path=ROOT/"packages/catalogue/reviewed-photo-treatment.json"
treatment=read(photo_treatment_path)
assert {e["recipeId"] for e in treatment["exceptions"]}=={"53262","53230","53208"}
assert all(e["preserveFullFrame"] for e in treatment["exceptions"])
now=datetime.now(timezone.utc).isoformat()
limits=[
    "Visual review supports broad photo/title consistency only, not culinary authenticity, hidden ingredients, species, dietary safety, quantities, servings, taste, cooking correctness or source authorship.",
    "100 full frames were inspected through 25 labeled 2x2 contact sheets with 700px panels. Contact sheets are JPEG inspection derivatives, not delivery assets; 17 selected original files were also opened directly with view_image at original detail.",
    "No other photo-credit watermark was observed beyond 53262; faint or embedded marks could be missed. Visible background/product print is separately recorded. No rights clearance was performed.",
    "Crop comments are visual/geometry recommendations. No app/native image layout, iPhone crop, accessibility or playback was tested.",
    "Workbook checks cover the assigned/added candidates and six known missing measures; this is not an exhaustive all-recipe ingredient-versus-method audit.",
    "Original source files were not edited. Similar titles, IDs, repetitions and original measures remain source facts; review notices are separate recommendations or audited lead-owned annotations."
]
save("photo-review.v1.json",{"schemaVersion":"cookmate-photo-review-v1","generatedAtUtc":now,"reviewer":"source_photo_review specialist","reviewStatus":"all_100_visually_reviewed_with_findings","sourceWorkbook":workbook["sourcePath"],"sourceWorkbookSha256":workbook["sha256"],"photoManifest":"C:\\Users\\hp\\OneDrive - ku.ac.ae\\Desktop\\CookMate\\records\\PHOTO_MANIFEST.json","checks":{"fullFramesInspected":100,"individualOriginalsViewed":len(individual),"individualOriginalIds":sorted(individual),"photoHashesMatched":inventory["hashMatches"],"workbookPhotoIdentityJoins":inventory["workbookPhotoIdentityJoins"],"uniqueRecipeIds":100,"contactSheetsInspected":25,"uncertainPhotoTextIds":sorted(uncertain),"visiblePhotoCreditIds":["53262"],"prominentPixelationIds":sorted(coarse),"nativeAcceptance":False,"rightsClearance":False},"limits":limits,"photos":photos})
save("source-annotation-candidates.v1.json",{"schemaVersion":"cookmate-source-candidates-v1","generatedAtUtc":now,"sourceWorkbook":workbook["sourcePath"],"sourceWorkbookSha256":workbook["sha256"],"status":"source_checked_candidates; publication_owned_by_lead","findings":findings,"limits":limits})
save("published-annotation-audit.v1.json",{"schemaVersion":"cookmate-annotation-audit-v1","generatedAtUtc":now,"reviewedArtifact":str(annotation_path),"reviewedArtifactSha256":annotation_hash,"annotationCount":len(audited),"sourceWorkbookSha256":workbook["sha256"],"result":"17 annotation texts and their supplied cell locators supported by the bounded source/visual review; no material textual correction identified","annotations":audited,"photoTreatment":{"path":str(photo_treatment_path),"sha256":digest(photo_treatment_path),"exceptionsChecked":["53262","53230","53208"],"conclusion":"Declared full-frame exceptions align with findings; actual native rendering untested."},"limits":limits})
assert all(digest(Path(p["sourcePath"]))==p["sha256"] for p in photos)
assert digest(Path(workbook["sourcePath"]))==workbook["sha256"]
save("review-validation.json",{"generatedAtUtc":now,"counts":{"records":len(photos),"uniqueIds":len({p["recipeId"] for p in photos}),"annotationCandidates":len(findings),"auditedPublishedAnnotations":len(audited)},"sourceHashesUnchangedAfterReview":True,"jsonRoundTripFiles":["photo-review.v1.json","source-annotation-candidates.v1.json","published-annotation-audit.v1.json"],"visualEvidenceActuallyOpened":{"contactSheets":25,"individualOriginals":sorted(individual)},"commands":["bundled Python scripts/content/review/inspect_sources.py","functions view_image: inspection-sheets/photos-01.jpg through photos-25.jpg with detail original","functions view_image: 17 original photos listed in individualOriginalIds with detail original","bundled Python scripts/content/review/build_review.py"],"nativeTestsRun":False})
for name in ["photo-review.v1.json","source-annotation-candidates.v1.json","published-annotation-audit.v1.json"]: read(OUT/name)
print(json.dumps({"photoRecords":len(photos),"individualOriginalViews":len(individual),"sourceCandidates":len(findings),"annotationsAudited":len(audited),"hashesUnchanged":True}))
