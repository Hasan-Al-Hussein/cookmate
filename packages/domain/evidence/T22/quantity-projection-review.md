# T22 quantity and shopping-projection review

28 September 2026. **No concrete defect was established in the assigned pure quantity/projection slice.** Nine targeted tests passed. A separate workbook/Python rational-arithmetic oracle matched the complete output for one and two occurrences of every source recipe. No production/test file was changed.

## Scope and policy

Reviewed `packages/domain/src/quantities.ts`, `shoppingProjection.ts`, and their two test files. The adopted conservative policy is the reference: complete supported measures only; lexical unit aliases but no unit conversions or serving inference; all 960 ingredient rows and six reviewed instruction-only demands retained; only the 17 explicitly reviewed case collisions merge; a different contributing occurrence resets purchase state even when totals match.

SQL projection adapters, plan/shopping commands, factory composition, UI presentation and native acceptance were excluded. The 100- and 200-occurrence selections below are synthetic verification fixtures, not a recommended meal plan or user state.

## Checks actually run

From the code root:

```powershell
.\node_modules\.bin\tsx.cmd --test packages/domain/test/quantities.test.ts packages/domain/test/shoppingProjection.test.ts
```

Observed **9 passed, 0 failed**. The existing tests cover complete/ambiguous measure grammar, exact compatible arithmetic, incompatible-unit rejection, case grouping, all-source contribution coverage, repeated rows, occurrence identity, purchase preservation/reset, copying before asynchronous hashing, and invalid selected/source inputs.

Additional checks used bounded stdin scripts through the bundled Python runtime and `node --import tsx --input-type=module -`. No installs, servers, persistent fixtures or extra report files were created.

## Independent source oracle

The oracle opened the preserved XLSX directly with Python stdlib ZIP/XML, decoded its shared strings, and read Ingredients A/C/D/E on rows 6–965. For all **960** rows, recipe ID/position, exact raw name, raw measure (including six absent cells) and source row matched the generated catalogue. The workbook hash also matched the earlier verified source hash.

The oracle did not import either reviewed module. It used Python `Fraction` for integers, decimal strings and fractions; Unicode fraction decomposition supplied exact digits without a floating-point numeric conversion. Its unit table was independently restricted to supported suffixes actually present in this workbook. Group membership came from workbook names/measures, and the six already reviewed annotation demands were explicitly listed. Source case collisions were derived independently and compared with the implementation's 17-key allowlist.

For deterministic occurrence IDs, the oracle independently rebuilt each contribution, exact group total, label, group key and demand fingerprint, using Python SHA-256 and the declared serialization. Node then hashed the actual entire projection JSON. **The complete hashes match**, so this comparison covered individual raw values and membership as well as counts and arithmetic.

| Fixture | Groups | Contributions | Exact | Unparsed | Unknown | Review source | Full projection SHA-256 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| One occurrence per recipe | 601 | 966 | 673 | 281 | 6 | 6 | 247223fe7ca51dc676537f10a3d60b2173ed9c256a3892af5d627b3b732bd830 |
| Two occurrences per recipe | 601 | 1,932 | 1,346 | 562 | 12 | 12 | aefbd43656e2c4431234ad651fed4499699d6c202c52f8f0b99ef9ad0be399c5 |

The reviewed case keys were exactly: brown sugar, cayenne pepper, chilli, cinnamon stick, coconut cream, cornstarch, garlic, ground ginger, lemon, minced garlic, olive oil, plum tomatoes, soy sauce, spring onions, tamarind paste, vegetable oil and water. No additional source case collision was silently merged.

The six instruction-only demands remain `review_source`, with null raw measures: 53262 flaky sea salt; 53064 salt; 52835 salt and black pepper; 53150 sea salt; 53230 salt. This intentionally preserves the adopted review policy even where the instruction prose contains a quantity. Photo/source-gap notes are not shopping ingredients.

The six unknown measures remain attached to their actual ingredient positions: 53138/7 Dulce de leche, 53064/6 Black Pepper, and 52957/4 Flour, /6 Strawberries, /7 Raspberries, /8 Blackberries. No amount was supplied by the parser.

## Concrete source arithmetic and adversarial probes

