import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { runHttpsProbe, runNativeAdapterProbe } from './nativeProbe';

export default function FoundationProbeScreen() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('No checks have run on this device.');
  const [endpoint, setEndpoint] = useState('');
  async function run(probe: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      setResult(JSON.stringify(await probe(), null, 2));
    } catch {
      setResult('Probe failed before completion. No passing result is claimed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>
          CookMate · Foundation probe
        </Text>
        <Text style={styles.copy}>
          Private compatibility checks using disposable state. This is a development screen, not the
          CookMate product interface.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          style={styles.button}
          onPress={() => void run(runNativeAdapterProbe)}
        >
          <Text style={styles.buttonText}>{busy ? 'Checking…' : 'Run native adapter checks'}</Text>
        </Pressable>
        <View style={styles.section}>
          <Text style={styles.copy}>Trusted operator endpoint</Text>
          <TextInput
            accessibilityLabel="Trusted HTTPS endpoint"
            value={endpoint}
            onChangeText={setEndpoint}
            placeholder="https://your-private-host:8443"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy || !endpoint }}
            disabled={busy || !endpoint}
            style={styles.button}
            onPress={() => void run(() => runHttpsProbe(endpoint))}
          >
            <Text style={styles.buttonText}>Check HTTPS health only</Text>
          </Pressable>
        </View>
        <Text selectable accessibilityLiveRegion="polite" style={styles.result}>
          {result}
        </Text>
        <Text style={styles.copy}>
          Connection reopen is separate from standalone launch, process restart, uninstall, backup
          and real phone trust testing. Record the build and device with results.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#ffffff' },
  content: { padding: 24, gap: 20 },
  title: { fontSize: 24, fontWeight: '600', color: '#171717' },
  copy: { fontSize: 16, lineHeight: 24, color: '#333333' },
  button: {
    minHeight: 48,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#272727',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#777777',
    borderRadius: 8,
    padding: 12,
    color: '#171717',
    fontSize: 16,
  },
  section: { gap: 12 },
  result: { fontSize: 14, lineHeight: 22, color: '#171717' },
});
