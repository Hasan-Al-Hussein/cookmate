import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { getRecipe, type CatalogueRecipe } from '@cookmate/catalogue';
import { canonicalContentJson, type RecipeContentRef } from '@cookmate/catalogue/content';
import { ActionButton, Notice, SegmentControl } from '../../components/Controls';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { Page, PageHeader, usePageStyles } from '../../components/Page';
import { AppIcon, IconButton } from '../../components/Icon';
import { RecipePhoto } from '../../components/RecipePhoto';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { FavouriteButton } from '../workspace/FavouritesState';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { WorkspaceFeedback } from '../workspace/WorkspaceFeedback';
import { getRecipeSourceNotices } from './sourceNotices';
import { RecipeSources } from './RecipeSources';
import { CookingReader } from './CookingReader';
import { InstructionPassageView, UnplacedInstructionNotes } from './InstructionPassageView';
import { RecipeVideoCard } from './video/RecipeVideoCard';
import { safeSourceUrl, youtubeVideoId } from './video/videoModel';
import { AssistantEmblem } from '../assistant/AssistantEmblem';
import { RecipePersonalEntry } from '../personal/RecipePersonalEntry';
import { useOptionalOrdinaryCatalogue } from '../content/OrdinaryCatalogue';
import { OrdinaryRecipeReader, ordinaryRecipeTarget } from '../content/OrdinaryRecipeReader';
import { useRecordRecentRecipe } from '../recently-viewed/useRecordRecentRecipe';

export function RecipeIngredients({ recipe }: { recipe: CatalogueRecipe }) {
  const styles = useThemedStyles(createStyles);

  const { enlarged, width } = useNativeLayout();
  const stacked = enlarged || width < 360;
  return (
    <View>
      {recipe.ingredients.map((entry) => (
        <View
          key={entry.position}
          accessible
          style={[styles.ingredient, stacked && styles.stacked]}
        >
          <AppText
            role="bodyStrong"
            style={[styles.readingText, styles.ingredientName, stacked && styles.stackedText]}
          >
            {entry.rawName}
          </AppText>
          <AppText
            style={[styles.readingText, styles.measure, stacked && styles.stackedText]}
            color={entry.rawMeasure?.trim() ? 'ink' : 'inkSecondary'}
          >
            {entry.rawMeasure?.trim() ? entry.rawMeasure : 'Amount not supplied'}
          </AppText>
        </View>
      ))}
    </View>
  );
}

export function RecipeInstructions({ recipe }: { recipe: CatalogueRecipe }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.instructions}>
      <UnplacedInstructionNotes recipe={recipe} />
      {recipe.instructions.map((passage) => (
        <InstructionPassageView key={passage.sequence} recipe={recipe} passage={passage} />
      ))}
    </View>
  );
}

