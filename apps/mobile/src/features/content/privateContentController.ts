import {
  createPrivateContentOpener,
  PrivateContentCleanupError,
  type PrivateContentRuntime,
} from './privateContentRuntime';

export interface PrivateContentPreparation {
  kind: 'prepared' | 'already_prepared';
  resumed: boolean;
}
export interface PrivateContentController {
  open(): Promise<PrivateContentRuntime>;
  prepare(): Promise<PrivateContentPreparation>;
}
export interface PrivateContentLifecycleController extends PrivateContentController {
  /** Shares preparation/opening's lease. The check is valid only for this closed operation. */
  whileClosed<Value>(work: (assertClosed: () => void) => Promise<Value>): Promise<Value>;
  /** Read-only preparation verification can join this controller's active opening. */
  duringOpening<Value>(
    lease: PrivateContentOpeningLease,
    work: (assertOpening: () => void) => Promise<Value>,
  ): Promise<Value>;
}
const openingBrand = Symbol('private-content-opening');
export interface PrivateContentOpeningLease {
  readonly [openingBrand]: true;
}
interface ControllerPorts {
  prepare(): Promise<PrivateContentPreparation>;
  open(lease: PrivateContentOpeningLease): Promise<PrivateContentRuntime>;
}

/** Preparation and a live reader must never own the same SQLite file concurrently. */
export function createPrivateContentController(
  ports: ControllerPorts,
): PrivateContentLifecycleController {
  const prepare = ports.prepare.bind(ports),
    open = ports.open.bind(ports);
  let owner: object | null = null;
  let blocked: PrivateContentCleanupError | undefined;
  let openingLease: PrivateContentOpeningLease | null = null;
  let openingTicket: object | null = null;
  let verifying = false;
  function claim() {
    if (blocked) throw blocked;
    if (owner) throw new Error('The private review workspace is already in use.');
    return (owner = {});
  }
  function failed(error: unknown, ticket: object) {
    if (error instanceof PrivateContentCleanupError) blocked = error;
    if (owner === ticket) owner = null;
  }
  async function whileClosed<Value>(work: (assertClosed: () => void) => Promise<Value>) {
    const ticket = claim();
    const assertClosed = () => {
      if (blocked) throw blocked;
      if (owner !== ticket) throw new Error('The closed workspace lease has ended.');
    };
    try {
      return await work(assertClosed);
    } catch (error) {
      failed(error, ticket);
      throw error;
    } finally {
      if (owner === ticket) owner = null;
    }
  }
  const opener = createPrivateContentOpener(async () => {
    const ticket = claim();
    const lease = Object.freeze({ [openingBrand]: true as const });
    openingLease = lease;
    openingTicket = ticket;
    let runtime: PrivateContentRuntime;
    try {
      runtime = await open(lease);
    } catch (error) {
      failed(error, ticket);
      throw error;
    } finally {
      openingLease = null;
      openingTicket = null;
    }
    let closing: Promise<void> | undefined;
    return Object.freeze({
      storageScope: runtime.storageScope,
      host: runtime.host,
      fetchRelease: runtime.fetchRelease.bind(runtime),
      close() {
        if (closing) return closing;
        let resolve!: () => void, reject!: (error: unknown) => void;
        closing = new Promise<void>((done, failure) => {
          resolve = done;
          reject = failure;
        });
        const rejectClose = (error: unknown) => {
          const cleanup =
            error instanceof PrivateContentCleanupError
              ? error
              : new PrivateContentCleanupError([error]);
          failed(cleanup, ticket);
          reject(cleanup);
        };
        try {
          void Promise.resolve(runtime.close()).then(() => {
            if (owner === ticket) owner = null;
            resolve();
          }, rejectClose);
        } catch (error) {
          rejectClose(error);
        }
        return closing;
      },
    });
  });
  return Object.freeze({
    open: opener,
    whileClosed,
    async duringOpening<Value>(
      lease: PrivateContentOpeningLease,
      work: (assertOpening: () => void) => Promise<Value>,
    ) {
      const check = () => {
        if (blocked) throw blocked;
        if (!openingTicket || openingLease !== lease || owner !== openingTicket)
          throw new Error('The workspace opening lease has ended.');
      };
      check();
      if (verifying) throw new Error('Workspace opening verification is already in use.');
      verifying = true;
      try {
        const value = await work(check);
        check();
        return value;
      } catch (error) {
        if (error instanceof PrivateContentCleanupError) blocked = error;
        throw error;
      } finally {
        verifying = false;
      }
    },
    prepare: () => whileClosed(prepare),
  });
}
