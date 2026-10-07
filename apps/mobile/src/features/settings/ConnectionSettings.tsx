import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ActionButton, Notice, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useAssistant } from '../assistant/useAssistant';
import { errorCopy } from '../assistant/assistantCopy';
import { assistantDataDisclosure } from '../../assistant-core';
import { AppIcon } from '../../components/Icon';
import { AiSharingConsent } from '../assistant/AiSharingConsent';

export function ConnectionSettings({ showTitle = true }: { showTitle?: boolean }) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();

  const { assistant, state } = useAssistant();
  const [endpoint, setEndpoint] = useState(state?.connection.endpoint ?? '');
  const [code, setCode] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  useEffect(() => {
    setDetailsOpen(false);
  }, [state?.connection.generation, state?.connection.clientId, state?.connection.status]);
  useEffect(() => {
    if (state?.connection.status === 'paired') {
      setEndpoint(state.connection.endpoint ?? '');
      setCode('');
    }
  }, [state?.connection.status, state?.connection.generation, state?.connection.endpoint]);
  const blocked = !state?.connectionReady || state.connectionBusy || state.busy;
  return (
    <View style={styles.section}>
      {showTitle && (
        <AppText role="section" accessibilityRole="header">
          AI connection
        </AppText>
      )}
      <View style={styles.status}>
        <View style={styles.statusTitle}>
          <AppIcon name="chat" color={t.color.assistantText} />
          <AppText role="bodyStrong" style={styles.statusText}>
            {state?.connectionBusy
              ? 'Connecting…'
              : state?.connection.status === 'paired'
                ? 'Paired with your laptop'
                : state?.connection.status === 'reconnect'
                  ? 'Pair again to reconnect'
                  : 'Not paired'}
          </AppText>
        </View>
        {state?.connection.reason && (
          <AppText role="support">
            {errorCopy({
              code: state.connection.reason,
              messageKey: 'connection.status',
              retry: 'after_correction',
            })}
          </AppText>
        )}
        {state?.connection.expiresAt && (
          <AppText role="support">
            Pairing expires: {new Date(state.connection.expiresAt).toLocaleString()}
          </AppText>
        )}
        <AppText role="support">
          Pairing shows saved access, not that the AI provider is working. Your laptop must be awake
          and reachable through its trusted HTTPS address.
        </AppText>
      </View>
      <View style={styles.disclosure}>
        <AppText role="support" color="inkSecondary">
          {assistantDataDisclosure.processing}
        </AppText>
        <AppText role="support" color="inkSecondary">
          {assistantDataDisclosure.operator}
        </AppText>
      </View>
      <AiSharingConsent />
      <View style={styles.form}>
        <AppText role="label">Trusted laptop address</AppText>
        <TextInput
          accessibilityLabel="Trusted HTTPS laptop address"
          style={controlStyles.field}
          value={endpoint}
          onChangeText={setEndpoint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="https://your-laptop-address"
          editable={!state?.connectionBusy}
        />
        <AppText role="label">Pairing code</AppText>
        <TextInput
          accessibilityLabel="One-time laptop pairing code"
          style={controlStyles.field}
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          secureTextEntry
          editable={!state?.connectionBusy}
        />
        <AppText role="support">
          Use the current code shown by the laptop setup. This is not a provider API key.
        </AppText>
        <ActionButton
          label="Pair this iPhone"
          disabled={blocked || !endpoint.trim() || !code.trim()}
          onPress={() => void assistant?.connectionAction('pair', endpoint.trim(), code.trim())}
        />
        <ActionButton
          label="Check laptop availability"
          variant="secondary"
          disabled={blocked || !endpoint.trim()}
          onPress={() => void assistant?.connectionAction('health', endpoint.trim())}
        />
      </View>
      {state?.connection.status === 'paired' && (
        <>
          {state.connection.clientId && (
            <>
              <ActionButton
                label={detailsOpen ? 'Hide connection details' : 'Show connection details'}
                variant="quiet"
                accessibilityState={{ expanded: detailsOpen }}
                onPress={() => setDetailsOpen((open) => !open)}
              />
              {detailsOpen && (
                <>
                  <AppText role="support" color="inkSecondary">
                    Client ID
                  </AppText>
                  <AppText role="support" selectable>
                    {state.connection.clientId}
                  </AppText>
                  <AppText role="support" color="inkSecondary">
                    Share this non-secret ID with the laptop operator to identify this connection.
                  </AppText>
                </>
              )}
            </>
          )}
          <ActionButton
            label="Disconnect this iPhone"
            variant="quiet"
            disabled={blocked}
            onPress={() => void assistant?.connectionAction('forget')}
          />
          <ActionButton
            label="Disconnect and revoke access"
            variant="quiet"
            disabled={blocked}
            onPress={() => void assistant?.connectionAction('revoke')}
          />
        </>
      )}
      <AppText role="support">
        Disconnecting or pairing again preserves local cooking work and does not send your draft. If
        trust or compatibility fails, use the maintainer’s trusted setup; keep using local recipes
        while it is repaired.
      </AppText>
      {state?.connectionError && (
        <Notice title="Connection needs attention" tone="error">
          <AppText>{errorCopy(state.connectionError)}</AppText>
          {!state.connectionReady && (
            <ActionButton
              label="Retry restoring connection"
              onPress={() => void assistant?.restoreConnection()}
            />
          )}
        </Notice>
      )}
      {state?.connectionNotice && (
        <Notice title="Connection result">
          <AppText role="support" selectable>
            {state.connectionNotice}
          </AppText>
        </Notice>
      )}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    section: { gap: t.space.md },
    status: {
      backgroundColor: t.color.surface,
      padding: t.space.md,
      borderRadius: t.radius.card,
      gap: t.space.xs,
    },
    statusTitle: { flexDirection: 'row', alignItems: 'center', gap: t.space.sm },
    statusText: { flex: 1 },
    disclosure: { gap: t.space.xs },
    form: {
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      gap: t.space.sm,
    },
  });
