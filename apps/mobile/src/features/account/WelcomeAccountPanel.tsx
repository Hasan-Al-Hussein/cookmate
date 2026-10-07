import { getRecipe } from '@cookmate/catalogue';
import { StyleSheet, View } from 'react-native';
import { BrandMark } from '../../components/BrandMark';
import { ActionButton, Notice } from '../../components/Controls';
import { ProviderSignInButton } from './ProviderSignInButton';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText, EditorialAccent, Wordmark } from '../../components/Typography';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useNativeLayout } from '../../hooks/useNativeLayout';

const welcomeRecipe = getRecipe('52839');

export interface WelcomeAccountPanelProps {
  appleAvailable: boolean;
  googleAvailable: boolean;
  busy: boolean;
  availabilityNotice: string | null;
  error: string | null;
  onApple(): void;
  onGoogle(): void;
  onContinueGuest(): void;
  onPrivacy(): void;
}

/** Presentation only. The parent owns eligibility, persistence, scrolling and account actions. */
export function WelcomeAccountPanel(props: WelcomeAccountPanelProps) {
  const styles = useThemedStyles(createStyles);
  const { width, enlarged } = useNativeLayout();
  const stacked = enlarged || width < 360;
  const unavailable = !props.appleAvailable && !props.googleAvailable;

  return (
    <View style={styles.panel}>
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <BrandMark width={30} height={30} />
        </View>
        <View style={styles.wordmark}>
          <Wordmark />
        </View>
      </View>

      <View style={[styles.introduction, stacked && styles.stacked]}>
        <View style={[styles.headline, !stacked && styles.horizontalHeadline]}>
          <AppText role="label" color="brand" style={styles.eyebrow}>
            YOUR EVERYDAY KITCHEN
          </AppText>
          <AppText role="lead" accessibilityRole="header">
            Good food.{'\n'}A little less <EditorialAccent>deciding.</EditorialAccent>
          </AppText>
        </View>
        {welcomeRecipe && (
          <View style={[styles.photograph, stacked && styles.stackedPhotograph]}>
            <RecipePhoto
              recipeId={welcomeRecipe.recipeId}
              title={welcomeRecipe.title}
              aspectRatio={1}
              compact
            />
          </View>
        )}
      </View>

      <View style={styles.copy}>
        <AppText>
          Keep your recipes, plans and preferences on this device, or sign in to back them up across
          devices.
        </AppText>
        <AppText role="support" color="success">
          An account is optional. You can add one later in Settings.
        </AppText>
      </View>

      {props.error && (
        <View accessibilityLiveRegion="polite">
          <Notice title="Sign-in could not finish" tone="error">
            {props.error}
          </Notice>
        </View>
      )}

      <View style={styles.actions}>
        <ProviderSignInButton
          provider="apple"
          label="Continue with Apple"
          disabled={props.busy || !props.appleAvailable}
          onPress={props.onApple}
        />
        <ProviderSignInButton
          provider="google"
          label="Continue with Google"
          disabled={props.busy || !props.googleAvailable}
          onPress={props.onGoogle}
        />
        <ActionButton label="Continue as guest" onPress={props.onContinueGuest} />
        {(props.availabilityNotice || !props.appleAvailable || !props.googleAvailable) && (
          <AppText role="support" color="inkSecondary">
            {props.availabilityNotice ??
              (unavailable
                ? 'Apple and Google sign-in are unavailable in this app environment.'
                : `${props.appleAvailable ? 'Google' : 'Apple'} sign-in is unavailable in this app environment.`)}
          </AppText>
        )}
        {props.busy && (
          <AppText role="support" color="inkSecondary" accessibilityLiveRegion="polite">
            Connecting to your account. You can keep browsing while sign-in finishes.
          </AppText>
        )}
      </View>

      <View style={styles.privacy}>
        <AppText role="support" color="inkSecondary" style={styles.privacyCopy}>
          Guest data stays on this device. Signing in does not enable AI sharing.
        </AppText>
        <ActionButton label="Privacy & data" variant="quiet" onPress={props.onPrivacy} />
      </View>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    panel: {
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
      paddingVertical: t.space.sm,
      gap: t.space.lg,
    },
    brandRow: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    wordmark: { flexShrink: 1, minWidth: 0 },
    brandMark: {
      width: 44,
      height: 44,
      borderRadius: t.radius.small,
      backgroundColor: t.color.brand,
      justifyContent: 'center',
      alignItems: 'center',
    },
    introduction: { flexDirection: 'row', alignItems: 'center', gap: t.space.md },
    stacked: { flexDirection: 'column', alignItems: 'stretch' },
    headline: { gap: t.space.sm },
    horizontalHeadline: { flex: 1 },
    eyebrow: { letterSpacing: 1.5, fontSize: 11, lineHeight: 16 },
    photograph: { width: 124, flexShrink: 0 },
    stackedPhotograph: { alignSelf: 'flex-end' },
    copy: { gap: t.space.xs },
    actions: { gap: t.space.sm },
    privacy: { borderTopWidth: 1, borderTopColor: t.color.divider, paddingTop: t.space.md },
    privacyCopy: { textAlign: 'center' },
  });
