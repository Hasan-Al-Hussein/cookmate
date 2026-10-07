import { useCallback, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getRecipe } from '@cookmate/catalogue';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { RecipePhoto } from '../../components/RecipePhoto';
import { Notice } from '../../components/Controls';
import {
  PersonalOperationFeedback,
  PersonalUnavailable,
  usePersonalPorts,
  usePersonalStyles,
  type PersonalPorts,
} from './PersonalUI';
import { usePersonalQuery } from './usePersonalQuery';
import { usePersonalOperations } from './usePersonalOperations';
import { RecipeNoteEditor } from './RecipeNoteEditor';
import { ContentRecipeNote, parseRecipeNoteTarget } from './ContentRecipeNote';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { ContentRecipeMemberships, RecipeMembershipControls } from './RecipeCollectionMemberships';

export default function RecipePersonalScreen() {
  const { id, contentRef } = useLocalSearchParams<{ id: string; contentRef?: string }>();
  const content = useOrdinaryContentRuntime();
  const target = useMemo(() => parseRecipeNoteTarget(id, contentRef), [id, contentRef]);
  const ports = usePersonalPorts();
  const pageStyles = usePageStyles();
  return (
    <KeyboardAvoidingView
      style={pageStyles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Page bottomInset>
        <PageHeader back title="Your recipe notes" />
        {content ? (
          target ? (
            <ContentRecipeNote
              host={content.host}
              target={target}
              membershipControl={<ContentRecipeMemberships recipeId={target.recipeId} />}
            />
          ) : (
            <Notice title="Recipe reference unavailable">
              Return to the recipe and reopen its private note.
            </Notice>
          )
        ) : contentRef !== undefined ? (
          <Notice title="Recipe version unavailable">
            This exact recipe reference needs its signed-content workspace.
          </Notice>
        ) : ports && typeof id === 'string' ? (
          <RecipePersonalEditor key={id} {...ports} recipeId={id} />
        ) : (
          <PersonalUnavailable />
        )}
      </Page>
    </KeyboardAvoidingView>
  );
}
export function RecipePersonalEditor({
  service,
  readInstallationId,
  recipeId,
}: PersonalPorts & { recipeId: string }) {
  const styles = usePersonalStyles();
  const router = useRouter();
  const recipe = getRecipe(recipeId);
  const readPersonal = useCallback(() => service.readRecipePersonal(recipeId), [service, recipeId]);
  const readCollections = useCallback(() => service.readCollections(), [service]);
  const personal = usePersonalQuery(service, readPersonal, 'recipe');
  const collections = usePersonalQuery(service, readCollections, 'collections');
  const operation = usePersonalOperations(service, readInstallationId);
  const [editing, setEditing] = useState(false);
  async function membership(collectionId: string, collectionRevision: number, present: boolean) {
    const snapshot = personal.value;
    if (
      !snapshot ||
      !operation.ready ||
      personal.loading ||
      personal.error ||
      collections.loading ||
      collections.error
    )
      return;
    const previous = snapshot.memberships.find((item) => item.collectionId === collectionId);
    const saved = await operation.perform((operationId) =>
      service.execute({
        kind: 'setCollectionMembership',
        operationId,
        expectedEpoch: snapshot.epoch,
        collectionId,
        recipeId,
        expectedCollectionRevision: collectionRevision,
        expectedRevision: previous?.revision ?? null,
        present,
      }),
    );
    if (saved) await personal.reload();
  }
  return (
    <View style={styles.section}>
      {recipe ? (
        <View style={styles.row}>
          <View style={styles.photo}>
            <RecipePhoto recipeId={recipeId} title={recipe.title} compact aspectRatio={1} />
          </View>
          <AppText role="section" style={styles.text}>
            {recipe.title}
          </AppText>
        </View>
      ) : (
        <Notice title="Recipe unavailable">
          This recipe reference is not in the current catalogue.
        </Notice>
      )}
      <PersonalOperationFeedback operation={operation} />
      <RecipeNoteEditor
        recipeId={recipeId}
        query={personal}
        operation={operation}
        execute={service.execute}
        canAddNote={!!recipe}
        onEditingChange={setEditing}
      />
      {!editing && (
        <RecipeMembershipControls
          collections={collections.value}
          memberships={personal.value?.memberships ?? []}
          error={collections.error}
          loading={collections.loading}
          ready={
            operation.ready &&
            !!personal.value &&
            !personal.loading &&
            !personal.error &&
            !collections.loading &&
            !collections.error
          }
          canAdd={!!recipe}
          onRetry={() => void collections.reload()}
          onToggle={(...args) => void membership(...args)}
          onManage={() => router.push('/collections')}
        />
      )}
    </View>
  );
}
