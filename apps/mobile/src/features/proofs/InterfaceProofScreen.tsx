import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { getRecipe } from '@cookmate/catalogue';
import { useRouter } from 'expo-router';
import { ActionButton, Notice, SegmentControl, useControlStyles } from '../../components/Controls';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { PurchaseRow } from '../shopping/PurchaseRow';
import { EmptyFavourites } from '../workspace/FavouritesScreen';
import { RecipeCard } from '../../components/RecipeCard';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { AccountScopeReviewPanel } from '../account/AccountScopeReviewPanel';
import type { AccountScopeApprovalReview } from '../../data/accountScopeApproval';

const scopeExample: AccountScopeApprovalReview = {
  reviewId: '10000000-0000-4000-8000-000000000001',
  ownerId: '10000000-0000-4000-8000-000000000002',
  counts: { notes: 3, collections: 2, memberships: 7, manualItems: 4, cookingHistory: 5 },
  historyIncluded: false,
  previousApprovalDigest: null,
};

function SyncScopeProof() {
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <View style={{ gap: 16 }}>
      <Notice title="Fictional sync review">
        These counts are examples. This screen has no signed-in account and cannot save permission
        or sync data.
      </Notice>
      {choice && <Notice title="Example only">{choice}</Notice>}
      <AccountScopeReviewPanel
        review={scopeExample}
        onApprove={(history) =>
          setChoice(
            `Example choice: history ${history ? 'included' : 'excluded'}. Nothing was saved or sent.`,
          )
        }
        onCancel={() => setChoice('Example cancelled. Nothing was saved or sent.')}
      />
    </View>
  );
}

function TitleProof() {
  const { columns } = useNativeLayout();
  const base = getRecipe('53289')!;
  const fixtures = [
    {
      ...base,
      title:
        'وصفة تجريبية — Creamy chicken with spinach, tomatoes and a long original recipe title',
    },
    getRecipe('53092')!,
  ];
  return (
    <View style={{ gap: 16 }}>
      <AppText role="section">Title wrapping examples</AppText>
      <AppText role="support">
        The mixed-script title is a synthetic typography fixture, not a recipe or translation.
        Photographs are existing catalogue assets. These display-only cards cannot open or save.
      </AppText>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...(Platform.OS === 'web' ? { inert: true } : {})}
        style={{ flexDirection: 'row', flexWrap: 'wrap' }}
      >
        {fixtures.map((recipe) => (
          <View key={recipe.recipeId} style={{ width: `${100 / columns}%`, padding: 4 }}>
            <RecipeCard recipe={recipe} presentation="editorial" />
          </View>
        ))}
      </View>
    </View>
  );
}

const sampleShopping = [
  ...(getRecipe('53150')?.ingredients ?? []).map((entry) => ({
    id: `example-${entry.position}`,
    name: entry.rawName,
    amount: entry.rawMeasure ?? 'Amount not supplied',
    changed: entry.position === 2,
  })),
  {
    id: 'example-salt',
    name: 'Sea salt',
    amount: 'Amount not supplied',
    changed: false,
  },
] as const;

function ShoppingProof() {
  const pageStyles = usePageStyles();

  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set(['example-1']));
  const [updating, setUpdating] = useState(false);
  return (
    <View style={pageStyles.section}>
      <AppText role="section" accessibilityRole="header">
        Shopping
      </AppText>
      <AppText>Example selection: Padron peppers · Monday 28 September 2026 · Dinner</AppText>
      <AppText role="support" color="inkSecondary">
        Fictional selection and purchase state. Ingredient wording comes from recipe 53150; sea salt
        is an instruction-only source note.
      </AppText>
      <ActionButton
        label={updating ? 'Show current-list example' : 'Show updating-list example'}
        variant="secondary"
        onPress={() => setUpdating(!updating)}
      />
      {updating && (
        <Notice title="Updating your shopping list…">
          The displayed demand is outdated. Purchase changes are unavailable until the list is
          current.
        </Notice>
      )}
      <View>
        {sampleShopping.map((item) => (
          <PurchaseRow
            key={item.id}
            name={item.name}
            amount={item.amount}
            purchased={checked.has(item.id)}
            changed={item.changed}
            unavailable={updating}
            onToggle={() => {
              setChecked((previous) => {
                const next = new Set(previous);
                if (next.has(item.id)) next.delete(item.id);
                else next.add(item.id);
                return next;
              });
            }}
          />
        ))}
      </View>
      <Notice title="Source note" tone="caution">
        The instructions mention sea salt but the ingredient list does not supply an amount. Inspect
        the recipe before shopping.
      </Notice>
      <AppText role="support">
        Toggling these examples only changes this proof screen. It does not save purchase progress.
      </AppText>
    </View>
  );
}

const actionExamples = {
  proposed: {
    title: 'Proposed',
    text: 'Add Fettuccine Alfredo to dinner on Monday 28 September 2026?',
  },
  applying: { title: 'Adding your meal…', text: 'Waiting for the device to confirm the change.' },
  committed: {
    title: 'Example receipt · meal added',
    text: 'Fettuccine Alfredo · Monday 28 September 2026 · Dinner. This is a fictional receipt illustration.',
  },
  uncertain: {
    title: 'Checking whether your meal was added…',
    text: 'The result hasn’t been confirmed. Check the existing operation before trying another write.',
  },
  failed: {
    title: 'Couldn’t add the meal',
    text: 'The example operation failed. The earlier plan remains unchanged.',
  },
  partial: {
    title: 'Example partial result',
    text: 'Recipe saved. Meal was not added. Only the failed meal action is eligible to try again after checking its result.',
  },
} as const;

