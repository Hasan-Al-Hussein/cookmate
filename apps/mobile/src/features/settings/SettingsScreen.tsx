import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { ActionButton } from '../../components/Controls';
import { Page, PageHeader } from '../../components/Page';
import { AppText } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { WorkspaceFeedback } from '../workspace/WorkspaceFeedback';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { assistantDataDisclosure } from '../../assistant-core';
import { useActionFocus } from '../../hooks/useActionFocus';
import { Preferences } from './Preferences';
import { ConnectionSettings } from './ConnectionSettings';
import { useAssistant } from '../assistant/useAssistant';
import { AppearanceSettings } from './AppearanceSettings';
import { PlanningSettings } from './PlanningSettings';
import { RecentlyViewedSettings } from '../recently-viewed/RecentlyViewedSettings';
import { BackupSettings } from '../backup/BackupSettings';
import { ConversationExportSettings } from '../backup/ConversationExportSettings';
import { AssistantPreview } from '../assistant/AssistantPreview';
import { ContentFade } from '../../components/ContentFade';
import { focusTarget } from '../../components/focusTarget';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';

const settingsEntries = [
  {
    section: 'recently-viewed',
    group: 'Help and your data',
    title: 'Recently viewed',
    description: 'Choose whether to keep recent recipe history on this device.',
    icon: 'book',
  },
  {
    section: 'account',
    group: 'Your app',
    title: 'Account & sync',
    description: 'Optional sign-in and account sync status.',
    icon: 'info',
  },
  {
    section: 'backup',
    group: 'Your app',
    title: 'Backup & restore',
    description: 'Export a private file or inspect an existing backup.',
    icon: 'book',
  },
  {
    section: 'appearance',
    group: 'Your app',
    title: 'Appearance & accessibility',
    description: 'Light, dark or system theme and reduced motion.',
    icon: 'moon',
  },
  {
    section: 'planning',
    group: 'Your cooking',
    title: 'Planning defaults',
    description: 'Week start and the starting slot for new meals.',
    icon: 'calendar',
  },
  {
    section: 'preferences',
    group: 'Your cooking',
    title: 'Saved preferences',
    description: 'Cuisines and ingredients you choose to remember.',
    icon: 'heart',
  },
  {
    section: 'cooking-history',
    group: 'Your cooking',
    title: 'Cooking history',
    description: 'Meals you marked cooked and your private cooking notes.',
    icon: 'book',
  },
  {
    section: 'conversation',
    group: 'CookMate Assistant',
    title: 'Conversation',
    description: 'Open, export or review clearing your conversation.',
    icon: 'chat',
  },
  {
    section: 'connection',
    group: 'CookMate Assistant',
    title: 'AI connection',
    description: 'Manage your connection to the laptop.',
    icon: 'settings',
  },
  {
    section: 'help',
    group: 'Help and your data',
    title: 'Help',
    description: 'Using CookMate and an example of the Assistant.',
    icon: 'book',
  },
  {
    section: 'privacy',
    group: 'Help and your data',
    title: 'Data & privacy',
    description: 'Your recipe sources and where your work is kept.',
    icon: 'info',
  },
] as const;

