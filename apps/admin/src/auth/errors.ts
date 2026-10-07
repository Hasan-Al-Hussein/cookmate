export class AdminFault extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireAdmin(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AdminFault(status, code, message);
}
export const unavailable = () =>
  new AdminFault(
    503,
    'storage_unavailable',
    'Admin storage is unavailable. Keep your changes and try again.',
  );