export function RecipeAnnotations({
  recipe,
  section,
  onViewSource,
}: {
  recipe: CatalogueRecipe;
  section: 'ingredients' | 'instructions' | 'source';
  onViewSource?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const pageStyles = usePageStyles();

  const [showReferences, setShowReferences] = useState(false);
  const sourceNotices = section === 'source' ? [] : getRecipeSourceNotices(recipe);
  const notes = recipe.annotations.filter(
    (note) =>
      section === 'source' ||
      (section === 'ingredients' &&
        (note.kind === 'instruction_only_ingredient' || note.kind === 'missing_measure')) ||
      (section === 'instructions' && note.kind !== 'source_gap' && note.kind !== 'missing_measure'),
  );
  const visibleNotes = [...sourceNotices, ...notes];
  if (!visibleNotes.length) return null;
  return (
    <View style={pageStyles.section}>
      {section === 'source' && notes.some((note) => note.evidence.length > 0) && (
        <ActionButton
          label={showReferences ? 'Hide worksheet references' : 'Show worksheet references'}
          variant="quiet"
          accessibilityState={{ expanded: showReferences }}
          onPress={() => setShowReferences((current) => !current)}
          style={styles.sourceDisclosure}
        />
      )}
      <Notice title={section === 'source' ? 'Source notes' : 'Recipe source notes'} tone="caution">
        {visibleNotes.map((note) => (
          <View key={note.annotationId} style={styles.annotationText}>
            <AppText role="support">{note.note}</AppText>
            <AnimatedDisclosure expanded={section === 'source' && showReferences}>
              <AppText role="support" color="inkSecondary">
                {showReferences &&
                  note.evidence
                    .map((locator) => `${locator.sheet} ${locator.column ?? 'row '}${locator.row}`)
                    .join(' · ')}
              </AppText>
            </AnimatedDisclosure>
          </View>
        ))}
        {section !== 'source' && onViewSource && (
          <ActionButton label="View source notes" variant="quiet" onPress={onViewSource} />
        )}
      </Notice>
    </View>
  );
}

function RecipeHero({ recipe }: { recipe: CatalogueRecipe }) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const router = useRouter();
  const { width } = useNativeLayout();
  const [photoWidth, setPhotoWidth] = useState(Math.min(width, t.layout.readingMaxWidth));
  const back = useRef<View>(null);
  const { registerFocusFallback } = useWorkspace();
  useFocusEffect(
    useCallback(
      () => registerFocusFallback(() => focusTarget(back.current)),
      [registerFocusFallback],
    ),
  );
  return (
    <View
      style={styles.hero}
      onLayout={({ nativeEvent }) => {
        if (nativeEvent.layout.width > 0) setPhotoWidth(nativeEvent.layout.width);
      }}
    >
      <RecipePhoto
        recipeId={recipe.recipeId}
        title={recipe.title}
        aspectRatio={photoWidth / RECIPE_PHOTO_HEIGHT}
        borderRadius={0}
      />
      <View style={styles.heroControls} pointerEvents="box-none">
        <IconButton
          ref={back}
          label="Back"
          name="back"
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        />
        <FavouriteButton recipeId={recipe.recipeId} title={recipe.title} compact inline />
      </View>
    </View>
  );
}

export default function RecipeDetailsScreen() {
  const catalogue = useOptionalOrdinaryCatalogue();
  const params = useLocalSearchParams<{
    id: string;
    contentRef?: string;
    section?: string;
    cook?: string;
  }>();
  const router = useRouter();
  let matchingBundledExact = false;
  if (
    params.contentRef !== undefined &&
    catalogue?.state.kind === 'ready' &&
    catalogue.state.mode === 'bundled'
  ) {
    try {
      const target = ordinaryRecipeTarget(params.id, params.contentRef);
      const snapshot = catalogue.state;
      if (target?.kind === 'exact' && catalogue.reader?.getSnapshot() === snapshot) {
        const current = snapshot.current(target.ref.recipeId);
        matchingBundledExact =
          !!current &&
          canonicalContentJson(current.contentRef, 1024) === canonicalContentJson(target.ref, 1024);
      }
    } catch {
      /* An exact reference never grants a packaged fallback after its owner retires. */
    }
  }
  if (
    (params.contentRef !== undefined && !matchingBundledExact) ||
    (catalogue && (catalogue.state.kind !== 'ready' || catalogue.state.mode !== 'bundled'))
  )
    return (
      <OrdinaryRecipeReader
        recipeId={params.id}
        contentRef={params.contentRef}
        section={params.section}
        cook={params.cook}
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    );
  return <BundledRecipeDetailsScreen />;
}

function BundledRecipeDetailsScreen() {
  const {
    id,
    section: requestedSection,
    cook: requestedCook,
  } = useLocalSearchParams<{
    id: string;
    section?: string;
    cook?: string;
  }>();
  const recipe = typeof id === 'string' ? getRecipe(id) : undefined;
  const router = useRouter();
  if (!recipe)
    return (
      <Page bottomInset>
        <PageHeader back />
        <AppText role="title">Recipe unavailable</AppText>
        <AppText>
          This recipe reference is not in this collection. You can return to where you were or
          explore another recipe.
        </AppText>
        <ActionButton label="Explore recipes" onPress={() => router.replace('/')} />
      </Page>
    );
  return (
    <RecipeDetails
      key={recipe.recipeId}
      recipe={recipe}
      requestedSection={requestedSection}
      requestedCook={requestedCook}
    />
  );
}

