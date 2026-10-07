import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  personalLimits,
  type DeleteCollectionReview,
  type Immutable,
  type PersonalCollectionPage,
} from '@cookmate/domain';
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
import { CollectionRecipeRow } from './CollectionRecipeRow';
import { usePersonalSubmission } from './usePersonalSubmission';
import { usePersonalQuery } from './usePersonalQuery';

const reviewPageSize = 20;
const append = (
  previous: Immutable<PersonalCollectionPage>,
  next: Immutable<PersonalCollectionPage>,
): Immutable<PersonalCollectionPage> => {
  if (
    previous.epoch !== next.epoch ||
    previous.collection.collectionId !== next.collection.collectionId ||
    previous.collection.revision !== next.collection.revision ||
    next.items.some((row) => previous.items.some((old) => old.recipeId === row.recipeId))
  )
    throw new Error('Collection page changed');
  return { ...next, items: [...previous.items, ...next.items] };
};
export default function CollectionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ports = useCollectionPorts();
  const content = useOrdinaryContentRuntime();
  const pageStyles = usePageStyles();
  return (
    <KeyboardAvoidingView
      style={pageStyles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Page bottomInset>
        <PageHeader back />
        {ports && typeof id === 'string' ? (
          <CollectionDetails key={`${ports.scopeKey}:${id}`} {...ports} collectionId={id} />
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
export function CollectionDetails({
  service,
  readInstallationId,
  collectionId,
  ...context
}: CollectionDataPorts & { collectionId: string }) {
  const styles = usePersonalStyles();
  const router = useRouter();
  const read = useCallback(
    (cursor?: string) =>
      service.readCollection(collectionId, { limit: 20, ...(cursor ? { cursor } : {}) }),
    [service, collectionId],
  );
  const {
    query,
    operation,
    ready: dataReady,
    isCurrent,
  } = useCollectionData({ service, readInstallationId, ...context }, read, append);
  const mode = context.mode ?? 'bundled';
  const readList = useCallback(() => service.readCollections(), [service]);
  const list = usePersonalQuery(service, readList, 'collections', undefined, isCurrent);
  const [checkedDeletion, setCheckedDeletion] = useState<typeof operation.receipt>(null);
  const currentList = useRef(list);
  currentList.current = list;
  const pendingList = useRef<{
    receipt: NonNullable<typeof operation.receipt>;
    previous: typeof list.value;
  } | null>(null);
  const deletion =
    operation.receipt?.commandKind === 'deleteCollection' &&
    operation.receipt.entityId === collectionId &&
    (operation.receipt.outcome === 'committed' || operation.receipt.outcome === 'no_op')
      ? operation.receipt
      : null;
  useEffect(() => {
    if (!deletion || !isCurrent()) return;
    pendingList.current = { receipt: deletion, previous: currentList.current.value };
    void currentList.current.refresh().then((value) => {
      if (value && isCurrent() && pendingList.current?.receipt === deletion)
        setCheckedDeletion(deletion);
    });
  }, [deletion, isCurrent]);
  useEffect(() => {
    if (
      deletion &&
      pendingList.current?.receipt === deletion &&
      list.value &&
      list.value !== pendingList.current.previous &&
      !list.loading &&
      !list.error &&
      isCurrent()
    )
      setCheckedDeletion(deletion);
  }, [deletion, list.value, list.loading, list.error, isCurrent]);
  // Read failure is not proof of deletion. A fresh list and the exact receipt must agree.
  const provenDelete =
    !!deletion &&
    checkedDeletion === deletion &&
    !list.loading &&
    !list.error &&
    list.value?.epoch === deletion.epoch &&
    !list.value.items.some((row) => row.collectionId === collectionId && !row.deleted);
  const ready =
    dataReady && (!deletion || (checkedDeletion === deletion && !list.loading && !list.error));
  const [rename, setRename] = useState<{
    name: string;
    baseline: string;
    revision: number;
    epoch: number;
  } | null>(null);
  const [review, setReviewValue] = useState<Immutable<DeleteCollectionReview> | null>(null);
  const [reviewPage, setReviewPage] = useState(0);
  const reviewLifetime = useRef(0);
  function setReview(value: Immutable<DeleteCollectionReview> | null) {
    reviewLifetime.current++;
    setReviewPage(0);
    setReviewValue(value);
  }
  const reviewOffset = reviewPage * reviewPageSize;
  const reviewVersion = reviewLifetime.current;
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const reviewGeneration = useRef(0);
  const current = useRef({ snapshot: query.value, rename, review, ready, reviewPage });
  current.current = { snapshot: query.value, rename, review, ready, reviewPage };
  const owns = () => isCurrent() && current.current.snapshot === query.value;
  const renameSubmission = usePersonalSubmission(
    operation.receipt,
    rename?.name ?? '',
    (unchanged) => {
      if (!isCurrent()) return;
      if (unchanged) setRename(null);
    },
    () => {
      if (isCurrent()) setReview(null);
    },
  );
  useEffect(() => {
    if (deletion || operation.receipt?.outcome === 'cancelled') {
      current.current.review = null;
      setReview(null);
    }
  }, [deletion, operation.receipt]);
  useEffect(() => {
    if (provenDelete) {
      setReview(null);
      setRename(null);
    }
  }, [provenDelete]);
  useFocusEffect(
    useCallback(() => {
      reviewGeneration.current++;
      setReview(null);
      setReviewBusy(false);
      return () => {
        reviewGeneration.current++;
        setReview(null);
      };
    }, [collectionId]),
  );
  useUnsavedDraft(!!rename && rename.name !== rename.baseline, 'Discard collection rename?');
  async function saveName() {
    if (!rename || !ready) return;
    if (
      !owns() ||
      current.current.rename !== rename ||
      !current.current.ready ||
      !query.value ||
      rename.revision !== query.value.collection.revision ||
      rename.epoch !== query.value.epoch ||
      !validPersonalText(rename.name, personalLimits.collectionNameCharacters)
    )
      return;
    await operation.perform((operationId) => {
      if (!owns() || current.current.rename !== rename) throw new Error('Collection changed');
      renameSubmission.bind(operationId, collectionId, 'renameCollection');
      return service.execute({
        kind: 'renameCollection',
        operationId,
        expectedEpoch: rename.epoch,
        collectionId,
        expectedRevision: rename.revision,
        name: rename.name,
      });
    });
  }
  async function reviewDelete() {
    if (!ready || !owns() || !current.current.ready) return;
    const generation = reviewGeneration.current;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const result = await service.reviewDeleteCollection(collectionId);
      if (!owns() || reviewGeneration.current !== generation) return;
      if (result.kind === 'ready') setReview(result.value);
      else setReviewError('The current collection could not be reviewed. Nothing was deleted.');
    } catch {
      if (isCurrent() && reviewGeneration.current === generation)
        setReviewError('The deletion review could not be loaded. Nothing was deleted.');
    } finally {
      if (isCurrent() && reviewGeneration.current === generation) setReviewBusy(false);
    }
  }
  async function deleteReviewed() {
    if (
      !review ||
      !ready ||
      !owns() ||
      current.current.review !== review ||
      reviewLifetime.current !== reviewVersion ||
      !current.current.ready
    )
      return;
    await operation.perform((operationId) => {
      if (!owns() || current.current.review !== review || reviewLifetime.current !== reviewVersion)
        throw new Error('Deletion review changed');
      return service.deleteCollection(review, operationId);
    });
  }
  async function removeRecipe(recipeId: string, revision: number) {
    const snapshot = query.value;
    if (!snapshot || !ready || !owns() || !current.current.ready) return;
    await operation.perform((operationId) => {
      if (!owns()) throw new Error('Collection changed');
      return service.execute({
        kind: 'setCollectionMembership',
        operationId,
        expectedEpoch: snapshot.epoch,
        collectionId,
        recipeId,
        expectedCollectionRevision: snapshot.collection.revision,
        expectedRevision: revision,
        present: false,
      });
    });
  }
  if (provenDelete)
    return (
      <View style={styles.section}>
        <AppText role="title">Collection deleted</AppText>
        <AppText>
          The collection and its memberships were removed. Saved favourites, private recipe notes
          and meal plans remain unchanged.
        </AppText>
        <PersonalOperationFeedback operation={operation} />
        <ActionButton
          label="Return to collections"
          variant="secondary"
          onPress={() => {
            if (isCurrent()) router.navigate('/collections');
          }}
        />
      </View>
    );
  const renameStale =
    !!rename &&
    !!query.value &&
    (rename.revision !== query.value.collection.revision || rename.epoch !== query.value.epoch);
  return (
    <View style={styles.section}>
      <AppText role="title">{query.value?.collection.name ?? 'Collection'}</AppText>
      <PersonalOperationFeedback operation={operation} />
      {(query.error || (list.error && deletion)) && (
        <Notice title="Collection unavailable" tone="error">
          <AppText>{query.error ?? list.error}</AppText>
          {deletion && (
            <AppText role="support">
              The receipt confirms an earlier deletion only. The current collection could not be
              checked and may have changed since; retry before drawing conclusions.
            </AppText>
          )}
          <ActionButton
            label="Retry collection"
            variant="secondary"
            disabled={query.loading || operation.busy}
            onPress={() => {
              if (!isCurrent()) return;
              setReview(null);
              void query.reload();
              void list.reload();
            }}
          />
        </Notice>
      )}
      {query.loading && <AppText role="support">Loading collection…</AppText>}
      {query.value && (
        <AppText role="support">
          {query.value.collection.memberCount}{' '}
          {query.value.collection.memberCount === 1 ? 'recipe' : 'recipes'}. Removing a member here
          never unsaves its heart.
        </AppText>
      )}
      {rename ? (
        <View style={styles.card}>
          <PersonalField
            label="Collection name"
            value={rename.name}
            onChangeText={(name) => {
              if (isCurrent() && current.current.rename === rename) setRename({ ...rename, name });
            }}
            limit={personalLimits.collectionNameCharacters}
            editable={!operation.busy}
          />
          <ActionButton
            label="Save collection name"
            disabled={
              !ready ||
              renameStale ||
              rename.name === rename.baseline ||
              !validPersonalText(rename.name, personalLimits.collectionNameCharacters)
            }
            onPress={() => void saveName()}
          />
          {renameStale && query.value && (
            <Notice title="Review the updated collection">
              <AppText>
                Current saved name: {query.value.collection.name}. Your draft is kept above.
              </AppText>
              <ActionButton
                label="Use current collection for this rename"
                variant="secondary"
                disabled={!ready}
                onPress={() => {
                  if (owns() && current.current.rename === rename && query.value)
                    setRename({
                      ...rename,
                      baseline: query.value.collection.name ?? '',
                      revision: query.value.collection.revision,
                      epoch: query.value.epoch,
                    });
                }}
              />
            </Notice>
          )}
          <ActionButton
            label="Cancel rename"
            variant="quiet"
            disabled={operation.busy}
            onPress={() => {
              if (isCurrent()) {
                current.current.rename = null;
                setRename(null);
              }
            }}
          />
        </View>
      ) : (
        query.value && (
          <ActionButton
            label="Rename collection"
            variant="secondary"
            disabled={!ready || !!review}
            onPress={() => {
              const snapshot = query.value;
              if (owns() && current.current.ready && snapshot)
                setRename({
                  name: snapshot.collection.name ?? '',
                  baseline: snapshot.collection.name ?? '',
                  revision: snapshot.collection.revision,
                  epoch: snapshot.epoch,
                });
            }}
          />
        )
      )}
      {query.value?.items.map((member) => (
        <CollectionRecipeRow
          key={member.recipeId}
          recipeId={member.recipeId}
          mode={mode}
          isCurrent={isCurrent}
          disabled={!ready || !!rename || !!review}
          onRemove={() => void removeRecipe(member.recipeId, member.revision)}
        />
      ))}
      {query.value?.collection.memberCount === 0 && (
        <View style={styles.card}>
          <AppText role="section">Start with a recipe you love.</AppText>
          <AppText>Explore recipes, then use “Private note & collections” to add one here.</AppText>
        </View>
      )}
      {query.value?.nextCursor && (
        <ActionButton
          label="Load more collection recipes"
          variant="secondary"
          disabled={query.loading || operation.busy}
          onPress={() => {
            if (owns() && !query.loading && query.value?.nextCursor)
              void query.loadMore(query.value.nextCursor);
          }}
        />
      )}
      <ActionButton
        label="Find recipes to collect"
        variant={query.value?.collection.memberCount === 0 ? 'primary' : 'quiet'}
        onPress={() => {
          if (isCurrent()) router.navigate('/');
        }}
      />
      {reviewError && (
        <Notice title="Deletion review unavailable" tone="error">
          {reviewError}
        </Notice>
      )}
      {review ? (
        <View style={styles.card}>
          <AppText role="section">Delete “{review.name}”?</AppText>
          <AppText>
            This removes the collection and exactly {review.affectedRecipeIds.length}{' '}
            {review.affectedRecipeIds.length === 1 ? 'membership' : 'memberships'}. Saved
            favourites, recipe notes, cooking history and meal plans remain unchanged.
          </AppText>
          {review.affectedRecipeIds.length > 0 && (
            <AppText role="support" accessibilityLiveRegion="polite">
              Members {reviewOffset + 1}–
              {Math.min(reviewOffset + reviewPageSize, review.affectedRecipeIds.length)} of{' '}
              {review.affectedRecipeIds.length}
            </AppText>
          )}
          {review.affectedRecipeIds.slice(reviewOffset, reviewOffset + reviewPageSize).map((id) => (
            <CollectionRecipeRow
              key={id}
              recipeId={id}
              mode={mode}
              isCurrent={isCurrent}
              labelOnly
            />
          ))}
          {review.affectedRecipeIds.length > reviewPageSize && (
            <View style={styles.actions}>
              <ActionButton
                label="Previous affected members"
                variant="quiet"
                disabled={reviewPage === 0 || operation.busy}
                onPress={() => {
                  if (
                    isCurrent() &&
                    current.current.review === review &&
                    reviewLifetime.current === reviewVersion &&
                    current.current.reviewPage === reviewPage &&
                    !operation.busy &&
                    reviewPage > 0
                  )
                    setReviewPage(reviewPage - 1);
                }}
              />
              <ActionButton
                label="Next affected members"
                variant="quiet"
                disabled={
                  reviewOffset + reviewPageSize >= review.affectedRecipeIds.length || operation.busy
                }
                onPress={() => {
                  if (
                    isCurrent() &&
                    current.current.review === review &&
                    reviewLifetime.current === reviewVersion &&
                    current.current.reviewPage === reviewPage &&
                    !operation.busy &&
                    reviewOffset + reviewPageSize < review.affectedRecipeIds.length
                  )
                    setReviewPage(reviewPage + 1);
                }}
              />
            </View>
          )}
          <ActionButton
            label="Confirm delete collection"
            disabled={!ready}
            onPress={() => void deleteReviewed()}
          />
          <ActionButton
            label="Keep collection"
            variant="quiet"
            disabled={operation.busy}
            onPress={() => {
              if (isCurrent()) {
                current.current.review = null;
                setReview(null);
              }
            }}
          />
        </View>
      ) : (
        query.value && (
          <ActionButton
            label="Review deleting collection"
            variant="quiet"
            disabled={!ready || !!rename || reviewBusy}
            onPress={() => void reviewDelete()}
          />
        )
      )}
      <PersonalPrivacy />
    </View>
  );
}
