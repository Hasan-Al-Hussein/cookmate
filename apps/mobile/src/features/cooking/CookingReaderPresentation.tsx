import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ActionButton } from '../../components/Controls';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { PreviewFrame } from '../../components/PreviewFrame';
import { AppText } from '../../components/Typography';
import { focusTarget } from '../../components/focusTarget';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { KeepAwakeControl } from './KeepAwakeControl';
import { useSheetPresence } from '../../components/useSheetPresence';

export interface CookingReaderSection {
  content: ReactNode;
  role: 'introduction' | 'procedure' | null;
}
export interface CookingReaderProgressPresentation {
  ready: boolean;
  saving: boolean;
  hasActiveSession: boolean;
  feedback: ReactNode;
  onRestart(): void;
  onDismiss(): void;
}
export interface CookingReaderPresentationProps {
  title: string;
  visible: boolean;
  onClose(): void;
  onDismiss(): void;
  onWatch?: () => void;
  ingredients: ReactNode;
  ingredientNotes: ReactNode;
  sourceNotes: ReactNode;
  sourceNoteCount: number;
  fullInstructions: ReactNode;
  sections: readonly CookingReaderSection[];
  position: number;
  onMove(position: number): boolean;
  progress?: CookingReaderProgressPresentation;
  completion?: (visible: boolean, onCancel: () => void) => ReactNode;
  passageDescription?: string;
}
/** Shared visual shell only; persistence and exact recipe authority stay in its caller. */
export function CookingReaderPresentation({
  title,
  visible,
  onClose,
  onDismiss,
  onWatch,
  ingredients,
  ingredientNotes,
  sourceNotes,
  sourceNoteCount,
  fullInstructions,
  sections,
  position,
  onMove,
  progress,
  completion,
  passageDescription = 'Original source passages, in order.',
}: CookingReaderPresentationProps) {
  const styles = useThemedStyles(createStyles);
  const [full, setFull] = useState(false),
    [showIngredients, setShowIngredients] = useState(false),
    [showSourceNotes, setShowSourceNotes] = useState(false),
    [showReadingOptions, setShowReadingOptions] = useState(false),
    [finishing, setFinishing] = useState(false);
  const presence = useSheetPresence({
    visible,
    onDismiss,
    onShow: () => {
      body.current?.scrollTo({ y: 0, animated: false });
      focusTarget(heading.current);
    },
  });
  const ingredientsPresence = useSheetPresence({
    visible: visible && showIngredients,
    onShow: () => {
      focusTarget(ingredientHeading.current);
    },
  });
  useEffect(() => {
    if (!ingredientsPresence.present) ingredientsPresence.onDismiss();
  }, [ingredientsPresence.present, ingredientsPresence.onDismiss]);
  const heading = useRef<View>(null);
  const sectionHeading = useRef<View>(null);
  const ingredientHeading = useRef<View>(null);
  const ingredientTrigger = useRef<View>(null);
  const earlyCompletionTrigger = useRef<View>(null);
  const finishTrigger = useRef<View>(null);
  const completionOrigin = useRef<'early' | 'finish'>('finish');
  const pendingCompletionFocus = useRef<'early' | 'finish' | null>(null);
  const body = useRef<ScrollView>(null);
  const focusSection = useRef(false);
  const restoreIngredientFocus = useRef(false);
  const { enlarged } = useNativeLayout();
  const passages = sections[position];
  const proceduralSections = sections.flatMap(({ role }, index) =>
    role === 'procedure' ? [index] : [],
  );
  const currentRole = sections[position]?.role;
  const firstProcedure = proceduralSections[0];
  const canStartCooking =
    currentRole === 'introduction' && firstProcedure !== undefined && firstProcedure > position;
  const sectionLabel =
    currentRole === 'introduction'
      ? 'About this recipe'
      : currentRole === 'procedure'
        ? `Cooking passage ${proceduralSections.indexOf(position) + 1} of ${proceduralSections.length}`
        : `Section ${position + 1} of ${sections.length}`;
  const finalSection = sections.length > 0 && position === sections.length - 1;

  useEffect(() => {
    if (presence.present) return;
    focusSection.current = false;
    restoreIngredientFocus.current = false;
    pendingCompletionFocus.current = null;
    setFull(false);
    setShowIngredients(false);
    setShowSourceNotes(false);
    setShowReadingOptions(false);
    setFinishing(false);
  }, [presence.present]);

  const restoreCompletionFocus = useCallback(() => {
    if (!visible || finishing || !pendingCompletionFocus.current) return;
    const target =
      pendingCompletionFocus.current === 'early'
        ? earlyCompletionTrigger.current
        : finishTrigger.current;
    if (focusTarget(target)) pendingCompletionFocus.current = null;
  }, [visible, finishing]);
  useEffect(() => {
    if (!visible || finishing || !pendingCompletionFocus.current) return;
    const frame = requestAnimationFrame(restoreCompletionFocus);
    return () => cancelAnimationFrame(frame);
  }, [visible, finishing, restoreCompletionFocus]);

  function openCompletion(origin: 'early' | 'finish') {
    completionOrigin.current = origin;
    pendingCompletionFocus.current = null;
    setFinishing(true);
  }

  function closeCompletion() {
    pendingCompletionFocus.current = completionOrigin.current;
    setFinishing(false);
  }

  function moveTo(next: number) {
    if (next < 0 || next >= sections.length) return;
    if (!onMove(next)) return;
    focusSection.current = true;
    setShowSourceNotes(false);
    setShowReadingOptions(false);
  }

  function closeIngredients() {
    restoreIngredientFocus.current = true;
    setShowIngredients(false);
  }

  return (
    <Modal
      accessibilityLabel={`Cooking view: ${title}`}
      visible={presence.present}
      animationType="none"
      presentationStyle="fullScreen"
      onDismiss={presence.onDismiss}
      onRequestClose={() => {
        if (!visible) return;
        if (showIngredients) closeIngredients();
        else if (finishing) closeCompletion();
        else if (full) {
          focusSection.current = true;
          setFull(false);
        } else onClose();
      }}
      onShow={presence.onShow}
    >
      <View style={styles.root}>
        <PreviewFrame>
          <Animated.View
            style={[styles.root, presence.style]}
            pointerEvents={visible ? 'auto' : 'none'}
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            {...(Platform.OS === 'web' ? { inert: !visible, 'aria-hidden': !visible } : {})}
          >
            <SafeAreaView style={styles.root} accessibilityViewIsModal>
              <View
                style={[styles.frame, ingredientsPresence.present && styles.hidden]}
                onLayout={() => {
                  if (!visible || ingredientsPresence.present || !restoreIngredientFocus.current)
                    return;
                  restoreIngredientFocus.current = false;
                  focusTarget(ingredientTrigger.current);
                }}
              >
                <View style={styles.header}>
                  <View ref={heading} accessible accessibilityRole="header" style={styles.title}>
                    <AppText role="section">{title}</AppText>
                  </View>
                  <ActionButton
                    label="Close"
                    accessibilityLabel="Close cooking view"
                    variant="quiet"
                    onPress={onClose}
                  />
                </View>
                <View style={[styles.tools, finishing && styles.hidden]}>
                  <KeepAwakeControl visible={visible} />
                  <ActionButton
                    ref={ingredientTrigger}
                    label="Ingredients"
                    accessibilityLabel="Open ingredients sheet"
                    variant="secondary"
                    onPress={() => setShowIngredients(true)}
                  />
                  <ActionButton
                    label={full ? 'Return to section' : 'Full instructions'}
                    variant="quiet"
                    onPress={() => {
                      focusSection.current = true;
                      setFull((current) => !current);
                    }}
                  />
                </View>
                <ScrollView
                  ref={body}
                  style={[styles.scroller, finishing && styles.hidden]}
                  contentContainerStyle={styles.content}
                  keyboardShouldPersistTaps="handled"
                >
                  <View
                    key={full ? 'full' : position}
                    ref={sectionHeading}
                    accessible
                    accessibilityRole="header"
                    onLayout={() => {
                      if (!visible || !focusSection.current) return;
                      focusSection.current = false;
                      body.current?.scrollTo({ y: 0, animated: false });
                      focusTarget(sectionHeading.current);
                    }}
                  >
                    <AppText role="label" color="brand">
                      {full ? 'Full instructions' : sectionLabel}
                    </AppText>
                  </View>
                  <AppText role="support" color="inkSecondary">
                    {passageDescription}
                  </AppText>
                  {progress?.feedback && <View style={styles.progress}>{progress.feedback}</View>}
                  {full ? (
                    fullInstructions
                  ) : passages ? (
                    passages.content
                  ) : (
                    <AppText>No instructions were supplied for this recipe.</AppText>
                  )}
                  {sourceNoteCount > 0 && (
                    <View style={styles.progress}>
                      <ActionButton
                        label={`${showSourceNotes ? 'Hide' : 'All'} recipe source notes (${sourceNoteCount})`}
                        variant="quiet"
                        accessibilityState={{ expanded: showSourceNotes }}
                        onPress={() => setShowSourceNotes((current) => !current)}
                      />
                      <AnimatedDisclosure expanded={showSourceNotes}>
                        {sourceNotes}
                      </AnimatedDisclosure>
                    </View>
                  )}
                  {onWatch && (
                    <ActionButton
                      label="Watch recipe"
                      accessibilityHint="Closes cooking view and opens the recipe video in Instructions. Internet required."
                      variant="quiet"
                      style={styles.videoLink}
                      onPress={onWatch}
                    />
                  )}
                  {progress && (
                    <View style={styles.progress}>
                      <ActionButton
                        label="Reading options"
                        variant="quiet"
                        accessibilityState={{ expanded: showReadingOptions }}
                        onPress={() => setShowReadingOptions((current) => !current)}
                      />
                      <AnimatedDisclosure expanded={showReadingOptions} style={styles.progress}>
                        <ActionButton
                          ref={earlyCompletionTrigger}
                          label="I cooked this"
                          accessibilityLabel="I cooked this"
                          variant="secondary"
                          disabled={!progress.ready || progress.saving}
                          onLayout={restoreCompletionFocus}
                          onPress={() => openCompletion('early')}
                        />
                        {progress.hasActiveSession && (
                          <View style={styles.progress}>
                            <AppText role="support">
                              Your place is saved. Restart from the beginning or remove it from
                              Continue cooking. Neither marks it cooked.
                            </AppText>
                            <View style={styles.tools}>
                              <ActionButton
                                label="Restart"
                                accessibilityLabel="Restart cooking from the beginning"
                                variant="quiet"
                                disabled={!progress.ready || progress.saving}
                                onPress={() => void progress.onRestart()}
                              />
                              <ActionButton
                                label="Dismiss progress"
                                accessibilityLabel="Dismiss saved cooking progress"
                                variant="quiet"
                                disabled={!progress.ready || progress.saving}
                                onPress={() => void progress.onDismiss()}
                              />
                            </View>
                          </View>
                        )}
                      </AnimatedDisclosure>
                    </View>
                  )}
                </ScrollView>
                {completion?.(finishing, closeCompletion)}
                {!full &&
                  !finishing &&
                  sections.length > 0 &&
                  (sections.length > 1 || !!progress) && (
                    <View style={[styles.navigation, enlarged && styles.stacked]}>
                      {sections.length > 1 && (
                        <ActionButton
                          label="Previous section"
                          variant="secondary"
                          disabled={position === 0 || (!!progress && !progress.ready)}
                          style={!enlarged && styles.navigationAction}
                          onPress={() => moveTo(position - 1)}
                        />
                      )}
                      <ActionButton
                        ref={finishTrigger}
                        label={
                          finalSection && progress
                            ? 'Finish cooking'
                            : canStartCooking
                              ? 'Start cooking'
                              : 'Next section'
                        }
                        accessibilityLabel={
                          finalSection && progress
                            ? 'Finish cooking'
                            : canStartCooking
                              ? 'Start cooking'
                              : 'Next section'
                        }
                        disabled={
                          finalSection && progress
                            ? !progress.ready || progress.saving
                            : finalSection || (!!progress && !progress.ready)
                        }
                        style={!enlarged && styles.navigationAction}
                        onLayout={restoreCompletionFocus}
                        onPress={() => {
                          if (finalSection && progress) openCompletion('finish');
                          else if (canStartCooking) moveTo(firstProcedure!);
                          else moveTo(position + 1);
                        }}
                      />
                    </View>
                  )}
              </View>
              {ingredientsPresence.present && (
                <View
                  style={styles.sheetLayer}
                  pointerEvents={showIngredients ? 'auto' : 'none'}
                  accessibilityElementsHidden={!showIngredients}
                  importantForAccessibility={showIngredients ? 'auto' : 'no-hide-descendants'}
                  {...(Platform.OS === 'web'
                    ? { inert: !showIngredients, 'aria-hidden': !showIngredients }
                    : {})}
                >
                  <Pressable
                    accessible={false}
                    importantForAccessibility="no"
                    style={StyleSheet.absoluteFill}
                    onPress={closeIngredients}
                  />
                  <Animated.View style={[styles.sheet, ingredientsPresence.style]}>
                    <View style={styles.header}>
                      <View
                        ref={ingredientHeading}
                        accessible
                        accessibilityRole="header"
                        style={styles.title}
                        onLayout={() => {
                          ingredientsPresence.onShow();
                        }}
                      >
                        <AppText role="section">Ingredients</AppText>
                      </View>
                      <ActionButton
                        label="Done"
                        accessibilityLabel="Close ingredients sheet"
                        variant="quiet"
                        onPress={closeIngredients}
                      />
                    </View>
                    <ScrollView style={styles.scroller} contentContainerStyle={styles.content}>
                      <AppText role="bodyStrong">{title}</AppText>
                      <AppText role="support" color="inkSecondary">
                        Original amounts. Viewing these does not change your shopping list.
                      </AppText>
                      {ingredientNotes}
                      {ingredients}
                    </ScrollView>
                  </Animated.View>
                </View>
              )}
            </SafeAreaView>
          </Animated.View>
        </PreviewFrame>
      </View>
    </Modal>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.canvas },
    frame: { flex: 1, width: '100%', maxWidth: t.layout.readingMaxWidth, alignSelf: 'center' },
    hidden: { display: 'none' },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: t.space.xs,
      paddingHorizontal: t.space.gutter,
      paddingTop: t.space.sm,
      paddingBottom: t.space.xs,
    },
    title: { flex: 1, paddingVertical: t.space.xs },
    tools: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: t.space.xs,
      paddingHorizontal: t.space.gutter,
    },
    scroller: { flex: 1, minHeight: 0 },
    content: { padding: t.space.gutter, paddingBottom: t.space.xl, gap: t.space.md },
    progress: { gap: t.space.sm },
    videoLink: { alignSelf: 'flex-start', paddingHorizontal: 0 },
    navigation: {
      flexDirection: 'row',
      gap: t.space.xs,
      padding: t.space.md,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      backgroundColor: t.color.surface,
    },
    stacked: { flexDirection: 'column' },
    navigationAction: { flexGrow: 1, flexBasis: 0 },
    sheetLayer: {
      ...StyleSheet.absoluteFill,
      justifyContent: 'flex-end',
      backgroundColor: `${t.color.ink}66`,
    },
    sheet: {
      height: '88%',
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
      borderTopLeftRadius: t.radius.sheet,
      borderTopRightRadius: t.radius.sheet,
      backgroundColor: t.color.surface,
      overflow: 'hidden',
    },
  });
