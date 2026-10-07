import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SCHEMA_V2 } from '../../../../apps/mobile/src/data/schema.ts';
import { encodeStoredText, decodeStoredText } from '../../../../apps/mobile/src/data/storedText.ts';
import { desktopConnection } from '../../test/helpers/sqlite.ts';

const f = desktopConnection(':memory:');
try {
  let checked = 0;
  for (let start = 0; start < 65536; start += 2048) {
    // A separator prevents high/low surrogate neighbors from forming a pair.
    let original = '';
    for (let unit = start; unit < start + 2048; unit++) original += String.fromCharCode(unit) + '|';
    const stored = f.database.prepare('SELECT CAST(? AS TEXT) value').get(encodeStoredText(original)).value;
    const actual = decodeStoredText(stored);
    assert.equal(Buffer.from(actual, 'utf16le').toString('hex'), Buffer.from(original, 'utf16le').toString('hex'));
    checked += 2048;
  }
  for (const original of ['"null"', 'null', '{"s":"\\ud800"}', '\\u0000', '\u0000', '\ud800 x \udfff', 'e\u0301', '\u00e9', '🍲']) {
    const stored = f.database.prepare('SELECT CAST(? AS TEXT) value').get(encodeStoredText(original)).value;
    assert.equal(decodeStoredText(stored), original);
  }
  f.database.exec(SCHEMA_V2);
  const conversation = randomUUID(), message = randomUUID(), preference = randomUUID(), operation = randomUUID();
  f.database.prepare('INSERT INTO conversation VALUES (?,1,0,?,1)').run(conversation, encodeStoredText('draft'));
  f.database.prepare('INSERT INTO message VALUES (?,?,0,0,?,?,?,?)').run(message, conversation, 'user', encodeStoredText('quote'), 'complete', '2026-09-28T00:00:00.000Z');
  f.database.prepare('INSERT INTO saved_preference VALUES (?,?,?,1)').run(preference, 'cuisine', encodeStoredText('value'));
  f.database.prepare('INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?)').run(operation, randomUUID(), '0'.repeat(64), 'committed', '2026-09-28T00:00:00.000Z', 'unchanged', '[]');
  f.database.prepare('INSERT INTO source_preference_link VALUES (?,?,?,?,1,NULL,?)').run(message, preference, 'cuisine', encodeStoredText('value'), operation);
  const columns = [['conversation','composer_draft',4000], ['message','text',8000], ['saved_preference','value',256], ['source_preference_link','value',256]];
  for (const [table,column,max] of columns) {
    const update = f.database.prepare(`UPDATE ${table} SET ${column}=?`);
    for (const invalid of ['plain text', 'null', 'true', '123', '{}', '[]']) assert.throws(() => update.run(invalid));
    update.run(encodeStoredText('\ud800'.repeat(max)));
    assert.throws(() => update.run(encodeStoredText('\ud800'.repeat(max+1))));
    if (max === 256) assert.throws(() => update.run(encodeStoredText('')));
    const actual = f.database.prepare(`SELECT ${column} value FROM ${table}`).get().value;
    assert.equal(decodeStoredText(actual), '\ud800'.repeat(max));
  }
  console.log(JSON.stringify({probe:'all-utf16-binding-and-ddl',codeUnitsChecked:checked,unpairedSeparators:true,literalJsonNulNfdEmojiPreserved:true,strictColumns:columns.map(([table,column])=>`${table}.${column}`),nonStringAndOverBudgetRejected:true}));
} finally { await f.connection.close(); }
