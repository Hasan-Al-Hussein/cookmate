import { useTheme } from '../design/ThemeProvider';
import { createContext, useContext, type ReactNode } from 'react';
import { Text, type TextProps } from 'react-native';
import { type ColorRole, type TypeRole } from '../design';
import { useNativeLayout } from '../hooks/useNativeLayout';

export const DisplayFontContext = createContext(false);
const editorialRoles = new Set<TypeRole>(['lead', 'title', 'section']);

export function AppText({
  role = 'body',
  color = 'ink',
  style,
  ...props
}: Omit<TextProps, 'role'> & {
  role?: TypeRole;
  color?: ColorRole;
}) {
  const t = useTheme();

  const fontsReady = useContext(DisplayFontContext);
  return (
    <Text
      {...props}
      style={[
        t.type[role],
        {
          color:
            t.color[
              color === 'brand' ? 'brandText' : color === 'assistant' ? 'assistantText' : color
            ],
        },
        editorialRoles.has(role) && {
          fontFamily: fontsReady ? t.font.display : t.font.displayFallback,
        },
        style,
      ]}
    />
  );
}

export function Wordmark() {
  const t = useTheme();
  const { fontScale } = useNativeLayout();

  const fontsReady = useContext(DisplayFontContext);
  return (
    <AppText
      role="title"
      accessibilityLabel="CookMate"
      // Newsreader's visible capitals sit above the line box's centre.
      style={fontsReady ? { transform: [{ translateY: 5 * fontScale }] } : undefined}
    >
      Cook
      <Text
        style={{
          color: t.color.brandText,
          fontFamily: fontsReady ? t.font.displayItalic : t.font.displayFallback,
          fontStyle: fontsReady ? 'normal' : 'italic',
        }}
      >
        Mate
      </Text>
    </AppText>
  );
}

export function EditorialAccent({ children }: { children: ReactNode }) {
  const t = useTheme();

  const fontsReady = useContext(DisplayFontContext);
  return (
    <Text
      style={{
        color: t.color.brandText,
        fontFamily: fontsReady ? t.font.displayItalic : t.font.displayFallback,
        fontStyle: fontsReady ? 'normal' : 'italic',
      }}
    >
      {children}
    </Text>
  );
}
