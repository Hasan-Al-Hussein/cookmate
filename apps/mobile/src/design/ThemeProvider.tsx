import { createContext, useContext, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { useAppPreferences } from '../features/app-preferences/AppPreferencesProvider';
import { designTokens, type DesignTokens } from './tokens';

export type ThemeTokens = DesignTokens;
export const darkTokens: ThemeTokens = {
  ...designTokens,
  color: {
    canvas: '#151918',
    surface: '#202725',
    surfaceMuted: '#29312E',
    ink: '#F4F0E8',
    inkSecondary: '#BAC3BC',
    brand: '#AE2935',
    brandText: '#FFABB0',
    brandPressed: '#8F202B',
    onBrand: '#FFFCF8',
    selection: '#41272B',
    assistant: '#234D40',
    assistantText: '#B3DAC4',
    onAssistant: '#FFFCF8',
    divider: '#3C4942',
    controlBorder: '#81958A',
    focus: '#B3DAC4',
    success: '#B3DAC4',
    successSurface: '#213B2D',
    caution: '#F1CD84',
    cautionSurface: '#3D321F',
    error: '#FFB1A4',
    errorSurface: '#452822',
    disabledSurface: '#29312E',
    disabledInk: '#BAC3BC',
  },
};
const ThemeContext = createContext<ThemeTokens>(designTokens);
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const { preferences } = useAppPreferences();
  const dark =
    preferences.theme === 'dark' || (preferences.theme === 'system' && system === 'dark');
  return (
    <ThemeContext.Provider value={dark ? darkTokens : designTokens}>
      {children}
    </ThemeContext.Provider>
  );
}
export function useTheme(): ThemeTokens {
  return useContext(ThemeContext);
}
export function useThemeMode(): 'light' | 'dark' {
  return useTheme() === darkTokens ? 'dark' : 'light';
}
const styleCache = new WeakMap<object, WeakMap<ThemeTokens, unknown>>();
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (tokens: ThemeTokens) => T,
): T {
  const tokens = useTheme();
  let palettes = styleCache.get(factory);
  if (!palettes) {
    palettes = new WeakMap();
    styleCache.set(factory, palettes);
  }
  let styles = palettes.get(tokens) as T | undefined;
  if (!styles) {
    styles = StyleSheet.create(factory(tokens));
    palettes.set(tokens, styles);
  }
  return styles;
}
export function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16},${(value >> 8) & 255},${value & 255},${alpha})`;
}