function RecipeDetails({
  recipe,
  requestedSection,
  requestedCook,
}: {
  recipe: CatalogueRecipe;
  requestedSection: string | undefined;
  requestedCook: string | undefined;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  const router = useRouter();
  const workspace = useWorkspace();
  const catalogue = useOptionalOrdinaryCatalogue();
  const snapshot = catalogue?.state,
    reader = catalogue?.reader;
  let openedRef: Readonly<RecipeContentRef> | null = null;
  try {
    if (
      snapshot?.kind === 'ready' &&
      snapshot.mode === 'bundled' &&
      reader?.getSnapshot() === snapshot
    )
      openedRef = snapshot.current(recipe.recipeId)?.contentRef ?? null;
  } catch {
    /* No current exact body, no recent record. */
  }
  useRecordRecentRecipe({
    visitKey: `bundled:${recipe.recipeId}`,
    contentRef: openedRef,
    isCurrent: () => {
      try {
        return (
          snapshot?.kind === 'ready' &&
          reader?.getSnapshot() === snapshot &&
          !!snapshot.current(recipe.recipeId)
        );
      } catch {
        return false;
      }
    },
  });
  const { enlarged } = useNativeLayout();
  const [section, setSection] = useState<'ingredients' | 'instructions' | 'source'>(
    requestedSection === 'source' ? 'source' : 'ingredients',
  );
  const [revealSourceNotes, setRevealSourceNotes] = useState(requestedSection === 'source');
  const [videoActivation, setVideoActivation] = useState(0);
  const [videoLinkFailed, setVideoLinkFailed] = useState(false);
  const [cookingOpen, setCookingOpen] = useState(false);
  const consumedResume = useRef(false);
  const cookingTrigger = useRef<View>(null);
  const readerExit = useRef<'return' | 'video' | null>(null);
  const scroll = useRef<ScrollView>(null);
  const contentTop = useRef(0);
  const readingTop = useRef(0);
  const videoTop = useRef<number | null>(null);
  const revealVideo = useRef(false);
  const revealFrame = useRef<number | null>(null);
  const hasVideo = !!youtubeVideoId(recipe.videoUrl);
  const revealVideoSection = useCallback(() => {
    if (!revealVideo.current) return;
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    revealFrame.current = requestAnimationFrame(() => {
      revealFrame.current = null;
      if (!scroll.current || videoTop.current === null) return;
      scroll.current.scrollTo({
        y: Math.max(0, contentTop.current + readingTop.current + videoTop.current - t.space.sm),
        animated: false,
      });
      revealVideo.current = false;
    });
  }, []);
  useEffect(
    () => () => {
      if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (requestedSection !== 'source') return;
    readerExit.current = null;
    setSection('source');
    setCookingOpen(false);
    setVideoActivation(0);
    revealVideo.current = false;
    videoTop.current = null;
    setRevealSourceNotes(true);
  }, [requestedSection]);
  function openSourceNotes() {
    setRevealSourceNotes(true);
    setVideoActivation(0);
    revealVideo.current = false;
    videoTop.current = null;
    setSection('source');
  }
  const watchRecipe = useCallback(() => {
    if (!hasVideo) return;
    revealVideo.current = true;
    setRevealSourceNotes(false);
    setSection('instructions');
    setVideoActivation((request) => request + 1);
    revealVideoSection();
  }, [hasVideo, revealVideoSection]);
  const finishReaderClose = useCallback(() => {
    const destination = readerExit.current;
    if (!destination) return;
    readerExit.current = null;
    if (destination === 'video') watchRecipe();
    else focusTarget(cookingTrigger.current);
  }, [watchRecipe]);
  useFocusEffect(
    useCallback(
      () => () => {
        readerExit.current = null;
        setCookingOpen(false);
      },
      [],
    ),
  );
  const openCookingReader = useCallback(() => {
    readerExit.current = null;
    revealVideo.current = false;
    if (revealFrame.current !== null) {
      cancelAnimationFrame(revealFrame.current);
      revealFrame.current = null;
    }
    setVideoActivation(0);
    setCookingOpen(true);
  }, []);
  const cookingAvailable =
    workspace.availability.kind === 'ready' && !!workspace.availability.services.cooking;
  useEffect(() => {
    if (requestedCook !== 'resume') {
      consumedResume.current = false;
      return;
    }
    if (!cookingAvailable || consumedResume.current) return;
    consumedResume.current = true;
    router.setParams({ cook: '', section: '' });
    setSection('instructions');
    setRevealSourceNotes(false);
    openCookingReader();
  }, [requestedCook, cookingAvailable, router, openCookingReader]);
  function closeCookingReader(destination: 'return' | 'video') {
    readerExit.current = destination;
    setCookingOpen(false);
  }
  async function openVideoSource(url: string) {
    setVideoLinkFailed(false);
    try {
      if (!safeSourceUrl(url)) throw new Error('Unsupported video URL');
      await Linking.openURL(url);
    } catch {
      setVideoLinkFailed(true);
    }
  }
  return (
    <Page bottomInset scroll={false}>
      <View
        style={styles.fill}
        accessibilityElementsHidden={cookingOpen}
        importantForAccessibility={cookingOpen ? 'no-hide-descendants' : 'auto'}
        aria-hidden={cookingOpen}
      >
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.page}
        >
          <RecipeHero recipe={recipe} />
          <View
            style={styles.content}
            onLayout={({ nativeEvent }) => {
              contentTop.current = nativeEvent.layout.y;
              revealVideoSection();
            }}
          >
            <View style={styles.identity}>
              <AppText role="title" accessibilityRole="header" style={styles.title}>
                {recipe.title}
              </AppText>
              <AppText role="support" color="inkSecondary">
                {recipe.cuisine} · {recipe.category}
              </AppText>
            </View>
            <WorkspaceFeedback />
            <View style={[styles.actions, enlarged && styles.stackedActions]}>
              <ActionButton
                label="Add to plan"
                style={[styles.primaryAction, enlarged && styles.fullAction]}
                disabled={workspace.availability.kind !== 'ready'}
                onPress={() =>
                  router.push({ pathname: '/plan-edit', params: { recipeId: recipe.recipeId } })
                }
              />
              {hasVideo && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Watch recipe"
                  accessibilityHint="Opens and loads the recipe video in Instructions. Internet required."
                  onPress={watchRecipe}
                  style={({ pressed }) => [
                    styles.watchAction,
                    enlarged && styles.fullAction,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.playIcon} accessible={false} />
                  <AppText role="control" color="brand" style={styles.actionLabel}>
                    Watch recipe
                  </AppText>
                </Pressable>
              )}
            </View>
            <SegmentControl
              value={section}
              onChange={(next) => {
                if (next === section) return;
                setRevealSourceNotes(false);
                setVideoActivation(0);
                revealVideo.current = false;
                videoTop.current = null;
                setSection(next);
              }}
              options={[
                { value: 'ingredients', label: 'Ingredients' },
                { value: 'instructions', label: 'Instructions' },
                { value: 'source', label: 'Source' },
              ]}
            />
            <RecipePersonalEntry recipeId={recipe.recipeId} />
            <View
              style={styles.reading}
              onLayout={({ nativeEvent }) => {
                readingTop.current = nativeEvent.layout.y;
                revealVideoSection();
              }}
            >
              {section !== 'source' && (
                <AppText role="section" accessibilityRole="header">
                  {section === 'ingredients' ? 'Ingredients' : 'Instructions'}
                </AppText>
              )}
              {section === 'instructions' && recipe.instructions.length > 0 && (
                <ActionButton
                  ref={cookingTrigger}
                  label="Open cooking view"
                  accessibilityHint="Read the original instructions one section at a time."
                  onPress={openCookingReader}
                />
              )}
              {section === 'instructions' && hasVideo && (
                <View
                  onLayout={({ nativeEvent }) => {
                    videoTop.current = nativeEvent.layout.y;
                    revealVideoSection();
                  }}
                >
                  <RecipeVideoCard
                    compact
                    key={`${recipe.recipeId}:${recipe.videoUrl}`}
                    recipe={recipe}
                    activationRequest={videoActivation}
                    suspended={cookingOpen}
                    onOpenSource={(url) => void openVideoSource(url)}
                  />
                  {videoLinkFailed && (
                    <Notice title="Couldn’t open this video source" tone="error">
                      Your recipe is still here. Check your connection and try the source link
                      again.
                    </Notice>
                  )}
                </View>
              )}
              {section === 'ingredients' && (
                <RecipeAnnotations
                  recipe={recipe}
                  section={section}
                  onViewSource={openSourceNotes}
                />
              )}
              {section === 'ingredients' ? (
                <RecipeIngredients recipe={recipe} />
              ) : section === 'instructions' ? (
                <>
                  <RecipeInstructions recipe={recipe} />
                  {recipe.annotations.length > 0 && (
                    <ActionButton
                      label={`All recipe source notes (${recipe.annotations.length})`}
                      variant="quiet"
                      onPress={openSourceNotes}
                    />
                  )}
                </>
              ) : (
                <RecipeSources
                  key={recipe.recipeId}
                  recipe={recipe}
                  revealNotes={revealSourceNotes}
                  onWatch={watchRecipe}
                  notes={<RecipeAnnotations recipe={recipe} section="source" />}
                />
              )}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Ask about this recipe"
              onPress={() =>
                router.push({ pathname: '/assistant', params: { recipeId: recipe.recipeId } })
              }
              style={({ pressed }) => [styles.askAction, pressed && styles.pressed]}
            >
              <AssistantEmblem />
              <AppText role="label" color="assistant" style={styles.actionLabel}>
                Ask about this recipe
              </AppText>
              <AppIcon name="chevronRight" size={18} color={t.color.assistantText} />
            </Pressable>
          </View>
        </ScrollView>
      </View>
      <CookingReader
        recipe={recipe}
        visible={cookingOpen}
        onClose={() => closeCookingReader('return')}
        onDismiss={finishReaderClose}
        {...(hasVideo ? { onWatch: () => closeCookingReader('video') } : {})}
        ingredients={<RecipeIngredients recipe={recipe} />}
        ingredientNotes={<RecipeAnnotations recipe={recipe} section="ingredients" />}
        sourceNotes={<RecipeAnnotations recipe={recipe} section="source" />}
        fullInstructions={<RecipeInstructions recipe={recipe} />}
      />
    </Page>
  );
}

