import { View } from 'react-native';
import FoundationProbeScreen from '../src/foundation/FoundationProbeScreen';
import { PageHeader } from '../src/components/Page';
import { designTokens as t } from '../src/design';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function DiagnosticRoute() {
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: t.color.canvas }}
      edges={['top', 'left', 'right']}
    >
      <View style={{ paddingHorizontal: t.space.gutter }}>
        <PageHeader back />
      </View>
      <FoundationProbeScreen />
    </SafeAreaView>
  );
}