The six Baking Powder entries are Ingredients E36 = 3 tsp, E159 = 1 tsp, E311 = 3/4 teaspoon, E408 = 1 tsp, E409 = 1 tsp, and E920 = 2 tsp. Exact sum: **8.75 tsp**, retaining all six contributions. E408 and E409 are separate positions 8 and 9 of recipe 53320; neither was deduplicated. With two occurrences per recipe, the same group has **17.5 tsp and 12 contributions**.

Other repeated-source cases remained distinct: recipe 53320 Butter at E401/E412 sums 150g + 100g while retaining both positions; recipe 53103 Coriander at E80/E86 keeps 1/2 tsp separate from Bunch; recipe 52928 Sugar at E89/E97 keeps 1/2 cup separate from garnish. The complete oracle comparison includes these cases.

Additional assertion probes established:

- 1/7 cup + 1/3 cup = `10/21 cup`.
- 0.0001 g + 0.0002 g = `3/10000 g`, without rounding.
- 9007199254740993 g + 1g = `9007199254740994 g`, beyond JavaScript's safe integer range but exact through BigInt.
- Seven ambiguous/malformed values stay unparsed: `1kg + 100g`, `1/2-3/4 cup`, `1 (400g) can`, `1 2/2 tbsp`, `1/0 cup`, `NaN g`, `Infinity g`.
- Replacing **all 100 occurrence IDs** while retaining recipes and quantities preserves all 601 group keys/labels but changes all 601 demand fingerprints. Starting from purchased=true/revision=7, every reconciliation returned purchased=false, changed=true, revision=8.
- Changed demand at the maximum safe purchase revision throws rather than overflowing.
- Existing tests additionally verify unchanged demand retains purchase state, inactive/re-added demand resets it, and a related new group is marked changed.

Unsupported raw measures remain source-attributed text; identical unparsed text may share a group, but every occurrence/source-row contribution remains present. This review does not infer a numeric total from those text labels.

## Limits

The oracle exhaustively checks the current preserved ingredient corpus and six adopted annotation demands; it is not an exhaustive proof for every possible future Unicode or measure string. The mathematical oracle is independent of production parsing/summing, while serialization deliberately follows the documented group/fingerprint structure to make the complete output comparable.

No nutritional, culinary, serving, density or unit-conversion correctness is asserted. The review does not validate SQL persistence of projections, migration of purchased state, UI indication of repeated unparsed demands, or native performance. Those concerns require their own integrated evidence. No factory or native acceptance claim follows from this result.

## Stable hashes

SHA-256 values were captured before and after the checks and remained identical:

| Source | SHA-256 |
| --- | --- |
| packages/domain/src/quantities.ts | 1EBD8C09D72CD4DE9564D23656D0447D7B5034083FF2825EE4A6B3032E676A95 |
| packages/domain/src/shoppingProjection.ts | 9B47CA35546CB86DF0955D539A0BB02C9893C61B2C23CFA0CCC5C3EA56685180 |
| packages/domain/test/quantities.test.ts | C5C227FE85494BED9849B333016CD0944502B0720EAB764331AC54FD5B9C2CC2 |
| packages/domain/test/shoppingProjection.test.ts | 69DFE42438D92BF465133253F84D95B082692D19EF7E404DF7D1681A9945E4EB |
| packages/catalogue/generated/catalogue.json | F153EB9E31928233602109A2CBAE5D7598475D7DC5F641D9B47074FAC8062193 |
| Desktop/CookMate/sources/CookMate-Dataset.xlsx | C30B9AD983A0CDE05F3263A088D0B9A640AFCC5ACFF9B1FCA8515A1E8FAFFE65 |

## Reproducible oracle

The following is the actual independent Python oracle body. Run from the code root using the bundled Python runtime; it prints evidence only. It does not write files. For the two-occurrence fixture, immediately before `grouped=defaultdict(list)`, deep-copy `contributions`, replace the leading `00000000-` with `11111111-` in both occurrence and contribution IDs, and append those copies.