const RECIPE_PHOTO_HEIGHT = 260;

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    fill: { flex: 1 },
    page: {
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
      flexGrow: 1,
    },
    hero: {
      backgroundColor: t.color.surfaceMuted,
      // The content overlaps this lower edge, keeping photo pixels and review notes unobscured.
      paddingBottom: t.space.md,
    },
    heroControls: {
      position: 'absolute',
      top: t.space.sm,
      left: t.space.md,
      right: t.space.md,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
    },
    content: {
      flexGrow: 1,
      backgroundColor: t.color.surface,
      borderTopLeftRadius: t.radius.sheet,
      borderTopRightRadius: t.radius.sheet,
      marginTop: -t.space.md,
      paddingHorizontal: t.space.gutter,
      paddingTop: t.space.lg,
      paddingBottom: t.space.xl,
      gap: t.space.md,
    },
    identity: { gap: t.space.xxs },
    title: { fontSize: 32, lineHeight: 37 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    stackedActions: { flexDirection: 'column' },
    fullAction: { flexBasis: 'auto', width: '100%' },
    primaryAction: { flexGrow: 1, flexBasis: 148 },
    watchAction: {
      flexGrow: 1,
      flexBasis: 148,
      minHeight: t.control.buttonMinHeight,
      padding: t.space.sm,
      borderWidth: 1,
      borderColor: t.color.divider,
      borderRadius: t.radius.control,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: t.space.xs,
    },
    playIcon: {
      width: 0,
      height: 0,
      borderTopWidth: 6,
      borderBottomWidth: 6,
      borderLeftWidth: 9,
      borderTopColor: 'transparent',
      borderBottomColor: 'transparent',
      borderLeftColor: t.color.brand,
    },
    actionLabel: { flexShrink: 1 },
    askAction: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: t.space.xs,
      paddingVertical: t.space.sm,
      marginTop: t.space.sm,
    },
    pressed: { opacity: 0.7 },
    reading: { gap: t.space.md },
    instructions: { gap: t.space.gutter },
    readingText: { fontSize: 17, lineHeight: 26 },
    sourceDisclosure: { alignSelf: 'flex-start', paddingHorizontal: 0 },
    annotationText: { gap: t.space.xxs },
    ingredient: {
      flexDirection: 'row',
      gap: t.space.md,
      paddingVertical: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    stacked: { flexDirection: 'column', gap: t.space.xxs },
    stackedText: { flexBasis: 'auto', flexGrow: 0, textAlign: 'left' },
    ingredientName: { flexGrow: 1, flexBasis: 0, flexShrink: 1 },
    measure: { flexBasis: '42%', flexShrink: 0, textAlign: 'right' },
  });
