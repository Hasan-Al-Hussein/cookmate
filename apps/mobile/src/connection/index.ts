export { createGatewayConnection } from './transport';
export type { GatewayConnection, ConnectionOptions, ConnectionState } from './transport';
export { createSecureCredentialStore, trustedEndpoint } from './credentials';
export type { CredentialStore, PairingCredential, SecureStorePort } from './credentials';
export { ConnectionError, utf8ByteLength } from './errors';
