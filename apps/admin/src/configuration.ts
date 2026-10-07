import type { AdminPublicationConfiguration } from './publishing/runtime';

export interface AdminServerOptions {
  databaseFile: string;
  mediaDirectory: string;
  bundledPhotoDirectory: string;
  /** Independently configured exact origin; never inferred from request headers. */
  origin: string;
  sessionSecret: string;
  allowInsecureLoopback?: boolean;
  https?: { key: Buffer; cert: Buffer };
  now?: () => Date;
  /** Explicit server-only configuration. Omission leaves signing and issuance disabled. */
  publication?: AdminPublicationConfiguration;
}
