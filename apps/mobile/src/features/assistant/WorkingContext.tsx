import { useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { MemoryItem } from '@cookmate/contracts';
import type { ContextNarrowing, ConversationMemoryPage, Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { useAssistant } from './useAssistant';
import { assistantError, repositoryValue } from './assistantRuntime';
import { errorCopy } from './assistantCopy';

/** Presentation groups only; Data independently expands and validates the submitted selection. */
function relatedGroups(items: readonly Immutable<MemoryItem>[]) {
  const byId = new Map(items.map((item) => [item.memoryId, item]));
  const neighbors = new Map(items.map((item) => [item.memoryId, new Set<string>()]));
  for (const item of items)
    for (const relation of item.relations) {
      if (!byId.has(relation.target.memoryId)) continue;
      neighbors.get(item.memoryId)!.add(relation.target.memoryId);
      neighbors.get(relation.target.memoryId)!.add(item.memoryId);
    }
  const remaining = new Set(byId.keys());
  const groups: Immutable<MemoryItem>[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    const ids = new Set<string>();
    const pending = [first];
    while (pending.length) {
      const id = pending.pop()!;
      if (ids.has(id)) continue;
      ids.add(id);
      neighbors.get(id)?.forEach((related) => {
        if (!ids.has(related)) pending.push(related);
      });
    }
    groups.push([...ids].flatMap((id) => (byId.get(id) ? [byId.get(id)!] : [])));
    ids.forEach((id) => remaining.delete(id));
  }
  return groups;
}
export function WorkingContext({ narrowing }: { narrowing: ContextNarrowing }) {
  const styles = useThemedStyles(createStyles);

  const { assistant } = useAssistant();
  const [page, setPage] = useState<ConversationMemoryPage>();
  const [items, setItems] = useState<readonly Immutable<MemoryItem>[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [complete, setComplete] = useState(false);
  const groups = useMemo(() => relatedGroups(items), [items]);
  async function load() {
    if (!assistant) return;
    setBusy(true);
    setError(undefined);
    try {
      const all: Immutable<MemoryItem>[] = [];
      let beforeSequence: number | undefined;
      let first: ConversationMemoryPage | undefined;
      do {
        const next = repositoryValue(
          await assistant.core.readMemoryPage({
            ...(beforeSequence === undefined ? {} : { beforeSequence }),
            limit: 100,
          }),
        );
        first ??= next;
        if (
          next.header.revision !== narrowing.revision ||
          next.header.generation !== first.header.generation
        )
          throw new Error('changed');
        all.push(...next.items);
        beforeSequence =
          next.hasEarlier && next.beforeSequence !== null ? next.beforeSequence : undefined;
      } while (beforeSequence !== undefined);
      setItems(all);
      setPage(first);
      setSelected([]);
    } catch {
      setError(
        'The conversation changed or could not be read. Check its current state before choosing context.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function choose(fresh: boolean) {
    if (!assistant || !page) return;
    setBusy(true);
    setError(undefined);
    try {
      repositoryValue(
        await assistant.core.setWorkingContext({
          expectedContextRevision: narrowing.revision,
          afterSequence: page.header.nextSequence - 1,
          carryMemoryIds: fresh ? [] : selected,
        }),
      );
      setComplete(true);
      assistant.workingContextChanged();
      await assistant.reload();
    } catch (error) {
      setError(errorCopy(assistantError(error)));
    } finally {
      setBusy(false);
    }
  }
  if (complete)
    return (
      <Notice title="Working context updated">
        Your full conversation remains saved. Write a fresh brief and send it when you are ready.
      </Notice>
    );
  return (
    <Notice title="Choose context for your next request" tone="caution">
      <AppText role="support">
        The relevant conversation does not fit this request. Nothing has been silently removed. Your
        full transcript and saved preferences remain available.
      </AppText>
      <AppText role="support">
        {narrowing.coverage.retainedEntryCount} retained context entries;{' '}
        {narrowing.coverage.omittedEntryCount} omitted from this proposed packet;{' '}
        {narrowing.coverage.pendingWorkingSourceCount} user messages still need context review.
      </AppText>
      <ActionButton
        label="Review working context"
        variant="secondary"
        busy={busy}
        onPress={() => void load()}
      />
      {page && (
        <>
          <AppText role="support">
            Select earlier statements to carry into this task. Related corrections and conflicts
            stay together. These are temporary conversation statements, separate from Saved
            preferences. Restate other needed details in your next message.
          </AppText>
          {groups.map((group) => {
            const ids = group.map((item) => item.memoryId);
            const chosen = ids.every((id) => selected.includes(id));
            return (
              <View key={ids[0]} style={[styles.statementGroup, chosen && styles.selectedGroup]}>
                {group.map((item) => (
                  <AppText key={item.memoryId}>“{item.quote}”</AppText>
                ))}
                <ActionButton
                  label={`${chosen ? 'Remove' : 'Carry'} ${group.length === 1 ? 'this statement' : 'these related statements'}`}
                  variant="secondary"
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: chosen }}
                  onPress={() =>
                    setSelected(
                      chosen
                        ? selected.filter((id) => !ids.includes(id))
                        : [...selected, ...ids.filter((id) => !selected.includes(id))],
                    )
                  }
                />
              </View>
            );
          })}
          <AppText role="support">
            {selected.length} context entries selected. A set that exceeds the request budget will
            be rejected without changing context.
          </AppText>
          <ActionButton
            label="Use selected context for this task"
            disabled={!selected.length || busy}
            onPress={() => void choose(false)}
          />
          <ActionButton
            label="Start fresh working context"
            variant="secondary"
            disabled={busy}
            onPress={() => void choose(true)}
          />
          <AppText role="support">
            Starting fresh uses no earlier temporary statements. It does not clear the transcript or
            saved preferences and does not send a message.
          </AppText>
        </>
      )}
      {error && (
        <AppText role="support" color="error">
          {error}
        </AppText>
      )}
      <ActionButton
        label="Keep draft and return to conversation"
        variant="quiet"
        disabled={busy}
        onPress={() => assistant?.returnToDraft()}
      />
    </Notice>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    statementGroup: {
      gap: t.space.sm,
      padding: t.space.md,
      backgroundColor: t.color.surface,
      borderRadius: t.radius.card,
      borderWidth: 1,
      borderColor: t.color.divider,
    },
    selectedGroup: { borderColor: t.color.brand, backgroundColor: t.color.selection },
  });
