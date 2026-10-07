export interface FieldHelp {
  id: string;
  text: string;
  invalid: boolean;
}

export function fieldHelpProps({ text }: FieldHelp) {
  return { accessibilityHint: text };
}
