import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { FlatList, KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getRecipe } from '@cookmate/catalogue';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { WorkspaceFeedback } from '../workspace/WorkspaceFeedback';
import { useAssistant } from './useAssistant';
import { errorCopy } from './assistantCopy';
import { AssistantMessage } from './AssistantMessage';
import { WorkingContext } from './WorkingContext';
import { canOfferTurnRetry, newRequestGuidance } from './turnRecovery';
import {
  AssistantCapabilityNotice,
  AssistantComposer,
  AssistantContextChip,
  AssistantHeader,
  AssistantLocalActions,
  AssistantWelcome,
} from './AssistantPresentation';
import { AssistantSearchContext } from './AssistantSearchContext';
import { assistantMessageLimit, useAssistantEntry } from './AssistantEntryState';

// Adopted current-message limit counts Unicode code points, not UTF-16 input units.
const messageLimit = assistantMessageLimit;
const latestThreshold = 60;
export default function AssistantScreen() {
  const styles = useThemedStyles(createStyles);

  const { recipeId } = useLocalSearchParams<{ recipeId?: string }>();
  const recipe = typeof recipeId === 'string' ? getRecipe(recipeId) : undefined;
  const router = useRouter();
  const { assistant, state } = useAssistant();
  const { search } = useAssistantEntry();
  const searchEntryId = search?.id;
  const selectedRecipeId = recipe?.recipeId;
  const previousRecipeId = useRef(selectedRecipeId);
  useLayoutEffect(() => {
    if (previousRecipeId.current === selectedRecipeId) return;
    previousRecipeId.current = selectedRecipeId;
    // Fence pending work before the changed recipe context becomes interactive.
    assistant?.invalidate();
    void assistant?.recovery.check();
  }, [assistant, selectedRecipeId]);
  const list = useRef<FlatList>(null);
  const [nearEnd, setNearEnd] = useState(true);
  const [newMessages, setNewMessages] = useState(false);
  const scrollMetrics = useRef({ offset: 0, viewport: 0, content: 0 });
  const followLatest = useRef(true);
  const revealingContext = useRef(false);
  const pendingScroll = useRef<'context' | 'latest' | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const revealedEntry = useRef<number | undefined>(undefined);
  const pendingEntry = useRef<number | undefined>(undefined);
  const conversation = state?.conversation;
  const conversationKey = conversation
    ? `${conversation.header.conversationId}:${conversation.header.generation}`
    : undefined;
  const lastMessage = state?.conversation?.messages.at(-1)?.messageId;
  const previousConversation = useRef<{
    key: string;
    lastMessage: string | undefined;
  } | null>(null);
  const updateNearEnd = useCallback(() => {
    const { offset, viewport, content } = scrollMetrics.current;
    const atEnd = viewport > 0 && offset + viewport >= content - latestThreshold;
    setNearEnd(atEnd);
    if (atEnd) setNewMessages(false);
    return atEnd;
  }, []);
  const cancelScroll = useCallback(() => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    pendingScroll.current = null;
  }, []);
  const requestScroll = useCallback(
    (target: 'context' | 'latest') => {
      // A newly staged question must be seen before normal transcript following resumes.
      if (target === 'latest' && pendingScroll.current === 'context') return;
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      pendingScroll.current = target;
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = null;
        if (!list.current || scrollMetrics.current.viewport === 0) return;
        const destination = pendingScroll.current;
        if (!destination) return;
        pendingScroll.current = null;
        if (destination === 'context') {
          followLatest.current = false;
          scrollMetrics.current.offset = 0;
          list.current.scrollToOffset({ offset: 0, animated: false });
          revealedEntry.current = pendingEntry.current;
          pendingEntry.current = undefined;
        } else {
          followLatest.current = true;
          scrollMetrics.current.offset = Math.max(
            0,
            scrollMetrics.current.content - scrollMetrics.current.viewport,
          );
          list.current.scrollToEnd({ animated: false });
        }
        updateNearEnd();
      });
    },
    [updateNearEnd],
  );
  useEffect(() => cancelScroll, [cancelScroll]);
  useFocusEffect(
    useCallback(() => {
      if (searchEntryId === undefined || revealedEntry.current === searchEntryId) return;
      pendingEntry.current = searchEntryId;
      revealingContext.current = true;
      followLatest.current = false;
      requestScroll('context');
    }, [requestScroll, searchEntryId]),
  );
  useEffect(() => {
    if (searchEntryId !== undefined) return;
    revealingContext.current = false;
  }, [searchEntryId]);
  useEffect(() => {
    if (!conversationKey) return;
    const previous = previousConversation.current;
    previousConversation.current = { key: conversationKey, lastMessage };
    if (previous?.key !== conversationKey) {
      setNewMessages(false);
      if (searchEntryId !== undefined) {
        followLatest.current = false;
      } else {
        followLatest.current = true;
        if (lastMessage) requestScroll('latest');
      }
    } else if (lastMessage && lastMessage !== previous.lastMessage) {
      if (followLatest.current && pendingScroll.current !== 'context') requestScroll('latest');
      else setNewMessages(true);
    }
  }, [conversationKey, lastMessage, requestScroll, searchEntryId]);
  const count = [...(state?.draft ?? '')].length;
  const ready = !!state?.conversation && !state.readError;
  const outcome = state?.outcome;
  const editGuidance =
    outcome?.kind === 'failed' && !outcome.acceptanceRetry
      ? newRequestGuidance(outcome.error)
      : undefined;
  const emptyConversation = state?.conversation?.messages.length === 0;
  const sharingStatus = state?.aiConsent?.status;
  const capability = !state
    ? null
    : !state.connectionReady || state.connectionBusy
      ? {
          title: state.connectionBusy
            ? 'Connecting to your laptop…'
            : 'Checking your AI connection…',
          description: 'Your conversation and local cooking features are still available.',
        }
      : state.connection.status !== 'paired'
        ? {
            title: 'Connect your laptop to ask CookMate.',
            description:
              'Your conversation is kept. Explore recipes and plan meals while disconnected.',
          }
        : sharingStatus && sharingStatus !== 'allowed'
          ? {
              title:
                sharingStatus === 'error'
                  ? 'Your AI sharing choice needs attention.'
                  : sharingStatus === 'loading' || sharingStatus === 'saving'
                    ? 'Checking your AI sharing choice…'
                    : 'AI sharing is off.',
              description:
                'Review data sharing in AI connection before sending. Your draft is kept.',
            }
          : null;
  const onReturn = search
    ? () => router.navigate('/')
    : recipe && router.canGoBack()
      ? () => router.back()
      : undefined;
  const capabilityNotice = capability ? (
    <AssistantCapabilityNotice
      title={capability.title}
      description={capability.description}
      onLearnMore={() => router.push({ pathname: '/settings', params: { section: 'connection' } })}
    />
  ) : null;
  const header = (
    <View style={styles.header}>
      <WorkspaceFeedback />
      <AssistantSearchContext
        draft={state?.draft ?? ''}
        onChangeDraft={(text) => assistant?.setDraft(text)}
        editable={ready && !state?.composerPaused}
      />
      {recipe && (
        <View style={styles.recipeContext}>
          <AssistantContextChip
            label={`Recipe: ${recipe.title}`}
            onRemove={() => router.setParams({ recipeId: '' })}
          />
          <ActionButton
            label="Open recipe"
            variant="quiet"
            onPress={() =>
              router.push({ pathname: '/recipe/[id]', params: { id: recipe.recipeId } })
            }
          />
        </View>
      )}
      {typeof recipeId === 'string' && recipeId && !recipe && (
        <Notice title="This recipe reference is unavailable">
          Choose a recipe from Discover before asking about it.
        </Notice>
      )}
      {!state || (!state.conversation && state.loading) ? (
        <Notice title="Opening your conversation…" />
      ) : null}
      {state?.readError && (
        <Notice title="Couldn’t load the latest conversation" tone="error">
          <AppText>{errorCopy(state.readError)}</AppText>
          <ActionButton label="Reload conversation" onPress={() => void assistant?.reload()} />
        </Notice>
      )}
      {emptyConversation && <AssistantWelcome />}
      {emptyConversation && capabilityNotice}
      {emptyConversation && (
        <AssistantLocalActions
          onExplore={() => router.navigate('/')}
          onPlan={() => router.navigate('/plan')}
          onPreferences={() =>
            router.push({ pathname: '/settings', params: { section: 'preferences' } })
          }
        />
      )}
      {state?.conversation?.hasEarlier && (
        <>
          {state.conversation.hasHistoryGap && (
            <Notice title="Some messages are not loaded yet">
              Your saved messages are kept. Load the missing messages to fill in this conversation.
            </Notice>
          )}
          <ActionButton
            label={
              state.conversation.hasHistoryGap ? 'Load missing messages' : 'Load earlier messages'
            }
            variant="quiet"
            busy={state.loading}
            onPress={() => {
              cancelScroll();
              followLatest.current = false;
              void assistant?.reload(true);
            }}
          />
        </>
      )}
    </View>
  );
  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        <View style={styles.screenHeader}>
          <AssistantHeader onReturn={onReturn} returnLabel={search ? 'Back to search' : 'Back'} />
        </View>
        {!emptyConversation && capabilityNotice && (
          <View style={styles.liveCapability}>{capabilityNotice}</View>
        )}
        <FlatList
          ref={list}
          data={state?.conversation?.messages ?? []}
          keyExtractor={(item) => item.messageId}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          ListHeaderComponent={header}
          onLayout={({ nativeEvent }) => {
            scrollMetrics.current.viewport = nativeEvent.layout.height;
            updateNearEnd();
            if (pendingScroll.current) requestScroll(pendingScroll.current);
            else if (followLatest.current && lastMessage) requestScroll('latest');
          }}
          onContentSizeChange={(_width, height) => {
            scrollMetrics.current.content = height;
            updateNearEnd();
            if (pendingScroll.current) requestScroll(pendingScroll.current);
            else if (followLatest.current && lastMessage) requestScroll('latest');
          }}
          onScrollBeginDrag={() => {
            cancelScroll();
            revealingContext.current = false;
            followLatest.current = false;
          }}
          onScrollEndDrag={() => {
            followLatest.current = updateNearEnd();
          }}
          onScroll={({ nativeEvent }) => {
            const previousMetrics = scrollMetrics.current;
            scrollMetrics.current = {
              offset: nativeEvent.contentOffset.y,
              viewport: nativeEvent.layoutMeasurement.height,
              content: nativeEvent.contentSize.height,
            };
            const atEnd = updateNearEnd();
            if (lastMessage && !pendingScroll.current && !revealingContext.current) {
              const geometryChanged =
                previousMetrics.content !== nativeEvent.contentSize.height ||
                previousMetrics.viewport !== nativeEvent.layoutMeasurement.height;
              const positionChanged =
                Math.abs(previousMetrics.offset - nativeEvent.contentOffset.y) > 1;
              // A layout event can arrive before content-size notification. Growth alone
              // must not turn a reader at the bottom into a reader of earlier messages.
              if (followLatest.current && geometryChanged && !positionChanged)
                requestScroll('latest');
              else followLatest.current = atEnd;
            }
          }}
          scrollEventThrottle={100}
          renderItem={({ item }) => <AssistantMessage message={item} />}
          ListFooterComponent={
            <View style={styles.header}>
              {state?.notice && (
                <Notice title="Context updated">
                  <AppText>{state.notice}</AppText>
                  <ActionButton
                    label="Dismiss context update"
                    variant="quiet"
                    onPress={() => assistant?.dismissNotice()}
                  />
                </Notice>
              )}
              {state?.busy && (
                <Notice title="Working on your request…">
                  <AppText role="support">You can keep reading or write your next draft.</AppText>
                  <ActionButton
                    label="Stop waiting"
                    variant="quiet"
                    onPress={() => void assistant?.cancel(state.activeIntentId)}
                  />
                </Notice>
              )}
              {outcome?.kind === 'failed' && (
                <Notice title="The request needs attention" tone="error">
                  <AppText>{errorCopy(outcome.error)}</AppText>
                  {editGuidance && <AppText role="support">{editGuidance}</AppText>}
                  {outcome.acceptanceRetry && (
                    <ActionButton
                      label="Save the received answer again"
                      disabled={state?.busy}
                      onPress={() => void assistant?.retryAcceptance()}
                    />
                  )}
                  {!outcome.acceptanceRetry &&
                    outcome.userIntentId &&
                    canOfferTurnRetry(outcome.error) && (
                      <ActionButton
                        label="Retry this request"
                        disabled={state?.busy}
                        onPress={() => void assistant?.retryTurn(outcome.userIntentId!)}
                      />
                    )}
                </Notice>
              )}
              {outcome?.kind === 'clarification' && (
                <Notice title="Which recipe did you mean?">
                  Open the recipe from its original suggestion, then choose Ask about this recipe.
                </Notice>
              )}
              {outcome?.kind === 'narrowing' && <WorkingContext narrowing={outcome} />}
            </View>
          }
        />
        {!!lastMessage && !nearEnd && (
          <ActionButton
            label={newMessages ? 'New messages · go to latest' : 'Go to latest'}
            variant="secondary"
            onPress={() => {
              cancelScroll();
              revealingContext.current = false;
              followLatest.current = true;
              requestScroll('latest');
              setNewMessages(false);
            }}
          />
        )}
        <View style={styles.composer}>
          {state?.draftError && (
            <Notice title="Your draft has not been saved" tone="error">
              <AppText role="support">
                {state.draftError.code === 'too_large'
                  ? 'All your text is still here. Shorten it to 4,000 characters to save it for reopening.'
                  : 'Keep this app open and retry saving it.'}
              </AppText>
              {state.draftError.code !== 'too_large' && (
                <ActionButton
                  label="Save draft again"
                  variant="quiet"
                  onPress={() => assistant?.retryDraft()}
                />
              )}
            </Notice>
          )}
          <AssistantComposer
            editable={ready && !state?.composerPaused}
            value={state?.draft ?? ''}
            onChangeText={(text) => assistant?.setDraft(text)}
            sendDisabled={
              !ready ||
              !state?.draft.trim() ||
              count > messageLimit ||
              state?.busy ||
              state?.connectionBusy ||
              !state?.connectionReady ||
              (!!state.aiConsent && state.aiConsent.status !== 'allowed') ||
              state.connection.status !== 'paired' ||
              !!state?.draftError ||
              outcome?.kind === 'narrowing' ||
              (!!recipeId && !recipe)
            }
            onSend={() => void assistant?.send(recipe ? { selectedRecipeId: recipe.recipeId } : {})}
          />
          <AppText role="support" color={count > messageLimit ? 'error' : 'inkSecondary'}>
            {count > messageLimit
              ? `Message is ${count - messageLimit} characters too long. Your text has been kept.`
              : `${count} / ${messageLimit} characters`}
          </AppText>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.canvas },
    content: {
      paddingHorizontal: t.space.gutter,
      paddingBottom: t.space.gutter,
      gap: t.space.gutter,
      width: '100%',
      maxWidth: t.layout.readingMaxWidth,
      alignSelf: 'center',
    },
    header: { gap: t.space.md },
    liveCapability: { paddingHorizontal: t.space.gutter, paddingVertical: t.space.xs },
    screenHeader: {
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
    recipeContext: {
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      padding: t.space.sm,
      gap: t.space.xs,
    },
    composer: {
      padding: t.space.md,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      gap: t.space.xs,
      backgroundColor: t.color.surface,
    },
  });
