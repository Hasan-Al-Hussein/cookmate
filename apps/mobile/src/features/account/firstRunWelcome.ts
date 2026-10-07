export const WELCOME_DECISION_KEY = 'cookmate.welcome-decision.v1';

/** Only a positively new guest database plus absent prior device evidence can offer onboarding. */
export async function createFirstRunWelcome(options: {
  hasPriorEvidence(): Promise<boolean>;
  saveDecision(): Promise<void>;
}) {
  let couldBeFresh = false;
  try {
    couldBeFresh = !(await options.hasPriorEvidence());
  } catch {
    /* Uncertainty skips onboarding. */
  }
  let visible = false;
  let decided = false;
  let observed = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => visible,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    observeGuestStore(initialization: 'created' | 'existing' | undefined) {
      if (observed || decided) return;
      observed = true;
      visible = couldBeFresh && initialization === 'created';
      notify();
    },
    async dismiss() {
      if (decided) return;
      decided = true;
      visible = false;
      notify();
      try {
        await options.saveDecision();
      } catch {
        /* Cooking stays available; an existing database also skips the next launch. */
      }
    },
  };
}
export type FirstRunWelcome = Awaited<ReturnType<typeof createFirstRunWelcome>>;
