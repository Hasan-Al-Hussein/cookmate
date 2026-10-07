"""Read-only source inventory and full-image review sheets; no source mutation."""
import hashlib
import json
from pathlib import Path
import textwrap
import zipfile
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(r"C:\Users\hp\OneDrive - ku.ac.ae\Desktop\CookMate")
OUT = ROOT / "packages/catalogue/review"
SHEETS = OUT / "inspection-sheets"
OUT.mkdir(parents=True, exist_ok=True)
SHEETS.mkdir(exist_ok=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()

manifest = json.loads((SOURCE / "records/PHOTO_MANIFEST.json").read_text(encoding="utf-8-sig"))
analysis = json.loads((SOURCE / "analysis/dataset/workbook_analysis.json").read_text(encoding="utf-8-sig"))
recipes = analysis["complete_values"]["Recipes"]
by_id = {p["recipe_id"]: p for p in manifest}
font = ImageFont.truetype(r"C:\Windows\Fonts\arial.ttf", 20)
inventory = []
for start in range(0, len(recipes), 4):
    sheet = Image.new("RGB", (1440, 1580), "white")
    draw = ImageDraw.Draw(sheet)
    number = start // 4 + 1
    for offset, recipe in enumerate(recipes[start:start+4]):
        rid = recipe["Recipe ID"]
        photo = SOURCE / "sources" / recipe["Local photo"]
        x, y = 10 + (offset % 2)*720, 10 + (offset // 2)*790
        with Image.open(photo) as im:
            im.load()
            dimensions = im.size
            # Whole frame retained. Only exceptional 698/800 px images are resized to 700 for sheets.
            display = im.convert("RGB")
            if display.size != (700, 700):
                display = display.resize((700,700), Image.Resampling.LANCZOS)
            sheet.paste(display, (x,y))
        title = f'{rid} | {recipe["Recipe name"]}'
        for line, text in enumerate(textwrap.wrap(title, width=58)):
            draw.text((x,y+707+line*24), text, fill="black", font=font)
        actual_hash = digest(photo)
        inventory.append({"recipeId":rid,"title":recipe["Recipe name"],"sourcePath":str(photo),"relativePath":recipe["Local photo"],"sha256":actual_hash,"hashMatchesManifest":actual_hash==by_id[rid]["sha256"],"width":dimensions[0],"height":dimensions[1],"bytes":photo.stat().st_size,"sourceRow":recipe["excel_row"],"originalSourceUrl":recipe["Original source URL"],"imageUrl":recipe["Original image URL"],"inspectionSheet":f"inspection-sheets/photos-{number:02d}.jpg","sheetPosition":offset+1})
    sheet.save(SHEETS / f"photos-{number:02d}.jpg", quality=96, subsampling=0)

NS = {"m":"http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
workbook = SOURCE / "sources/CookMate-Dataset.xlsx"
with zipfile.ZipFile(workbook) as archive:
    strings=[]
    if "xl/sharedStrings.xml" in archive.namelist():
        strings=["".join(item.itertext()) for item in ET.fromstring(archive.read("xl/sharedStrings.xml"))]
    rels={r.attrib["Id"]:r.attrib["Target"] for r in ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))}
    sheets={}
    for s in ET.fromstring(archive.read("xl/workbook.xml")).find("m:sheets",NS):
        target=rels[s.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
        target=target.lstrip("/") if target.startswith("/") else "xl/"+target
        cells={}
        for cell in ET.fromstring(archive.read(target)).findall(".//m:sheetData/m:row/m:c",NS):
            kind=cell.attrib.get("t")
            raw=cell.find("m:v",NS)
            value=raw.text if raw is not None else None
            if kind=="inlineStr": value="".join(cell.find("m:is",NS).itertext())
            elif kind=="s" and value is not None: value=strings[int(value)]
            cells[cell.attrib["r"]]=value
        sheets[s.attrib["name"]]=cells
targets={"53262","53064","52835","53150","53076","53230","53208","53138","52957"}
for recipe in recipes:
    row=recipe["excel_row"]
    for column,key in [("A","Recipe ID"),("B","Recipe name"),("F","Local photo"),("I","Original image URL"),("J","Original source URL")]:
        assert sheets["Recipes"].get(f"{column}{row}")==recipe[key], (row,column,key)
evidence={"sourcePath":str(workbook),"sha256":digest(workbook),"extractionMethod":"Python standard-library zipfile + xml.etree.ElementTree, read only","records":[]}
for recipe in recipes:
    rid=recipe["Recipe ID"]
    if rid not in targets: continue
    record={"recipeId":rid,"title":recipe["Recipe name"],"sheets":{}}
    for name,cells in sheets.items():
        rows=sorted({int(addr[1:]) for addr,value in cells.items() if addr.startswith("A") and value==rid})
        record["sheets"][name]=[{"row":row,"cells":{addr:value for addr,value in cells.items() if ''.join(c for c in addr if c.isdigit())==str(row)}} for row in rows]
    evidence["records"].append(record)
(OUT/"source-inventory.json").write_text(json.dumps({"workbookSha256":digest(workbook),"photoCount":len(inventory),"hashMatches":sum(p["hashMatchesManifest"] for p in inventory),"workbookPhotoIdentityJoins":len(recipes),"workbookIdentityFieldsChecked":["Recipe ID","Recipe name","Local photo","Original image URL","Original source URL"],"photos":inventory},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
(OUT/"workbook-cell-evidence.json").write_text(json.dumps(evidence,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
print(json.dumps({"photos":len(inventory),"hashMatches":sum(p["hashMatchesManifest"] for p in inventory),"sheets":len(list(SHEETS.glob('photos-*.jpg'))),"workbookSha256":digest(workbook)}))
