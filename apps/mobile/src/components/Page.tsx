import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { ScrollView, StyleSheet, View, type ScrollViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useThemedStyles, type ThemeTokens } from '../design/ThemeProvider';
import { IconButton } from './Icon';
import { AppText, Wordmark } from './Typography';
import { focusTarget } from './focusTarget';
import { useOrdinaryWorkspaceActions } from '../features/content/useOrdinaryWorkspace';
import { AccountEntry } from '../features/account/AccountEntry';
import { BrandMark } from './BrandMark';
import { ThemeToggle } from './ThemeToggle';

export function Page({
  children,
  scroll = true,
  bottomInset = false,
  scrollRef,
  onScroll,
}: {
  children: ReactNode;
  scroll?: boolean;
  bottomInset?: boolean;
  scrollRef?: Ref<ScrollView>;
  onScroll?: ScrollViewProps['onScroll'];
}) {
  const styles = usePageStyles();
  return (
    <SafeAreaView
      style={styles.root}
      edges={bottomInset ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']}
    >
      {scroll ? (
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={onScroll ? 16 : undefined}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.fill}>{children}</View>
      )}
    </SafeAreaView>
  );
}

export function PageHeader({
  title,
  back = false,
  brand = false,
  onBack,
  focusOnMount = false,
}: {
  title?: string;
  back?: boolean;
  brand?: boolean;
  onBack?: () => void;
  focusOnMount?: boolean;
}) {
  const styles = usePageStyles();
  const router = useRouter();
  const heading = useRef<View>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = requestAnimationFrame(() => focusTarget(heading.current));
    return () => cancelAnimationFrame(frame);
  }, [focusOnMount]);
  const [themeError, setThemeError] = useState<string | null>(null);
  const { registerFocusFallback } = useOrdinaryWorkspaceActions();
  useFocusEffect(
    useCallback(
      () =>
        registerFocusFallback(() => {
          focusTarget(heading.current);
        }),
      [registerFocusFallback],
    ),
  );
  return (
    <View>
      <View style={[styles.header, back && !!title && styles.backHeader]}>
        {back ? (
          <IconButton
            ref={heading}
            name="back"
            tone="surface"
            label="Back"
            accessibilityLabel="Back"
            onPress={onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
          />
        ) : brand ? (
          <View
            ref={heading}
            accessible
            accessibilityRole="header"
            accessibilityLabel="CookMate"
            style={styles.brand}
          >
            <View style={styles.brandMark}>
              <BrandMark width={26} height={26} />
            </View>
            <Wordmark />
          </View>
        ) : (
          <View ref={heading} accessible accessibilityRole="header" style={styles.headerTitle}>
            <AppText role="title">{title}</AppText>
          </View>
        )}
        {back && !!title && (
          <View accessible accessibilityRole="header" style={styles.backTitle}>
            <AppText role="section">{title}</AppText>
          </View>
        )}
        {!back && (
          <View style={styles.headerActions}>
            {brand && <ThemeToggle onError={setThemeError} />}
            <AccountEntry onPress={() => router.push('/account')} />
          </View>
        )}
      </View>
      {themeError && (
        <AppText role="support" accessibilityRole="alert">
          {themeError}
        </AppText>
      )}
    </View>
  );
}

const createPageStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.canvas },
    fill: { flex: 1 },
    content: {
      padding: t.space.gutter,
      paddingBottom: t.space.xl,
      gap: t.space.lg,
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
    },
    header: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: t.space.xs,
      paddingBottom: t.space.xxs,
    },
    headerTitle: { flexShrink: 1 },
    backHeader: { justifyContent: 'flex-start', flexWrap: 'nowrap', gap: t.space.sm },
    backTitle: { flex: 1, minWidth: 0 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    brandMark: {
      width: 32,
      height: 32,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.color.brand,
    },
    headerActions: { flexDirection: 'row', alignItems: 'center', gap: 0 },
    section: { gap: t.space.md },
  });

export function usePageStyles() {
  return useThemedStyles(createPageStyles);
}
