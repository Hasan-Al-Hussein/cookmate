import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Linking, ScrollView, StyleSheet, View } from 'react-native';
import {
  catalogue as bundledCatalogue,
  getReviewedBundledInstructionRoles,
  type Immutable,
} from '@cookmate/catalogue';
import {
  canonicalContentJson,
  type ReadingLookup,
  type ReadingRecipe,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { ActionButton, Notice, SegmentControl } from '../../components/Controls';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { IconButton } from '../../components/Icon';
import { Page } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import type { OrdinaryCatalogueController } from './ordinaryCatalogueState';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import {
  InstructionPassageView,
  UnplacedInstructionNotes,
} from '../recipes/InstructionPassageView';
import { RecipeSources } from '../recipes/RecipeSources';
import { RecipeVideoCard } from '../recipes/video/RecipeVideoCard';
import { safeSourceUrl, youtubeVideoId } from '../recipes/video/videoModel';
import { ContentRecipePhoto } from './ContentRecipePhoto';
import type { ContentPhotoResource } from './contentPhotoResourceTypes';
import { instructionSections } from '../cooking/instructionSections';

export interface ContentCookingReadingParts {
  recipe: Immutable<ReadingRecipe>;
  ingredients: ReactNode;
  ingredientNotes: ReactNode;
  sourceNotes: ReactNode;
  fullInstructions: ReactNode;
  renderSection(passages: readonly Immutable<ReadingRecipe>['instructions'][number][]): ReactNode;
  sectionRoles: readonly ('introduction' | 'procedure' | null)[];
  sourceNoteCount: number;
  onWatch?: () => void;
}

export interface ContentRecipeReaderViewProps {
  lookup: ReadingLookup;
  scopeKey: string;
  initialSection?: 'ingredients' | 'instructions' | 'source';
  readPhoto: OrdinaryCatalogueController['readPhoto'];
  onBack(): void;
  onCleanupFailure(resource: ContentPhotoResource): void;
  onPlan?(ref: RecipeContentRef): void;
  saveControl?: ReactNode;
  workspaceFeedback?: ReactNode;
  personalControl?: ReactNode;
  cookingControl?: ReactNode;
  renderCooking?(parts: ContentCookingReadingParts): ReactNode;
}

/** Presentation only: lookup and photo authority belong to the active content host. */
export function ContentRecipeReaderView(props: ContentRecipeReaderViewProps) {
  if (props.lookup.kind !== 'readable')
    return (
      <Page bottomInset>
        <IconButton name="back" label="Back" onPress={props.onBack} />
        <AppText role="title" accessibilityRole="header">
          {props.lookup.kind === 'withdrawn' ? 'Recipe withdrawn' : 'Recipe unavailable'}
        </AppText>
        <AppText>
          {props.lookup.kind === 'withdrawn'
            ? props.lookup.reason
            : 'This exact recipe version is not available. Return to your saved plan or recipe list.'}
        </AppText>
        {props.personalControl}
      </Page>
    );
  return (
    <Reader
      key={canonicalContentJson([props.scopeKey, props.lookup.recipe.contentRef])}
      {...props}
      lookup={props.lookup}
    />
  );
}

function Notes({
  notes,
  title = 'Recipe source notes',
}: {
  notes: Immutable<ReadingRecipe>['annotations'];
  title?: string;
}) {
  const [evidence, setEvidence] = useState(false);
  if (!notes.length) return null;
  return (
    <Notice title={title} tone="caution">
      {notes.map((note) => (
        <View key={note.annotationId}>
          <AppText role="support">{note.note}</AppText>
          <AnimatedDisclosure expanded={evidence}>
            <AppText role="support" color="inkSecondary">
              {note.evidence.map((at) => `${at.sheet} ${at.column ?? 'row '}${at.row}`).join(' · ')}
            </AppText>
          </AnimatedDisclosure>
        </View>
      ))}
      {notes.some((note) => note.evidence.length) && (
        <ActionButton
          label={evidence ? 'Hide worksheet references' : 'Show worksheet references'}
          variant="quiet"
          accessibilityState={{ expanded: evidence }}
          onPress={() => setEvidence(!evidence)}
        />
      )}
    </Notice>
  );
}

function Reader({
  lookup,
  scopeKey,
  readPhoto,
  onBack,
  onPlan,
  saveControl,
  workspaceFeedback,
  personalControl,
  cookingControl,
  renderCooking,
  onCleanupFailure,
  initialSection = 'ingredients',
}: Omit<ContentRecipeReaderViewProps, 'lookup'> & {
  lookup: Extract<ReadingLookup, { kind: 'readable' }>;
}) {
  const { recipe } = lookup;
  const [language, setLanguage] = useState<string | null>(null);
  const translations = recipe.translations ?? [];
  const translation = translations.find((item) => item.targetLanguage === language) ?? null;
  const translated = translation?.content;
  const planAction = useRef({ state: lookup.state, onPlan });
  planAction.current = { state: lookup.state, onPlan };
  const t = useTheme(),
    styles = useThemedStyles(createStyles);
  const translationDirection = translation
    ? recipeLanguageDirection(translation.targetLanguage)
    : undefined;
  const translatedText =
    translationDirection === 'rtl'
      ? styles.rtlText
      : translationDirection === 'ltr'
        ? styles.ltrText
        : undefined;
  const { width, enlarged } = useNativeLayout();
  const stacked = enlarged || width < 360;
  const [photoWidth, setPhotoWidth] = useState(Math.min(width, t.layout.readingMaxWidth));
  const [section, setSection] = useState<'ingredients' | 'instructions' | 'source'>(initialSection);
  const [activation, setActivation] = useState(0);
  const [linkFailed, setLinkFailed] = useState(false);
  const scroll = useRef<ScrollView>(null),
    video = useRef<View>(null);
  const contentTop = useRef(0),
    readingTop = useRef(0),
    videoTop = useRef<number | null>(null);
  const reveal = useRef(false),
    frame = useRef<number | null>(null),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);
  const revealVideo = useCallback(() => {
    if (!reveal.current || videoTop.current === null) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!active.current || videoTop.current === null) return;
      scroll.current?.scrollTo({
        y: Math.max(0, contentTop.current + readingTop.current + videoTop.current - t.space.sm),
        animated: false,
      });
      focusTarget(video.current);
      reveal.current = false;
    });
  }, [t.space.sm]);
  function watch() {
    if (!active.current) return;
    reveal.current = true;
    setSection('instructions');
    setActivation((value) => value + 1);
    revealVideo();
  }
  async function openLink(url: string) {
    if (!active.current) return;
    setLinkFailed(false);
    try {
      if (!safeSourceUrl(url)) throw new Error('Unsupported source');
      await Linking.openURL(url);
    } catch {
      if (active.current) setLinkFailed(true);
    }
  }
  const hasVideo = !!youtubeVideoId(recipe.videoUrl);
  // Imported passage helpers receive the actual retained document, never an authored-to-workbook cast.
  const original =
    recipe.contentKind === 'imported'
      ? recipe.retainedSources.find(
          (source) => canonicalContentJson(source.ref) === canonicalContentJson(recipe.contentRef),
        )?.document.recipe
      : undefined;
  const inherited = recipe.retainedSources.filter(
    (source) => source.disposition === 'inherited_unresolved',
  );
  const ingredientNotes = recipe.annotations.filter(
    (note) =>
      note.kind === 'source_gap' ||
      note.kind === 'missing_measure' ||
      note.kind === 'instruction_only_ingredient',
  );
  const ingredients = (
    <>
      {recipe.ingredients.map((entry) => (
        <View key={entry.position} accessible style={[styles.ingredient, stacked && styles.stack]}>
          <AppText
            role="bodyStrong"
            style={[styles.readingText, styles.name, stacked && styles.left, translatedText]}
          >
            {translated?.ingredients.find((row) => row.position === entry.position)?.rawName ??
              entry.rawName}
          </AppText>
          <AppText
            color={entry.rawMeasure?.trim() ? 'ink' : 'inkSecondary'}
            style={[styles.readingText, styles.measure, stacked && styles.left]}
          >
            {entry.rawMeasure?.trim() ? entry.rawMeasure : 'Amount not supplied'}
          </AppText>
        </View>
      ))}
    </>
  );
  const renderSection: ContentCookingReadingParts['renderSection'] = (passages) => (
    <>
      {passages.map((passage) => {
        const retained = original?.instructions.find((item) => item.sequence === passage.sequence);
        const translatedPassage = translated?.instructions.find(
          (row) => row.sequence === passage.sequence,
        );
        return !translation && original && retained ? (
          <InstructionPassageView key={passage.sequence} recipe={original} passage={retained} />
        ) : (
          <AppText
            key={passage.sequence}
            role={passage.presentation === 'heading' ? 'bodyStrong' : 'body'}
            accessibilityRole={passage.presentation === 'heading' ? 'header' : 'text'}
            style={[
              styles.readingText,
              passage.presentation === 'heading' && styles.passageHeading,
              translatedText,
            ]}
          >
            {translatedPassage?.rawText ?? passage.rawText}
          </AppText>
        );
      })}
    </>
  );
  const fullInstructions = (
    <>
      {original && !translation ? (
        <UnplacedInstructionNotes recipe={original} />
      ) : (
        <Notes notes={recipe.annotations} />
      )}
      {renderSection(recipe.instructions)}
    </>
  );
  const cookingSourceNotes = (
    <>
      <Notes notes={recipe.annotations} />
      {inherited.map((source) => (
        <View key={canonicalContentJson(source.ref)}>
          <AppText role="bodyStrong">Original source: {source.document.recipe.title}</AppText>
          <Notes title="Original source notes" notes={source.document.recipe.annotations} />
        </View>
      ))}
    </>
  );
  const reviewedRoles = original
    ? getReviewedBundledInstructionRoles(original, bundledCatalogue.identity)
    : [];
  const sectionRoles = instructionSections(recipe).map((passages) => {
    const role = reviewedRoles.find((item) => item.sequence === passages[0]?.sequence)?.role;
    return role &&
      passages.every((passage) =>
        reviewedRoles.some((item) => item.sequence === passage.sequence && item.role === role),
      )
      ? role
      : null;
  });
  return (
    <Page scroll={false} bottomInset>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.page}
      >
        <View
          style={styles.hero}
          onLayout={({ nativeEvent }) => {
            if (nativeEvent.layout.width > 0) setPhotoWidth(nativeEvent.layout.width);
          }}
        >
          <ContentRecipePhoto
            recipe={recipe}
            content={{ readPhoto }}
            scopeKey={scopeKey}
            aspectRatio={photoWidth / 260}
            borderRadius={0}
            onCleanupFailure={onCleanupFailure}
          />
          <View style={styles.back}>
            <IconButton label="Back" name="back" onPress={onBack} />
          </View>
          {saveControl && <View style={styles.save}>{saveControl}</View>}
        </View>
        <View
          style={styles.content}
          onLayout={({ nativeEvent }) => {
            contentTop.current = nativeEvent.layout.y;
            revealVideo();
          }}
        >
          <View style={styles.identity}>
            <AppText role="title" accessibilityRole="header" style={[styles.title, translatedText]}>
              {translated?.title ?? recipe.title}
            </AppText>
            <AppText role="support" color="inkSecondary" style={translatedText}>
              {translated?.cuisine ?? recipe.cuisine} · {translated?.category ?? recipe.category}
            </AppText>
          </View>
          {translations.length > 0 && (
            <View style={styles.reading}>
              <AppText role="bodyStrong">Recipe language</AppText>
              <View style={styles.actions}>
                <ActionButton
                  label={translation ? 'View original' : 'Original text'}
                  variant="secondary"
                  accessibilityState={{ selected: !translation }}
                  onPress={() => {
                    if (active.current) setLanguage(null);
                  }}
                />
                {translations.map((item) => (
                  <ActionButton
                    key={item.targetLanguage}
                    label={recipeLanguageName(item.targetLanguage)}
                    variant="secondary"
                    accessibilityState={{ selected: translation === item }}
                    onPress={() => {
                      if (active.current) setLanguage(item.targetLanguage);
                    }}
                  />
                ))}
              </View>
              {translation && (
                <Notice title="Reviewed translation">
                  <AppText role="support">
                    This translation carries its publisher’s recorded review. Original quantities,
                    source notes, photographs and recipe links are unchanged.
                  </AppText>
                  {translation.machineAssisted && (
                    <AppText role="support">
                      Machine-assisted translation. Review does not establish independent language
                      certification.
                    </AppText>
                  )}
                </Notice>
              )}
            </View>
          )}
          {workspaceFeedback}
          {lookup.state !== 'current' && (
            <Notice
              title={lookup.state === 'archived' ? 'Archived recipe' : 'Saved recipe version'}
            >
              {lookup.state === 'archived'
                ? 'This recipe is archived. You can still read this exact saved version.'
                : 'You are reading the exact version saved with this recipe reference.'}
            </Notice>
          )}
          {(translated ? translated.description : recipe.description) && (
            <AppText style={[styles.readingText, translatedText]}>
              {translated ? translated.description : recipe.description}
            </AppText>
          )}
          {((onPlan && lookup.state === 'current') || hasVideo) && (
            <View style={[styles.actions, stacked && styles.stack]}>
              {onPlan && lookup.state === 'current' && (
                <ActionButton
                  label="Add to plan"
                  style={[styles.action, stacked && styles.fullAction]}
                  onPress={() => {
                    if (active.current && planAction.current.state === 'current')
                      planAction.current.onPlan?.(recipe.contentRef);
                  }}
                />
              )}
              {hasVideo && (
                <ActionButton
                  label="Watch recipe"
                  variant="secondary"
                  style={[styles.action, stacked && styles.fullAction]}
                  accessibilityHint="Opens and loads the video in Instructions. Internet required."
                  onPress={watch}
                />
              )}
            </View>
          )}
          <SegmentControl
            value={section}
            options={[
              { value: 'ingredients', label: 'Ingredients' },
              { value: 'instructions', label: 'Instructions' },
              { value: 'source', label: 'Source' },
            ]}
            onChange={(next) => {
              if (next === section) return;
              reveal.current = false;
              videoTop.current = null;
              setActivation(0);
              setSection(next);
            }}
          />
          {personalControl}
          <View
            style={styles.reading}
            onLayout={({ nativeEvent }) => {
              readingTop.current = nativeEvent.layout.y;
              revealVideo();
            }}
          >
            {section !== 'source' && (
              <AppText role="section" accessibilityRole="header">
                {section === 'ingredients' ? 'Ingredients' : 'Instructions'}
              </AppText>
            )}
            {section !== 'source' &&
              inherited.some((source) => source.document.recipe.annotations.length) && (
                <Notice title="Original source notes remain unresolved" tone="caution">
                  <AppText role="support">
                    This version retains notes from its original source. Review them alongside the
                    recipe.
                  </AppText>
                  <ActionButton
                    label="Read original source notes"
                    variant="quiet"
                    onPress={() => {
                      setActivation(0);
                      setSection('source');
                    }}
                  />
                </Notice>
              )}
            {section === 'ingredients' ? (
              <>
                <Notes notes={ingredientNotes} />
                {ingredients}
              </>
            ) : section === 'instructions' ? (
              <>
                {cookingControl}
                {recipe.videoUrl && (
                  <View
                    ref={video}
                    onLayout={({ nativeEvent }) => {
                      videoTop.current = nativeEvent.layout.y;
                      revealVideo();
                    }}
                  >
                    <RecipeVideoCard
                      compact
                      recipe={recipe}
                      useBundledPhoto={false}
                      activationRequest={activation}
                      onOpenSource={(url) => void openLink(url)}
                    />
                  </View>
                )}
                {fullInstructions}
              </>
            ) : original ? (
              <RecipeSources
                recipe={original}
                notes={<Notes notes={recipe.annotations} />}
                {...(hasVideo ? { onWatch: watch } : {})}
              />
            ) : (
              <>
                <AppText role="section" accessibilityRole="header">
                  Recipe &amp; credits
                </AppText>
                {recipe.provenance.kind === 'authored' && (
                  <>
                    <AppText role="support">Authored by {recipe.provenance.authorId}</AppText>
                    <AppText role="support">{recipe.provenance.changeSummary}</AppText>
                    {recipe.provenance.credits.map((credit, index) => (
                      <View key={index}>
                        <AppText>{credit.label}</AppText>
                        {credit.url && (
                          <SourceLink
                            label={`Open credit: ${credit.label}`}
                            url={credit.url}
                            open={openLink}
                          />
                        )}
                      </View>
                    ))}
                  </>
                )}
                {recipe.recipePage && (
                  <SourceLink
                    label="Open recipe collection"
                    url={recipe.recipePage}
                    open={openLink}
                  />
                )}
                {recipe.originalSourceUrl && (
                  <SourceLink
                    label="Open original publisher"
                    url={recipe.originalSourceUrl}
                    open={openLink}
                  />
                )}
                {hasVideo && <ActionButton label="Watch recipe" variant="quiet" onPress={watch} />}
                {recipe.videoUrl && !hasVideo && (
                  <SourceLink label="Open video source ↗" url={recipe.videoUrl} open={openLink} />
                )}
                {recipe.rawTags && (
                  <>
                    <AppText role="bodyStrong">Supplied tags</AppText>
                    <AppText>{recipe.rawTags}</AppText>
                    <AppText role="support" color="inkSecondary">
                      Source labels only. These are not verified dietary or allergy claims.
                    </AppText>
                  </>
                )}
                <Notes notes={recipe.annotations} />
                {inherited.map((source) => (
                  <View key={canonicalContentJson(source.ref)} style={styles.reading}>
                    <AppText role="section" accessibilityRole="header">
                      Original source: {source.document.recipe.title}
                    </AppText>
                    <AppText role="support" color="inkSecondary">
                      Retained source evidence; these notes have not been resolved by the authored
                      changes.
                    </AppText>
                    <Notes
                      title="Original source notes"
                      notes={source.document.recipe.annotations}
                    />
                    {source.document.recipe.recipePage && (
                      <SourceLink
                        label="Open original recipe collection"
                        url={source.document.recipe.recipePage}
                        open={openLink}
                      />
                    )}
                    {source.document.recipe.originalSourceUrl && (
                      <SourceLink
                        label="Open original source publisher"
                        url={source.document.recipe.originalSourceUrl}
                        open={openLink}
                      />
                    )}
                  </View>
                ))}
              </>
            )}
            {linkFailed && (
              <Notice title="Couldn’t open this source" tone="error">
                Your recipe is still here. Check your connection and try the source link again.
              </Notice>
            )}
          </View>
        </View>
      </ScrollView>
      {renderCooking?.({
        recipe,
        ingredients,
        ingredientNotes: <Notes notes={ingredientNotes} />,
        sourceNotes: cookingSourceNotes,
        fullInstructions,
        renderSection,
        sectionRoles,
        sourceNoteCount:
          recipe.annotations.length +
          inherited.reduce((count, source) => count + source.document.recipe.annotations.length, 0),
        ...(hasVideo ? { onWatch: watch } : {}),
      })}
    </Page>
  );
}

