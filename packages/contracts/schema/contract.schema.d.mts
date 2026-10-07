import type { AnySchemaObject, Options } from 'ajv';

export const schema: AnySchemaObject & { $id: string };
export const validationRoots: readonly string[];
export const strictAjvOptions: Options;
