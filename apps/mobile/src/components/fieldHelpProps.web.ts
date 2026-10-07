import type { FieldHelp } from './fieldHelpProps';

export function fieldHelpProps({ id, invalid }: FieldHelp) {
  return { 'aria-describedby': id, 'aria-invalid': invalid };
}
