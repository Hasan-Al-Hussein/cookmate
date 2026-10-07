/** Shared layout/type tokens. Palette values are resolved by ThemeProvider. */
export const designTokens = {
  color: {
    canvas: '#F8F5EF',
    surface: '#FFFCF8',
    surfaceMuted: '#EFEAE2',
    ink: '#162323',
    inkSecondary: '#58605D',
    brand: '#910D16',
    brandText: '#910D16',
    brandPressed: '#710A11',
    onBrand: '#FFFCF8',
    selection: '#F8E5DF',
    assistant: '#214B3C',
    assistantText: '#214B3C',
    onAssistant: '#FFFCF8',
    divider: '#DFD8CE',
    // Dividers group content; this stronger edge identifies operable controls.
    controlBorder: '#8C8278',
    focus: '#214B3C',
    success: '#214B3C',
    successSurface: '#E7F0E9',
    caution: '#805312',
    cautionSurface: '#FAEBCB',
    error: '#9F2D21',
    errorSurface: '#FBE7E1',
    disabledSurface: '#EFEAE2',
    disabledInk: '#58605D',
  },
  font: {
    display: 'CookMateNewsreader',
    displayItalic: 'CookMateNewsreaderItalic',
    // iPhone fallback only when the bundled display face is unavailable.
    displayFallback: 'Georgia',
    // Omit fontFamily for reading/controls so native system sans remains available.
  },
  type: {
    lead: { fontSize: 38, lineHeight: 42, fontWeight: '400' },
    title: { fontSize: 30, lineHeight: 36, fontWeight: '400' },
    section: { fontSize: 23, lineHeight: 29, fontWeight: '400' },
    recipe: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
    body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
    bodyStrong: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
    control: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
    support: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
    label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
    navigation: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  },
  space: {
    none: 0,
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    gutter: 20,
    lg: 24,
    xl: 32,
    xxl: 40,
    section: 48,
  },
  radius: { small: 12, control: 16, card: 18, sheet: 24, pill: 999 },
  border: { divider: 1, control: 1, selected: 2, focus: 3 },
  control: {
    minimumTarget: 48,
    buttonMinHeight: 52,
    fieldMinHeight: 52,
    icon: 22,
    checkbox: 24,
  },
  layout: {
    phoneGutter: 20,
    compactPhoneGutter: 16,
    columnGap: 12,
    // Use a single column unless width AND text scale permit this minimum.
    recipeColumnMinWidth: 164,
    recipeGridMaxFontScale: 1.15,
    readingMaxWidth: 640,
    screenMaxWidth: 840,
    inlineMeasureMinWidth: 112,
    thumbnail: 64,
    largeThumbnail: 80,
  },
  image: {
    discoveryAspectRatio: 4 / 3,
    detailAspectRatio: 4 / 3,
    thumbnailAspectRatio: 1,
    defaultResizeMode: 'contain',
    // Cover is a per-photo, per-ratio reviewed opt-in; preserve visible credits.
  },
  motion: {
    pressDurationMs: 120,
    stateDurationMs: 160,
    sheetDurationMs: 220,
    reducedDurationMs: 0,
    pressScale: 0.98,
    sheetTranslateY: 16,
  },
} as const;

export type DesignTokens = Omit<typeof designTokens, 'color'> & {
  color: { [K in keyof typeof designTokens.color]: string };
};
export type ColorRole = keyof DesignTokens['color'];
export type TypeRole = keyof DesignTokens['type'];
