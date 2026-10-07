import type { AdminDraftInput } from '../src/contracts';
import type { AdminTranslationInput } from '../src/translations/contracts';

export type TranslationForm = Omit<AdminTranslationInput, 'attribution'> & {
  attribution: AdminTranslationInput['attribution'] | '';
};
/** No machine translation or ordinal remapping is inferred. Original quantities stay in the source. */
export function emptyTranslationForm(source: AdminDraftInput): TranslationForm {
  return {
    title: '',
    description: null,
    category: '',
    cuisine: '',
    rawTags: null,
    ingredients: source.ingredients.map(() => ({ rawName: '' })),
    instructions: source.instructions.map(() => ({ rawText: '' })),
    changeSummary: '',
    attribution: '',
  };
}
export function admitTranslationForm(form: TranslationForm): AdminTranslationInput {
  if (!['human', 'machine', 'mixed'].includes(form.attribution))
    throw new Error('Declare whether the text is human-written, machine-generated or mixed.');
  return { ...form, attribution: form.attribution as AdminTranslationInput['attribution'] };
}
export function admitTranslationLanguages(original: string, target: string) {
  for (const value of [original, target]) {
    let valid = false;
    try {
      valid =
        value.length <= 35 &&
        /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/.test(value) &&
        value !== 'und' &&
        Intl.getCanonicalLocales(value)[0] === value;
    } catch {
      /* Shown below. */
    }
    if (!valid) throw new Error('Enter canonical language tags such as en and ar.');
  }
  if (original === target) throw new Error('Original and target languages must differ.');
}
export const translationStatus = (status: 'draft' | 'reviewed' | 'changes_requested' | 'stale') =>
  ({
    draft: 'Translation draft · human review pending',
    reviewed: 'Operator review recorded',
    changes_requested: 'Changes requested',
    stale: 'Stale · original revision changed',
  })[status];
