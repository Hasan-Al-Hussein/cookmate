export interface OwnedLocalStore {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}
interface OwnedLocalController {
  dispose(): void;
  drain(): Promise<void>;
}

/** Shared close-before-open barrier for small owner-private local records. Storage keys,
 * serialization and policy belong to each feature; this helper only fences their lifetime.
 */
export function createOwnedLocalControllers<Controller extends OwnedLocalController>(
  storeForOwner: (ownerId: string | null) => OwnedLocalStore,
  isCurrent: (ownerId: string | null) => boolean,
  createController: (store: OwnedLocalStore) => Controller,
  errors: { readonly changed: string; readonly removing: string },
) {
  let active: { ownerId: string | null; controller: Controller } | null = null;
  let pending = Promise.resolve();
  const removing = new Set<string>();
  function retire() {
    if (!active) return;
    const previous = active.controller;
    active = null;
    previous.dispose();
    const earlier = pending;
    pending = Promise.all([earlier, previous.drain()]).then(() => undefined);
    // Retain rejection for drain/the next read, without an unhandled observer promise.
    void pending.catch(() => undefined);
  }
  return Object.freeze({
    current(ownerId: string | null): Controller {
      if (!isCurrent(ownerId) || (ownerId !== null && removing.has(ownerId)))
        throw new Error(errors.changed);
      if (active?.ownerId === ownerId) return active.controller;
      retire();
      const store = storeForOwner(ownerId);
      const before = pending;
      let controller: Controller;
      const check = () => {
        if (active?.controller !== controller || !isCurrent(ownerId))
          throw new Error(errors.changed);
      };
      controller = createController({
        async read() {
          await before;
          check();
          const text = await store.read();
          check();
          return text;
        },
        async write(text) {
          await before;
          check();
          await store.write(text);
          check();
        },
      });
      active = { ownerId, controller };
      return controller;
    },
    retire,
    async remove(ownerId: string, erase: () => Promise<void>) {
      if (removing.has(ownerId)) throw new Error(errors.removing);
      removing.add(ownerId);
      if (active?.ownerId === ownerId) retire();
      try {
        await pending;
        await erase();
      } finally {
        removing.delete(ownerId);
      }
    },
    async drain() {
      await pending;
      await active?.controller.drain();
    },
  });
}
