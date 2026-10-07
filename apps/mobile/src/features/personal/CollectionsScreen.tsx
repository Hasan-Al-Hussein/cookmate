import { useCallback, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { personalLimits } from '@cookmate/domain';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { ActionButton, Notice } from '../../components/Controls';
import { useUnsavedDraft } from '../../hooks/useUnsavedDraft';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import {
  PersonalField,
  PersonalOperationFeedback,
  PersonalPrivacy,
  PersonalUnavailable,
  usePersonalStyles,
  validPersonalText,
} from './PersonalUI';
import {
  useCollectionData,
  useCollectionPorts,
  type CollectionDataPorts,
} from './useCollectionPorts';
import { usePersonalSubmission } from './usePersonalSubmission';

export default function CollectionsScreen() {
  const ports = useCollectionPorts();
  const content = useOrdinaryContentRuntime();
  const pageStyles = usePageStyles();
  return (
    <KeyboardAvoidingView
      style={pageStyles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Page bottomInset>
        <PageHeader back title="Your collections" />
        {ports ? (
          <CollectionsList key={ports.scopeKey} {...ports} />
        ) : content ? (
          <Notice title="Collections are unavailable here">
            Return after this workspace’s update or recovery finishes to check collections and any
            pending change.
          </Notice>
        ) : (
          <PersonalUnavailable />
        )}
      </Page>
    </KeyboardAvoidingView>
  );
}
export function CollectionsList(ports: CollectionDataPorts) {
  const { service } = ports;
  const styles = usePersonalStyles();
  const router = useRouter();
  const read = useCallback(() => service.readCollections(), [service]);
  const { query, operation, ready, isCurrent } = useCollectionData(ports, read);
  const [name, setName] = useState('');
  const [collectionId, setCollectionId] = useState(() => Crypto.randomUUID());
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const submission = usePersonalSubmission(
    operation.receipt,
    name,
    (unchanged) => {
      if (!isCurrent()) return;
      if (unchanged) setName('');
      setCollectionId(Crypto.randomUUID());
      setDraftMessage(
        unchanged
          ? null
          : 'Your earlier collection was saved. Your newer name is kept as a separate draft.',
      );
    },
    () => {
      if (!isCurrent()) return;
      setDraftMessage(
        'The earlier request was cancelled. Your draft is kept; review the refreshed collections before saving again.',
      );
    },
  );
  const current = useRef({ name, collectionId, snapshot: query.value, ready });
  current.current = { name, collectionId, snapshot: query.value, ready };
  const owns = () =>
    isCurrent() &&
    current.current.name === name &&
    current.current.collectionId === collectionId &&
    current.current.snapshot === query.value;
  useUnsavedDraft(!!name, 'Discard collection name?');
  async function create() {
    const snapshot = query.value;
    if (
      !snapshot ||
      !owns() ||
      !current.current.ready ||
      !validPersonalText(name, personalLimits.collectionNameCharacters)
    )
      return;
    await operation.perform((operationId) => {
      if (!owns() || current.current.snapshot !== snapshot)
        throw new Error('Collection context changed');
      submission.bind(operationId, collectionId, 'createCollection');
      return service.execute({
        kind: 'createCollection',
        operationId,
        expectedEpoch: snapshot.epoch,
        collectionId,
        name,
      });
    });
  }
  return (
    <View style={styles.section}>
      <PersonalOperationFeedback operation={operation} />
      {query.loading && <AppText role="support">Loading your collections…</AppText>}
      {query.error && (
        <Notice title="Collections need attention" tone="error">
          <AppText>{query.error}</AppText>
          <ActionButton
            label="Retry collections"
            variant="secondary"
            disabled={query.loading || operation.busy}
            onPress={() => void query.reload()}
          />
        </Notice>
      )}
      {query.value?.items.map((collection) => (
        <View key={collection.collectionId} style={styles.card}>
          <AppText role="section">{collection.name}</AppText>
          <AppText role="support">
            {collection.memberCount} {collection.memberCount === 1 ? 'recipe' : 'recipes'}
          </AppText>
          <ActionButton
            label={`Open ${collection.name}`}
            variant="secondary"
            onPress={() => {
              if (owns())
                router.push({
                  pathname: '/collection/[id]',
                  params: { id: collection.collectionId },
                });
            }}
          />
        </View>
      ))}
      <View style={styles.card}>
        <AppText role="section">
          {query.value?.items.length === 0 ? 'Make room for your favourites.' : 'New collection'}
        </AppText>
        <AppText color="inkSecondary">
          {query.value?.items.length === 0
            ? 'Give your first collection a name — for busy weeknights, a special occasion or whatever you enjoy cooking.'
            : 'Gather recipes around a meal, a mood or an occasion.'}
        </AppText>
        <PersonalField
          label="Collection name"
          value={name}
          onChangeText={(value) => {
            if (isCurrent()) setName(value);
          }}
          editable={isCurrent() && !operation.busy}
          limit={personalLimits.collectionNameCharacters}
        />
        <ActionButton
          label="Create collection"
          disabled={
            !ready ||
            !query.value ||
            !validPersonalText(name, personalLimits.collectionNameCharacters) ||
            query.value.items.length >= personalLimits.collections
          }
          onPress={() => void create()}
        />
        {draftMessage && <AppText role="support">{draftMessage}</AppText>}
        {query.value && query.value.items.length >= personalLimits.collections && (
          <AppText role="support">
            The local limit is {personalLimits.collections} collections. Remove an unused collection
            before adding another.
          </AppText>
        )}
      </View>
      <AppText role="support" color="inkSecondary">
        Collections keep recipes together. Your saved hearts stay independent.
      </AppText>
      <PersonalPrivacy />
    </View>
  );
}
