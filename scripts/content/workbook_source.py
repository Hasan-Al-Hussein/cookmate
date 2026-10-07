"""Read supplied workbook values without Excel, network access or source writes."""

from pathlib import Path, PurePosixPath
from xml.etree import ElementTree
from zipfile import ZipFile
import re

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"s": MAIN}


def read_workbook(path: Path) -> dict:
    with ZipFile(path) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
            strings = ["".join(node.itertext()) for node in root.findall("s:si", NS)]
        workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
        relations = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {item.attrib["Id"]: item.attrib["Target"] for item in relations}
        sheets = {}
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            target = targets[sheet.attrib[f"{{{DOC_REL}}}id"]]
            member = target.lstrip("/") if target.startswith("/") else str(PurePosixPath("xl") / target)
            root = ElementTree.fromstring(archive.read(member))
            rows = {}
            for row in root.findall("s:sheetData/s:row", NS):
                cells = {}
                for cell in row.findall("s:c", NS):
                    address = cell.attrib["r"]
                    if cell.find("s:f", NS) is not None:
                        raise ValueError(f"Unexpected formula in source: {sheet.attrib['name']}!{address}")
                    kind = cell.attrib.get("t", "n")
                    value = cell.find("s:v", NS)
                    if kind == "inlineStr":
                        fragments = cell.findall("s:is//s:t", NS)
                        parsed = "".join(fragment.text or "" for fragment in fragments) if fragments else None
                    elif value is None or value.text is None:
                        parsed = None
                    elif kind == "s":
                        parsed = strings[int(value.text)]
                    elif kind in ("str", "e"):
                        parsed = value.text
                    elif kind == "b":
                        parsed = value.text == "1"
                    elif kind == "n":
                        parsed = int(value.text) if re.fullmatch(r"-?\d+", value.text) else float(value.text)
                    else:
                        raise ValueError(f"Unsupported source type {kind}: {address}")
                    cells[re.sub(r"\d", "", address)] = {"value": parsed, "storageType": kind, "present": True}
                rows[int(row.attrib["r"])] = cells
            sheets[sheet.attrib["name"]] = rows
        return sheets


def source_rows(sheets: dict, sheet: str, columns: str) -> list[dict]:
    result = []
    for row_number, cells in sheets[sheet].items():
        if row_number < 6:
            continue
        values = {column: cells.get(column, {"value": None, "storageType": None, "present": False}) for column in columns}
        if any(cell["value"] is not None for cell in values.values()):
            result.append({"sheet": sheet, "row": row_number, "cells": values})
    return result


def values(row: dict) -> dict:
    return {column: cell["value"] for column, cell in row["cells"].items()}
