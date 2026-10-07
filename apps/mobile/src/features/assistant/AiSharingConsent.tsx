import { View, StyleSheet } from 'react-native';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { assistantDataDisclosure } from '../../assistant-core';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useAssistant } from './useAssistant';
import { aiConsentVersion } from './aiConsent';

export function AiSharingConsent({ compact = false }: { compact?: boolean }) {
  const { assistant, state } = useAssistant();
  const styles = useThemedStyles(createStyles);
  const consent = state?.aiConsent;
  if (!consent || (compact && consent.status === 'allowed')) return null;
  return (
    <View style={styles.container}>
      <AppText role="section" accessibilityRole="header">
        AI data sharing
      </AppText>
      <AppText role="support">{assistantDataDisclosure.processing}</AppText>
      <AppText role="support">{assistantDataDisclosure.operator}</AppText>
      <AppText role="support">{assistantDataDisclosure.provider}</AppText>
      <AppText role="support">
        Private recipe notes, collection names, manual shopping items and cooking history are not
        automatically included. Anything you type into chat is part of your message.
      </AppText>
      {consent.status === 'loading' || consent.status === 'saving' ? (
        <AppText accessibilityLiveRegion="polite">
          {consent.status === 'loading' ? 'Reading your choice…' : 'Saving your choice…'}
        </AppText>
      ) : consent.status === 'error' ? (
        <Notice title="Your sharing choice could not be confirmed" tone="error">
          <AppText role="support">
            Sending is blocked on this screen. Retry before closing the app to confirm your choice
            is saved; an earlier choice may still be stored.
          </AppText>
          <ActionButton
            label="Retry saving or reading choice"
            onPress={() => void assistant?.aiConsent?.retry()}
          />
        </Notice>
      ) : consent.status === 'allowed' ? (
        <>
          <AppText role="support">Allowed on this device · Disclosure {aiConsentVersion}</AppText>
          <ActionButton
            label="Stop sharing with AI"
            variant="secondary"
            onPress={() => void assistant?.aiConsent?.decide(false)}
          />
        </>
      ) : (
        <>
          <AppText role="support">
            {consent.status === 'declined' ? 'AI sharing is off. ' : ''}
            You can keep using local recipes, planning and shopping without agreeing. Allowing
            sharing does not send your draft; use Send when you are ready.
          </AppText>
          <ActionButton
            label="Allow this data to be sent to Gemini"
            onPress={() => void assistant?.aiConsent?.decide(true)}
          />
          {consent.status !== 'declined' && (
            <ActionButton
              label="Keep AI sharing off"
              variant="quiet"
              onPress={() => void assistant?.aiConsent?.decide(false)}
            />
          )}
        </>
      )}
      <AppText role="support" color="inkSecondary">
        Turning sharing off stops future requests and ends waiting where possible. It cannot erase
        information already delivered to the laptop or Gemini. Local saved work stays on this
        device.
      </AppText>
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    container: {
      gap: t.space.sm,
      padding: t.space.md,
      borderRadius: t.radius.card,
      backgroundColor: t.color.surface,
    },
  });
