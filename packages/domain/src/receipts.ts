import { isUtcInstant, validateOperationReceipt } from '@cookmate/contracts';
import type { CatalogueBoundary, OperationReceipt } from '@cookmate/contracts';
import { isSupportedPlanDate } from './dates';

/** Historical effects require valid intrinsic/source facts, never a still-existing live occurrence. */
export function validateReceiptSemantics(
  value: unknown,
  catalogue: CatalogueBoundary,
): value is OperationReceipt {
  if (!validateOperationReceipt(value) || !isUtcInstant(value.committedAt)) return false;
  return value.effects.every((effect) => {
    if (effect.kind === 'favourite') return catalogue.recipeIds.has(effect.entityId);
    if (effect.kind === 'plan')
      return (
        catalogue.recipeIds.has(effect.recipeId) && isSupportedPlanDate(effect.placement.actualDate)
      );
    return true;
  });
}
