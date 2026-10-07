type Annotation = { description?: string };
type ObjectSchema = Annotation & {
  type: 'object';
  properties: Record<string, ProviderGrammarSchema>;
  required: string[];
  additionalProperties: false;
};
export type ProviderGrammarSchema = Annotation &
  (
    | ObjectSchema
    | {
        type: 'array';
        items: ProviderGrammarSchema;
        minItems?: number;
        maxItems?: number;
        uniqueItems?: boolean;
      }
    | { type: 'string'; enum?: string[]; minLength?: number; maxLength?: number; pattern?: string }
    | { type: 'number' | 'integer'; enum?: number[]; minimum?: number; maximum?: number }
    | { type: 'boolean'; enum?: boolean[] }
    | { type: 'null'; enum?: null[] }
  );

export class ProviderGrammarError extends Error {
  constructor(message: string) {
    super(`Unsupported provider grammar schema: ${message}`);
    this.name = 'ProviderGrammarError';
  }
}

function fail(message: string): never {
  throw new ProviderGrammarError(message);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected schema object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('non-plain object');
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !property?.enumerable || !('value' in property))
      fail('non-data schema property');
  }
  return value as Record<string, unknown>;
}

function keys(node: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(node).some((key) => !allowed.includes(key))) fail('unknown schema keyword');
}

function annotation(node: Record<string, unknown>): Annotation {
  if (!Object.hasOwn(node, 'description')) return {};
  if (typeof node.description !== 'string') fail('description must be a string');
  return { description: node.description };
}

function bounds(
  node: Record<string, unknown>,
  minimum: string,
  maximum: string,
  count: boolean,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of [minimum, maximum]) {
    if (!Object.hasOwn(node, name)) continue;
    const value = node[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('bound must be finite');
    if (count && (!Number.isSafeInteger(value) || value < 0)) fail('invalid count bound');
    result[name] = value;
  }
  if (result[minimum] !== undefined && result[maximum] !== undefined)
    if (result[minimum]! > result[maximum]!) fail('inverted bounds');
  return result;
}

function enumeration<T extends string | number | boolean | null>(
  node: Record<string, unknown>,
  accepts: (value: unknown) => value is T,
): { enum?: T[] } {
  if (!Object.hasOwn(node, 'enum')) return {};
  if (!Array.isArray(node.enum) || !node.enum.length || !node.enum.every(accepts))
    fail('enum must contain values of its declared type');
  if (new Set(node.enum).size !== node.enum.length) fail('duplicate enum values');
  return { enum: [...node.enum] };
}

// Schema object key order has no meaning. Array ordering is preserved deterministically.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function without(node: ProviderGrammarSchema, omitted: readonly string[]): unknown {
  return Object.fromEntries(Object.entries(node).filter(([key]) => !omitted.includes(key)));
}

function merge(left: ProviderGrammarSchema, right: ProviderGrammarSchema): ProviderGrammarSchema {
  if (canonical(left) === canonical(right)) return left;
  if (left.type !== right.type) fail('incompatible property types');
  if (left.type === 'object' && right.type === 'object') {
    if (
      canonical(without(left, ['properties', 'required'])) !==
      canonical(without(right, ['properties', 'required']))
    )
      fail('incompatible object constraints');
    const names = [...new Set([...Object.keys(left.properties), ...Object.keys(right.properties)])];
    const properties = Object.fromEntries(
      names.sort().map((name) => {
        const inLeft = Object.hasOwn(left.properties, name);
        const inRight = Object.hasOwn(right.properties, name);
        return [
          name,
          inLeft && inRight
            ? merge(left.properties[name]!, right.properties[name]!)
            : inLeft
              ? left.properties[name]!
              : right.properties[name]!,
        ];
      }),
    );
    return {
      ...left,
      properties,
      required: left.required.filter((name) => right.required.includes(name)),
    };
  }
  if (left.type === 'array' && right.type === 'array') {
    if (canonical(without(left, ['items'])) !== canonical(without(right, ['items'])))
      fail('incompatible array constraints');
    return { ...left, items: merge(left.items, right.items) };
  }
  if (left.type === 'string' && right.type === 'string' && left.enum && right.enum) {
    if (canonical(without(left, ['enum'])) !== canonical(without(right, ['enum'])))
      fail('incompatible string enum constraints');
    return { ...left, enum: [...new Set([...left.enum, ...right.enum])] };
  }
  fail('incompatible primitive constraints');
}

function discriminator(branches: ObjectSchema[]): string {
  const common = branches[0]!.required.filter((name) =>
    branches.every((branch) => branch.required.includes(name)),
  );
  for (const name of [...new Set(['kind', 'section', ...common.sort()])]) {
    if (!common.includes(name)) continue;
    const values: string[] = [];
    for (const branch of branches) {
      const field = branch.properties[name];
      if (field?.type !== 'string' || field.enum?.length !== 1) break;
      values.push(field.enum[0]!);
    }
    if (values.length === branches.length && new Set(values).size === branches.length) return name;
  }
  fail('union needs a common required distinct singleton string discriminator');
}

