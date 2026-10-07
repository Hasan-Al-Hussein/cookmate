// JSON Schema maxLength counts Unicode code points, not UTF-16 code units.
export function unicodeLength(value) {
  let length = 0;
  for (const codePoint of value) {
    if (codePoint.length > 0) length += 1;
  }
  return length;
}