```python
import zipfile,xml.etree.ElementTree as E,json,re,hashlib,unicodedata
from fractions import Fraction
from collections import defaultdict,Counter
from decimal import Decimal,localcontext
from pathlib import Path
source=Path(r'C:\Users\hp\OneDrive - ku.ac.ae\Desktop\CookMate\sources\CookMate-Dataset.xlsx')
catalogue=Path('packages/catalogue/generated/catalogue.json')
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(source) as z:
 strings=[''.join(n.itertext()) for n in E.fromstring(z.read('xl/sharedStrings.xml'))]
 rel={x.attrib['Id']:x.attrib['Target'] for x in E.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
 sheets=E.fromstring(z.read('xl/workbook.xml')).find('m:sheets',ns)
 s=next(s for s in sheets if s.attrib['name']=='Ingredients')
 p=rel[s.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
 p=p.lstrip('/') if p.startswith('/') else 'xl/'+p
 cells={}
 for c in E.fromstring(z.read(p)).findall('.//m:sheetData/m:row/m:c',ns):
  v=c.find('m:v',ns)
  if v is not None: cells[c.attrib['r']]=strings[int(v.text)] if c.attrib.get('t')=='s' else v.text
rows=[dict(recipeId=cells['A'+str(r)],position=int(cells['C'+str(r)]),rawName=cells['D'+str(r)],rawMeasure=cells.get('E'+str(r)),sourceRow=r) for r in range(6,966)]
assert len(rows)==960
generated=json.loads(catalogue.read_text(encoding='utf-8'))
indexed={(r['recipeId'],i['position']):i for r in generated['recipes'] for i in r['ingredients']}
assert len(indexed)==960
for r in rows:
 i=indexed[r['recipeId'],r['position']]
 assert (i['rawName'],i['rawMeasure'],i['source']['row'])==(r['rawName'],r['rawMeasure'],r['sourceRow'])
# Independent policy table, restricted to suffixes actually present in the workbook.
aliases={'':'count','g':'g','kg':'kg','ml':'ml','l':'L','litre':'L','tsp':'tsp','teaspoon':'tsp','teaspoons':'tsp','tbsp':'tbsp','tbs':'tbsp','tblsp':'tbsp','tbls':'tbsp','tablespoon':'tbsp','tablespoons':'tbsp','cup':'cup','cups':'cup','oz':'oz','ounces':'oz','lb':'lb','lbs':'lb','clove':'clove','cloves':'clove'}
def quantity(raw):
 if raw is None or not raw.strip(): return {'kind':'unknown'}
 s=raw.strip()
 suffix=re.search(r'[A-Za-z]+$',s)
 unit=suffix.group(0).lower() if suffix else ''
 if unit not in aliases:return {'kind':'unparsed'}
 amount=s[:suffix.start()].strip() if suffix else s
 # Unicode decomposition supplies the original rational digits; do not use float numeric values.
 normalized=''
 for character in amount:
  decomposition=unicodedata.decomposition(character)
  if decomposition.startswith('<fraction>'):
   normalized+=' '+''.join(chr(int(v,16)) for v in decomposition.split()[1:])
  else:normalized+=character
 normalized=normalized.replace(chr(0x2044),'/')
 parts=normalized.split()
 try:
  if len(parts)==1:
   if not re.fullmatch(r'[0-9]+(?:/[0-9]+|[.][0-9]+)?',parts[0]):raise ValueError()
   q=Fraction(parts[0])
  elif len(parts)==2:
   if not parts[0].isdigit() or not re.fullmatch(r'[0-9]+/[0-9]+',parts[1]):raise ValueError()
   fraction=Fraction(parts[1])
   if fraction>=1:raise ValueError()
   q=int(parts[0])+fraction
  else:raise ValueError()
 except (ValueError,ZeroDivisionError):return {'kind':'unparsed'}
 return {'kind':'exact','numerator':str(q.numerator),'denominator':str(q.denominator),'unit':aliases[unit]}
forms=defaultdict(set)
for r in rows:forms[' '.join(r['rawName'].split()).lower()].add(r['rawName'])
collisions={name for name,forms in forms.items() if len(forms)>1}
assert len(collisions)==17
recipe_ids=sorted({r['recipeId'] for r in rows})
occ={rid:'00000000-0000-4000-8000-'+str(i+1).zfill(12) for i,rid in enumerate(recipe_ids)}
annotations={
'53262-instruction-only-salt':('53262','Flaky sea salt'),
'53064-instruction-only-salt':('53064','Salt'),
'52835-instruction-only-salt':('52835','Salt'),
'52835-instruction-only-black-pepper':('52835','Black Pepper'),
'53150-instruction-only-salt':('53150','Sea salt'),
'53230-instruction-only-salt':('53230','Salt')}
actual_annotations={a['annotationId'] for r in generated['recipes'] for a in r['annotations'] if a['kind']=='instruction_only_ingredient'}
assert actual_annotations==set(annotations)
contributions=[]
for r in rows:
 contributions.append(dict(contributionId=occ[r['recipeId']]+':ingredient:'+str(r['position']),occurrenceId=occ[r['recipeId']],recipeId=r['recipeId'],source=dict(recipeId=r['recipeId'],section='ingredient',position=r['position']),rawName=r['rawName'],rawMeasure=r['rawMeasure'],quantity=quantity(r['rawMeasure'])))
for annotation,(rid,name) in annotations.items():
 contributions.append(dict(contributionId=occ[rid]+':annotation:'+annotation,occurrenceId=occ[rid],recipeId=rid,source=dict(recipeId=rid,section='annotation',annotationId=annotation),rawName=name,rawMeasure=None,quantity={'kind':'review_source'}))
def dump(v):return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def sha(v):return hashlib.sha256(dump(v).encode('utf-8')).hexdigest()
grouped=defaultdict(list)
for c in contributions:
 normalized=' '.join(c['rawName'].split())
 name=('reviewed:'+normalized.lower()) if normalized.lower() in collisions else 'exact:'+normalized
 q=c['quantity']
 identity=dump([name,q['kind'],q['unit'] if q['kind']=='exact' else c['rawMeasure']])
 grouped[identity].append(c)
expected=[]
for identity,items in grouped.items():
 items.sort(key=lambda c:c['contributionId'])
 first=items[0];q=first['quantity'];kind=q['kind']
 if kind=='exact':
  total=sum((Fraction(int(c['quantity']['numerator']),int(c['quantity']['denominator'])) for c in items),Fraction())
  if total.denominator==1:label=str(total.numerator)
  elif 1000%total.denominator==0:
   with localcontext() as ctx:
    ctx.prec=100
    label=format(Decimal(total.numerator)/Decimal(total.denominator),'f').rstrip('0').rstrip('.')
  else:
   whole,remainder=divmod(total.numerator,total.denominator)
   label=(str(whole)+' ' if whole else '')+str(remainder)+'/'+str(total.denominator)
  if q['unit']!='count':label+=' '+q['unit']
 else:label={'unknown':'Amount not supplied','review_source':'Review source instructions','unparsed':first['rawMeasure']}[kind]
 expected.append(dict(groupKey=sha(['shopping-group',identity]),groupingVersion='source-quantity-v1',displayName=min(c['rawName'] for c in items),quantityLabel=label,contributions=items,demandFingerprint=sha({'ruleVersion':'source-quantity-v1','contributions':items})))
expected.sort(key=lambda g:(g['displayName'].lower(),g['groupKey']))
examples=[{'displayName':g['displayName'],'quantityLabel':g['quantityLabel'],'contributions':len(g['contributions']),'groupKey':g['groupKey']} for g in expected if g['displayName'].lower() in {'baking powder','olive oil','sugar','salt'}]
result={'oracleVersion':'workbook-stdlib-Fraction-v1','workbookSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'catalogueSha256':hashlib.sha256(catalogue.read_bytes()).hexdigest(),'sourceRowsMatched':960,'reviewDemands':6,'recipes':len(recipe_ids),'quantities':dict(Counter(c['quantity']['kind'] for c in contributions)),'caseCollisionKeys':sorted(collisions),'groups':len(expected),'expectedProjectionSha256':sha(expected),'exampleGroups':examples}
print(json.dumps(result,ensure_ascii=True))
```

The Node comparison used recipe IDs sorted lexically, assigned occurrence IDs `00000000-0000-4000-8000-` plus the one-based recipe index padded to 12 decimal digits, and gave each occurrence a valid unique day/meal placement. It called the actual `buildShoppingProjection` with the verified catalogue and Node SHA-256, then asserted SHA-256(`JSON.stringify(result)`) equals the corresponding oracle digest above. The doubled fixture adds the second prefix and distinct placements; demand identity intentionally excludes placement/revision changes.