function conditionalDescription(branches: ObjectSchema[], name: string): string {
  const clauses = branches.map((branch) => {
    const field = branch.properties[name];
    if (field?.type !== 'string' || field.enum?.length !== 1) fail('invalid discriminator');
    return `${JSON.stringify(field.enum[0])}: allowed ${JSON.stringify(Object.keys(branch.properties).sort())}, required ${JSON.stringify([...branch.required].sort())}`;
  });
  return `Conditional fields by ${JSON.stringify(name)}: ${clauses.join('; ')}. Use only the fields allowed for the selected value.`;
}

/** Compile only an application-owned projected schema. The result is grammar guidance,
 * not an equivalent validator: the unchanged full schema enforces conditional fields. */
export function compileProviderGrammar(schema: unknown): ProviderGrammarSchema {
  const active = new WeakSet<object>();
  function visit(value: unknown, depth: number): ProviderGrammarSchema {
    if (depth > 64) fail('schema nesting limit');
    const node = record(value);
    if (active.has(node)) fail('cyclic schema');
    active.add(node);
    try {
      if (Object.hasOwn(node, 'anyOf')) {
        keys(node, ['anyOf', 'type']);
        if (Object.hasOwn(node, 'type') && node.type !== 'object')
          fail('union type sibling must be redundant object type');
        if (!Array.isArray(node.anyOf) || node.anyOf.length < 2) fail('expected union branches');
        const branches = node.anyOf.map((branch) => {
          const raw = record(branch);
          if (
            raw.type !== 'object' ||
            raw.additionalProperties !== false ||
            Object.hasOwn(raw, 'anyOf')
          )
            fail('union branches must be closed objects');
          const compiled = visit(branch, depth + 1);
          if (compiled.type !== 'object') fail('union branch must remain an object');
          return compiled;
        });
        const name = discriminator(branches);
        const merged = branches.slice(1).reduce<ProviderGrammarSchema>(merge, branches[0]!);
        if (merged.type !== 'object') fail('union must produce an object');
        const conditional = conditionalDescription(branches, name);
        return {
          ...merged,
          description: merged.description ? `${merged.description}\n${conditional}` : conditional,
        };
      }
      const description = annotation(node);
      if (node.type === 'object') {
        keys(node, ['type', 'properties', 'required', 'additionalProperties', 'description']);
        if (node.additionalProperties !== false) fail('objects must be closed');
        const source = record(node.properties);
        if (
          !Array.isArray(node.required) ||
          !node.required.every((name): name is string => typeof name === 'string') ||
          new Set(node.required).size !== node.required.length ||
          node.required.some((name) => !Object.hasOwn(source, name))
        )
          fail('required must name unique declared properties');
        return {
          type: 'object',
          properties: Object.fromEntries(
            Object.keys(source)
              .sort()
              .map((name) => [name, visit(source[name], depth + 1)]),
          ),
          required: [...node.required].sort(),
          additionalProperties: false,
          ...description,
        };
      }
      if (node.type === 'array') {
        keys(node, ['type', 'items', 'minItems', 'maxItems', 'uniqueItems', 'description']);
        if (Object.hasOwn(node, 'uniqueItems') && typeof node.uniqueItems !== 'boolean')
          fail('uniqueItems must be boolean');
        return {
          type: 'array',
          items: visit(node.items, depth + 1),
          ...bounds(node, 'minItems', 'maxItems', true),
          ...(typeof node.uniqueItems === 'boolean' ? { uniqueItems: node.uniqueItems } : {}),
          ...description,
        };
      }
      if (node.type === 'string') {
        keys(node, ['type', 'enum', 'minLength', 'maxLength', 'pattern', 'description']);
        if (Object.hasOwn(node, 'pattern') && typeof node.pattern !== 'string')
          fail('pattern must be a string');
        return {
          type: 'string',
          ...enumeration(node, (item): item is string => typeof item === 'string'),
          ...bounds(node, 'minLength', 'maxLength', true),
          ...(typeof node.pattern === 'string' ? { pattern: node.pattern } : {}),
          ...description,
        };
      }
      if (node.type === 'number' || node.type === 'integer') {
        keys(node, ['type', 'enum', 'minimum', 'maximum', 'description']);
        return {
          type: node.type,
          ...enumeration(
            node,
            (item): item is number =>
              typeof item === 'number' &&
              Number.isFinite(item) &&
              (node.type !== 'integer' || Number.isInteger(item)),
          ),
          ...bounds(node, 'minimum', 'maximum', false),
          ...description,
        };
      }
      if (node.type === 'boolean' || node.type === 'null') {
        keys(node, ['type', 'enum', 'description']);
        return node.type === 'boolean'
          ? {
              type: 'boolean',
              ...enumeration(node, (item): item is boolean => typeof item === 'boolean'),
              ...description,
            }
          : {
              type: 'null',
              ...enumeration(node, (item): item is null => item === null),
              ...description,
            };
      }
      fail('unsupported or missing schema type');
    } finally {
      active.delete(node);
    }
  }
  return visit(schema, 0);
}
