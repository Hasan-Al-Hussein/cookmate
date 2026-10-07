import { useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import type {
  CollectionMembership,
  Immutable,
  PersonalCollectionsSnapshot,
} from '@cookmate/domain';
import { AppText } from '../../components/Typography';
import { ActionButton, Notice } from '../../components/Controls';
import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { PersonalOperationFeedback, PersonalPrivacy, usePersonalStyles } from './PersonalUI';
import { useCollectionData, useCollectionPorts } from './useCollectionPorts';

export function RecipeMembershipControls({
  collections,
  memberships,
  error,
  loading,
  ready,
  canAdd = true,
  onRetry,
  onToggle,
  onManage,
}: {
  collections: Immutable<PersonalCollectionsSnapshot> | null;
  memberships: readonly Immutable<CollectionMembership>[];
  error: string | null;
  loading: boolean;
  ready: boolean;
  canAdd?: boolean;
  onRetry(): void;
  onToggle(collectionId: string, revision: number, present: boolean): void;
  onManage(): void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <>
      <AppText role="section">Collections</AppText>
      <AppText role="support" color="inkSecondary">
        Choose where to keep this recipe. Its saved heart stays independent.
      </AppText>
      {loading && <AppText role="support">Loading collections…</AppText>}
      {error && (
        <Notice title="Collections unavailable" tone="error">
          <AppText>{error}</AppText>
          <ActionButton
            label="Retry collections"
            variant="secondary"
            disabled={loading}
            onPress={onRetry}
          />
        </Notice>
      )}
      <View style={styles.memberships}>
        {collections?.items.map((collection) => {
          if (collection.deleted || collection.name === null) return null;
          const present = memberships.some(
            (item) => item.collectionId === collection.collectionId && item.present,
          );
          return (
            <ActionButton
              key={collection.collectionId}
              label={collection.name}
              accessibilityLabel={`${present ? 'Remove from' : 'Add to'} ${collection.name}`}
              accessibilityState={{ selected: present }}
              variant={present ? 'secondary' : 'quiet'}
              style={styles.membership}
              disabled={!ready || (!present && !canAdd)}
              onPress={() => onToggle(collection.collectionId, collection.revision, !present)}
            />
          );
        })}
      </View>
      {collections?.items.length === 0 && (
        <AppText>Create your first collection to group recipes your way.</AppText>
      )}
      <ActionButton label="Manage collections" variant="quiet" onPress={onManage} />
      <PersonalPrivacy />
    </>
  );
}
export function ContentRecipeMemberships({ recipeId }: { recipeId: string }) {
  const ports = useCollectionPorts(),
    runtime = useOrdinaryContentRuntime();
  return ports?.mode === 'content' && runtime ? (
    <ReadyMemberships
      key={`${ports.scopeKey}:${recipeId}`}
      recipeId={recipeId}
      ports={ports}
      service={runtime.host.collections}
    />
  ) : null;
}
function ReadyMemberships({
  recipeId,
  ports,
  service,
}: {
  recipeId: string;
  ports: NonNullable<ReturnType<typeof useCollectionPorts>>;
  service: NonNullable<ReturnType<typeof useOrdinaryContentRuntime>>['host']['collections'];
}) {
  const router = useRouter(),
    styles = usePersonalStyles();
  const read = useCallback(async () => {
    const memberships = await service.readRecipeMemberships(recipeId);
    if (!ports.isCurrent()) throw new Error('Collections changed');
    if (memberships.kind !== 'ready') return memberships;
    const collections = await service.readCollections();
    if (collections.kind !== 'ready') return collections;
    if (
      !ports.isCurrent() ||
      collections.value.epoch !== memberships.value.epoch ||
      collections.revision !== memberships.revision
    )
      throw new Error('Collections changed');
    return {
      kind: 'ready' as const,
      revision: collections.revision,
      value: {
        memberships: memberships.value.memberships,
        epoch: memberships.value.epoch,
        collections: collections.value,
      },
    };
  }, [service, recipeId, ports.isCurrent]);
  const { query, operation, ready, isCurrent } = useCollectionData(ports, read);
  const latest = useRef({ snapshot: query.value, ready, recipeId });
  latest.current = { snapshot: query.value, ready, recipeId };
  const owns = () =>
    isCurrent() && latest.current.snapshot === query.value && latest.current.recipeId === recipeId;
  async function toggle(collectionId: string, revision: number, present: boolean) {
    const snapshot = query.value;
    if (!snapshot || !owns() || !latest.current.ready) return;
    const previous = snapshot.memberships.find((row) => row.collectionId === collectionId);
    await operation.perform((operationId) => {
      if (!owns()) throw new Error('Collections changed');
      return service.execute({
        kind: 'setCollectionMembership',
        operationId,
        collectionId,
        recipeId,
        present,
        expectedEpoch: snapshot.epoch,
        expectedRevision: previous?.revision ?? null,
        expectedCollectionRevision: revision,
      });
    });
  }
  return (
    <View style={styles.section}>
      <PersonalOperationFeedback operation={operation} />
      <RecipeMembershipControls
        collections={query.value?.collections ?? null}
        memberships={query.value?.memberships ?? []}
        error={query.error}
        loading={query.loading}
        ready={ready}
        onRetry={() => {
          if (isCurrent()) void query.reload();
        }}
        onToggle={(...args) => void toggle(...args)}
        onManage={() => {
          if (isCurrent()) router.push('/collections');
        }}
      />
    </View>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    memberships: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    membership: {
      maxWidth: '100%',
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: t.radius.pill,
    },
  });