function AssistantProof() {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();
  const controlStyles = useControlStyles();

  const router = useRouter();
  const [state, setState] = useState<keyof typeof actionExamples>('proposed');
  const [draft, setDraft] = useState('');
  const [pressedSend, setPressedSend] = useState(false);
  const example = actionExamples[state];
  return (
    <View style={pageStyles.section}>
      <AppText role="section" color="assistant" accessibilityRole="header">
        Assistant
      </AppText>
      <View style={styles.userTurn}>
        <AppText role="label" color="inkSecondary">
          You
        </AppText>
        <AppText>Show me the two Alfredo recipes.</AppText>
      </View>
      <View style={styles.assistantTurn}>
        <AppText role="label" color="assistant">
          CookMate
        </AppText>
        <AppText>
          Here are the two recipes in the collection. Open either one to read its supplied
          ingredients and instructions.
        </AppText>
      </View>
      {['53064', '52835'].map((id, index) => {
        const recipe = getRecipe(id);
        return recipe ? (
          <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityLabel={`Suggestion ${index + 1}, ${recipe.title}`}
            onPress={() => router.push({ pathname: '/recipe/[id]', params: { id } })}
            style={styles.reference}
          >
            <View style={styles.thumbnail}>
              <RecipePhoto compact recipeId={id} title={recipe.title} aspectRatio={1} />
            </View>
            <View style={styles.referenceText}>
              <AppText role="bodyStrong">
                {index + 1}. {recipe.title}
              </AppText>
              <AppText role="support">{recipe.cuisine} · Open recipe</AppText>
            </View>
          </Pressable>
        ) : null;
      })}
      <AppText role="label">Example action state</AppText>
      <SegmentControl
        value={state}
        onChange={setState}
        options={Object.keys(actionExamples).map((value) => ({
          value: value as keyof typeof actionExamples,
          label: value.charAt(0).toUpperCase() + value.slice(1),
        }))}
      />
      <Notice title={example.title} tone={state === 'failed' ? 'error' : 'neutral'}>
        {example.text}
      </Notice>
      <AppText role="support" color="inkSecondary">
        All action states here are fictional. No plan, favourite or conversation is written.
      </AppText>
      <AppText role="label">Keyboard and composer example</AppText>
      <TextInput
        accessibilityLabel="Example assistant draft, not saved"
        value={draft}
        onChangeText={setDraft}
        placeholder="Try typing a question…"
        placeholderTextColor={t.color.inkSecondary}
        multiline
        style={controlStyles.field}
      />
      <ActionButton
        label="Try example send"
        disabled={!draft.trim()}
        onPress={() => setPressedSend(true)}
      />
      {pressedSend && (
        <Notice title="Example only">
          No message was sent or saved. Your text remains here for the keyboard proof.
        </Notice>
      )}
    </View>
  );
}

export default function InterfaceProofScreen() {
  const styles = useThemedStyles(createStyles);

  const [section, setSection] = useState<
    'shopping' | 'assistant' | 'favourites' | 'titles' | 'sync'
  >('shopping');
  return (
    <KeyboardAvoidingView behavior="padding" style={styles.root}>
      <Page bottomInset>
        <PageHeader back />
        <AppText role="title" accessibilityRole="header">
          Interface proof states
        </AppText>
        <Notice title="Examples only · no saved changes" tone="caution">
          This development screen demonstrates components with fictional state. It does not
          represent your plan, shopping list or a live assistant answer.
        </Notice>
        <SegmentControl
          value={section}
          onChange={setSection}
          options={[
            { value: 'shopping', label: 'Shopping' },
            { value: 'assistant', label: 'Assistant' },
            { value: 'favourites', label: 'Favourites' },
            { value: 'titles', label: 'Titles' },
            { value: 'sync', label: 'Sync review' },
          ]}
        />
        {section === 'shopping' ? (
          <ShoppingProof />
        ) : section === 'assistant' ? (
          <AssistantProof />
        ) : section === 'titles' ? (
          <TitleProof />
        ) : section === 'sync' ? (
          <SyncScopeProof />
        ) : (
          <EmptyFavourites />
        )}
      </Page>
    </KeyboardAvoidingView>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1 },
    userTurn: {
      backgroundColor: t.color.selection,
      borderRadius: t.radius.card,
      padding: t.space.md,
      marginLeft: t.space.lg,
      gap: t.space.xs,
      borderBottomRightRadius: t.space.xxs,
    },
    assistantTurn: {
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      borderTopLeftRadius: t.space.xxs,
      gap: t.space.xs,
    },
    reference: {
      flexDirection: 'row',
      gap: t.space.sm,
      alignItems: 'center',
      minHeight: t.control.minimumTarget,
      padding: t.space.sm,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
    },
    thumbnail: { width: t.layout.thumbnail },
    referenceText: { flex: 1, gap: t.space.xxs },
  });