function SourceLink({
  label,
  url,
  open,
}: {
  label: string;
  url: string;
  open(url: string): Promise<void>;
}) {
  return safeSourceUrl(url) ? (
    <ActionButton
      label={label}
      variant="quiet"
      accessibilityHint="Opens an external site."
      onPress={() => void open(url)}
    />
  ) : (
    <AppText role="support" color="inkSecondary">
      {label}: link unavailable.
    </AppText>
  );
}

function recipeLanguageDirection(language: string): 'rtl' | 'ltr' | undefined {
  const script = language.split('-').find((part) => /^[A-Z][a-z]{3}$/.test(part));
  if (script) {
    if (script === 'Arab' || script === 'Hebr') return 'rtl';
    if (script === 'Latn' || script === 'Cyrl') return 'ltr';
    // Leave other explicit scripts to the platform rather than guessing from the language.
    return undefined;
  }
  return /^(ar|fa|he|ur|ps|sd|ug|yi)(-|$)/.test(language) ? 'rtl' : undefined;
}

function recipeLanguageName(language: string) {
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    page: { width: '100%', maxWidth: t.layout.readingMaxWidth, alignSelf: 'center', flexGrow: 1 },
    hero: { backgroundColor: t.color.surfaceMuted, paddingBottom: t.space.md },
    back: { position: 'absolute', top: t.space.sm, left: t.space.md },
    content: {
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
    save: { position: 'absolute', top: t.space.md, right: t.space.gutter },
    title: { fontSize: 32, lineHeight: 37 },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    action: { flexGrow: 1, flexBasis: 148 },
    fullAction: { flexBasis: 'auto', width: '100%' },
    reading: { gap: t.space.md },
    readingText: { fontSize: 17, lineHeight: 26 },
    rtlText: { writingDirection: 'rtl', textAlign: 'right' },
    ltrText: { writingDirection: 'ltr', textAlign: 'left' },
    passageHeading: { fontSize: 18, lineHeight: 27 },
    ingredient: {
      flexDirection: 'row',
      gap: t.space.md,
      paddingVertical: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    name: { flexGrow: 1, flexBasis: 0, flexShrink: 1 },
    measure: { flexBasis: '42%', flexShrink: 0, textAlign: 'right' },
    stack: { flexDirection: 'column', gap: t.space.xxs },
    left: { flexBasis: 'auto', textAlign: 'left' },
  });