export default function SettingsScreen() {
  const { section: requestedSection } = useLocalSearchParams<{ section?: string }>();
  const normalizedSection = requestedSection === 'about' ? 'privacy' : requestedSection;
  const section =
    normalizedSection === 'assistant-preview' ||
    settingsEntries.some(
      (entry) =>
        entry.section !== 'account' &&
        entry.section !== 'cooking-history' &&
        entry.section === normalizedSection,
    )
      ? normalizedSection
      : undefined;
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const router = useRouter();
  const { actions, availability } = useWorkspace();
  const hasCooking = availability.kind === 'ready' && !!availability.services.cooking;
  const hasRestore = availability.kind === 'ready' && !!availability.services.portableRestore;
  const { state: assistantState } = useAssistant();
  const connectionSummary =
    Platform.OS === 'web'
      ? 'iPhone app only'
      : !assistantState?.connectionReady
        ? 'Connection status unavailable'
        : assistantState.connectionBusy
          ? 'Connecting…'
          : assistantState.connection.status === 'paired'
            ? 'Paired with your laptop'
            : assistantState.connection.status === 'reconnect'
              ? 'Pair again to reconnect'
              : 'Not paired';
  const clearFocus = useActionFocus();
  const [privacyDetails, setPrivacyDetails] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const menuOffset = useRef(0);
  const navigating = useRef(false);
  const lastEntry = useRef<string | null>(null);
  const menuTargets = useRef(new Map<string, View>());
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      scroll.current?.scrollTo({ y: section ? 0 : menuOffset.current, animated: false });
      if (!section && lastEntry.current)
        focusTarget(menuTargets.current.get(lastEntry.current) ?? null);
      navigating.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);
  if (section === 'assistant-preview') {
    return <AssistantPreview onBack={() => router.setParams({ section: 'help' })} />;
  }
  return (
    <Page
      scrollRef={scroll}
      onScroll={({ nativeEvent }) => {
        if (!section && !navigating.current) menuOffset.current = nativeEvent.contentOffset.y;
      }}
    >
      <ContentFade selection={section ?? 'menu'} style={{ gap: t.space.lg }}>
        {section ? (
          <PageHeader
            key={section}
            back
            focusOnMount
            title={settingsEntries.find((entry) => entry.section === section)?.title ?? 'Settings'}
            onBack={() => {
              navigating.current = true;
              router.setParams({ section: '' });
            }}
          />
        ) : (
          <PageHeader title="Settings" />
        )}
        <WorkspaceFeedback />
        {!section ? (
          <View style={styles.section}>
            {['Your app', 'Your cooking', 'CookMate Assistant', 'Help and your data'].map(
              (group) => (
                <View key={group} style={styles.group}>
                  <AppText role="section" accessibilityRole="header">
                    {group}
                  </AppText>
                  <View style={styles.menu}>
                    {settingsEntries
                      .filter(
                        (entry) =>
                          entry.group === group &&
                          (entry.section !== 'cooking-history' || hasCooking),
                      )
                      .map((entry) => (
                        <Pressable
                          key={entry.section}
                          ref={(node) => {
                            if (node) menuTargets.current.set(entry.section, node);
                            else menuTargets.current.delete(entry.section);
                          }}
                          accessibilityRole="button"
                          accessibilityLabel={entry.title}
                          accessibilityHint={
                            entry.section === 'connection' ? connectionSummary : entry.description
                          }
                          onPress={() => {
                            lastEntry.current = entry.section;
                            navigating.current =
                              entry.section !== 'account' && entry.section !== 'cooking-history';
                            entry.section === 'account'
                              ? router.push('/account')
                              : entry.section === 'cooking-history'
                                ? router.push('/cooking-history')
                                : router.setParams({ section: entry.section });
                          }}
                          style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
                        >
                          <View style={styles.icon}>
                            <AppIcon name={entry.icon} color={t.color.brandText} />
                          </View>
                          <View style={styles.rowText}>
                            <AppText role="bodyStrong">{entry.title}</AppText>
                            <AppText role="support" color="inkSecondary">
                              {entry.section === 'connection'
                                ? connectionSummary
                                : entry.section === 'backup' && hasRestore
                                  ? 'Export, inspect or review replacing local cooking data.'
                                  : entry.description}
                            </AppText>
                          </View>
                          <AppIcon name="chevronRight" size={18} color={t.color.inkSecondary} />
                        </Pressable>
                      ))}
                  </View>
                </View>
              ),
            )}
          </View>
        ) : null}
        {section === 'preferences' && <Preferences showTitle={false} />}
        {section === 'appearance' && <AppearanceSettings showTitle={false} />}
        {section === 'planning' && <PlanningSettings showTitle={false} />}
        {section === 'recently-viewed' && <RecentlyViewedSettings showTitle={false} />}
        {section === 'backup' && <BackupSettings showTitle={false} />}
        {section === 'connection' && (
          <View style={styles.section}>
            <AppText role="section" accessibilityRole="header">
              Private laptop development tool
            </AppText>
            <ConnectionSettings showTitle={false} />
          </View>
        )}
        {section === 'conversation' && (
          <View style={styles.section}>
            <ActionButton
              label="Open conversation"
              variant="secondary"
              onPress={() => router.navigate('/assistant')}
            />
            <ConversationExportSettings />
            <AppText role="section" accessibilityRole="header">
              Clear saved conversation
            </AppText>
            <View style={styles.group}>
              <AppText role="bodyStrong" accessibilityRole="header">
                What is removed
              </AppText>
              <AppText>
                This saved conversation, its saved composer draft, recipe references and temporary
                context. Uncommitted proposals become inactive.
              </AppText>
            </View>
            <View style={styles.group}>
              <AppText role="bodyStrong" accessibilityRole="header">
                What stays
              </AppText>
              <AppText>
                Favourites, meal plans, shopping progress, saved preferences, private notes, cooking
                history and committed actions.
              </AppText>
            </View>
            {Platform.OS === 'web' && (
              <AppText role="support" color="inkSecondary">
                Your draft in this browser tab stays. It is separate from the saved conversation.
              </AppText>
            )}
            <AppText role="support" color="inkSecondary">
              Clearing cannot erase information already processed by Gemini.
            </AppText>
            <ActionButton
              ref={clearFocus.ref}
              label="Review clearing conversation"
              variant="secondary"
              disabled={!actions || actions.blocked}
              onPress={() =>
                void actions?.begin(
                  { kind: 'clearConversation' },
                  { confirm: true, restoreFocus: clearFocus.restoreFocus },
                )
              }
            />
          </View>
        )}
        {section === 'help' && (
          <View style={styles.section}>
            <AppText>Choose a task for a short guide.</AppText>
            {[
              [
                'Find a recipe',
                'Search by dish, ingredient or cuisine in Discover. Filters narrow the same results; the heart saves a recipe for later.',
              ],
              [
                'Watch a video',
                'When a recipe has a supplied video, choose Watch recipe beside its title or in Instructions. The video loads only when you choose it.',
              ],
              [
                'Plan a meal',
                'Choose a recipe, date and meal slot, then review the change. Replacing a meal also shows its shopping consequences before you confirm.',
              ],
              [
                'Choose shopping meals',
                'In Plan, open Shopping and choose which dated meals to include. Check the saved result, then mark ingredients as purchased. A changed amount may need review.',
              ],
              [
                'Understand source notes',
                'Source holds recipe credits and full notes. Important issues also appear beside the affected recipe or ingredient. An absent quantity is never treated as zero.',
              ],
              [
                'Ask CookMate',
                'When live chat is available, ask about recipes or compare their ingredients. Proposed changes need review; only a recorded result means they were saved. This browser preview can prepare a question but cannot send it.',
              ],
              [
                'Read while cooking',
                'Open Instructions, then Open cooking view. Ingredients stays read-only. Finish cooking opens a separate review before a history entry is saved.',
              ],
              [
                'Keep notes and collections',
                'Open Private note & collections near the recipe tabs. A private note does not change the recipe or its saved heart. Manage named collections from Favourites.',
              ],
              [
                'Back up or restore',
                'Open Settings → Backup & restore. Export makes an unencrypted private file; Inspect checks a file without changing your data. Restore requires its own consequence review.',
              ],
            ].map(([title, description]) => (
              <HelpTopic key={title} title={title!} description={description!} />
            ))}
            <ActionButton
              label="Explore recipes"
              variant="secondary"
              onPress={() => router.navigate('/')}
            />
            <ActionButton
              label="View meal plan"
              variant="quiet"
              onPress={() => router.navigate('/plan')}
            />
            <ActionButton
              label="Assistant preview"
              variant="quiet"
              accessibilityHint="Open a read-only example conversation. Your real conversation stays unchanged."
              onPress={() => router.setParams({ section: 'assistant-preview' })}
            />
          </View>
        )}
        {section === 'privacy' && (
          <View style={styles.section}>
            <View style={styles.helpEntry}>
              <AppText role="bodyStrong">Your data at a glance</AppText>
              <AppText role="support">
                Local workspace: saved recipes, plans and shopping. Account sync: supported data
                only, when configured. AI sharing: separate consent. Backup files: private copies
                you control.
              </AppText>
            </View>
            <AppText role="bodyStrong">Why is browser data separate?</AppText>
            <AppText>
              Your browser and iPhone each keep their own local cooking copy. Guest data stays on
              that device. When account services are configured, signing into the same CookMate
              account enables reviewed synchronization of supported cooking data. Account & sync
              shows what has actually been saved. An unsent browser draft stays in that tab;
              Assistant conversations and laptop pairing are separate from account sync.
            </AppText>
            <ActionButton
              label={privacyDetails ? 'Hide data and privacy details' : 'Data and privacy details'}
              variant="secondary"
              accessibilityState={{ expanded: privacyDetails }}
              onPress={() => setPrivacyDetails((value) => !value)}
            />
            <AnimatedDisclosure expanded={privacyDetails} style={styles.section}>
              <AppText role="section" accessibilityRole="header">
                Recipe data
              </AppText>
              <AppText>
                The 100 supplied recipes retain their photos, ingredients, raw measures and
                instructions. Recipe details include source links and known missing or conflicting
                information. External links need a network connection.
              </AppText>
              <AppText>
                Complete verified cooking times, servings, nutrition and allergy information are not
                provided. Check ingredients and instructions; preferences are not safety guarantees.
              </AppText>
              <AppText role="section" accessibilityRole="header">
                {Platform.OS === 'web' ? 'Saved in this browser' : 'Saved on this iPhone'}
              </AppText>
              <AppText>
                {Platform.OS === 'web'
                  ? 'This preview keeps local data in this browser. Different CookMate accounts use separate local workspaces. Anyone using this unlocked browser may access the local copy you choose to keep.'
                  : 'Different CookMate accounts use separate local workspaces. Anyone using this unlocked app may access the local copy you choose to keep. A laptop connection alone does not synchronize cooking data between phones.'}
              </AppText>
              <AppText>
                {Platform.OS === 'web'
                  ? 'Clearing site data, browser storage cleanup or using a temporary browsing session may lose your saved work. CookMate does not provide a cloud backup guarantee.'
                  : 'Uninstalling, clearing app data, losing the phone or storage damage may lose your saved work. CookMate does not provide a cloud backup guarantee.'}
              </AppText>
              <AppText>{assistantDataDisclosure.provider}</AppText>
              <AppText>
                Account sync supports favourites, meal plans, shopping selections and safe purchase
                state, saved cooking preferences, profile name, theme and language. It does not
                upload your Assistant conversations, drafts, API keys or laptop pairing credentials.
                Signing in does not grant AI consent. Local backups and cloud sync are separate;
                check Account & sync before relying on another device having your latest changes.
                Private notes, cooking history, collections and manual shopping items remain local;
                expanded backup files have a separate scope, with history included only when you opt
                in.
              </AppText>
            </AnimatedDisclosure>
          </View>
        )}
      </ContentFade>
    </Page>
  );
}

function HelpTopic({ title, description }: { title: string; description: string }) {
  const [open, setOpen] = useState(false);
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.helpEntry}>
      <ActionButton
        label={title}
        variant="quiet"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={{ justifyContent: 'flex-start' }}
      />
      <AnimatedDisclosure expanded={open}>
        <AppText color="inkSecondary">{description}</AppText>
      </AnimatedDisclosure>
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    menu: { backgroundColor: t.color.surface, borderRadius: t.radius.card, overflow: 'hidden' },
    menuRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      padding: t.space.md,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
      minHeight: t.control.minimumTarget,
    },
    icon: {
      width: 44,
      height: 44,
      borderRadius: t.radius.pill,
      backgroundColor: t.color.selection,
      justifyContent: 'center',
      alignItems: 'center',
    },
    rowText: { flex: 1, gap: t.space.xxs },
    pressed: { backgroundColor: t.color.selection },
    section: { gap: t.space.md },
    group: { gap: t.space.sm },
    helpEntry: {
      gap: t.space.xs,
      paddingBottom: t.space.sm,
      borderBottomWidth: 1,
      borderBottomColor: t.color.divider,
    },
  });
