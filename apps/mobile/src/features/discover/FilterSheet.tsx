import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { normalizeSearchText, type SearchCriteria } from '@cookmate/domain';
import { ActionButton, SegmentControl, useControlStyles } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import { AppIcon } from '../../components/Icon';
import { focusTarget } from '../../components/focusTarget';
import { controlStateProps } from '../../components/controlStateProps';
import { PresenceModal, useModalAction } from '../../components/PresenceModal';
import { SelectionIndicator } from '../../components/SelectionIndicator';
import { useNativeLayout } from '../../hooks/useNativeLayout';
import { useDiscoverCatalogue } from './DiscoverState';

export function FilterSheet({
  visible,
  criteria,
  onApply,
  onClose,
  onDismiss,
}: {
  visible: boolean;
  criteria: SearchCriteria;
  onApply: (criteria: SearchCriteria) => void;
  onClose: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const controlStyles = useControlStyles();
  const catalogue = useDiscoverCatalogue().ready;

  const [draft, setDraft] = useState(criteria);
  const [section, setSection] = useState<'category' | 'cuisine' | 'ingredients'>('category');
  const [ingredientQuery, setIngredientQuery] = useState('');
  const [cuisineQuery, setCuisineQuery] = useState('');
  const heading = useRef<View>(null);
  const choices = useRef<FlatList<string>>(null);
  const { enlarged } = useNativeLayout();
  const apply = useModalAction(visible && !!catalogue, () => onApply(draft));
  const close = useModalAction(visible, onClose);
  useEffect(() => {
    if (visible) setDraft(criteria);
  }, [visible, criteria]);
  useEffect(() => {
    choices.current?.scrollToOffset({ offset: 0, animated: false });
  }, [section]);
  const labels = !catalogue
    ? []
    : section === 'category'
      ? catalogue.facets.categories
      : section === 'cuisine'
        ? catalogue.facets.cuisines.filter((label) =>
            normalizeSearchText(label).includes(normalizeSearchText(cuisineQuery)),
          )
        : catalogue.facets.ingredients.filter((label) =>
            normalizeSearchText(label).includes(normalizeSearchText(ingredientQuery)),
          );
  function toggle(label: string) {
    if (!catalogue) return;
    if (section === 'ingredients') {
      const selected = draft.ingredients ?? [];
      setDraft({
        ...draft,
        ingredients: selected.includes(label)
          ? selected.filter((value) => value !== label)
          : [...selected, label],
      });
      return;
    }
    setDraft({ ...draft, [section]: draft[section] === label ? '' : label });
  }
  return (
    <PresenceModal
      visible={visible}
      preview
      accessibilityLabel="Filter recipes"
      presentationStyle="fullScreen"
      onRequestClose={close}
      onDismiss={onDismiss}
      onShow={() => {
        focusTarget(heading.current);
      }}
    >
      <SafeAreaView style={styles.root}>
        <KeyboardAvoidingView behavior="padding" style={styles.root}>
          <View style={styles.header}>
            <View
              ref={heading}
              accessible
              accessibilityRole="header"
              accessibilityLabel="Filter recipes"
            >
              <AppText role="title">Filter recipes</AppText>
            </View>
            <ActionButton label="Cancel" variant="quiet" onPress={close} />
          </View>
          <FlatList
            ref={choices}
            testID="filter-choices"
            style={styles.list}
            data={labels}
            keyExtractor={(label) => label}
            extraData={draft}
            initialNumToRender={12}
            maxToRenderPerBatch={12}
            windowSize={5}
            removeClippedSubviews={false}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'web' ? 'none' : 'on-drag'}
            contentContainerStyle={styles.content}
            ListHeaderComponent={
              <View style={styles.listHeader}>
                <AppText>Filters narrow your search together.</AppText>
                <AppText role="support" color="inkSecondary">
                  Categories describe the collection. They are not verified allergy or dietary
                  classifications.
                </AppText>
                <SegmentControl
                  value={section}
                  onChange={setSection}
                  options={[
                    { value: 'category', label: 'Category' },
                    { value: 'cuisine', label: 'Cuisine' },
                    { value: 'ingredients', label: 'Ingredients' },
                  ]}
                />
                {section === 'cuisine' && (
                  <TextInput
                    accessibilityLabel="Find a cuisine filter"
                    placeholder="Find a cuisine"
                    placeholderTextColor={t.color.inkSecondary}
                    value={cuisineQuery}
                    onChangeText={setCuisineQuery}
                    style={controlStyles.field}
                  />
                )}
                {section !== 'ingredients' && !!draft[section] && (
                  <ActionButton
                    label={`Clear ${section}`}
                    variant="quiet"
                    onPress={() => setDraft((value) => ({ ...value, [section]: '' }))}
                  />
                )}
                {section === 'ingredients' && (
                  <>
                    <AppText role="section" accessibilityRole="header">
                      Search by ingredients
                    </AppText>
                    <AppText role="support">
                      Recipes containing all selected ingredients. Other ingredients may still be
                      needed.
                    </AppText>
                    <AppText role="support">
                      {draft.ingredients?.length ?? 0} ingredients selected · Match all
                    </AppText>
                    <TextInput
                      accessibilityLabel="Find an ingredient filter"
                      placeholder="Find an ingredient"
                      placeholderTextColor={t.color.inkSecondary}
                      value={ingredientQuery}
                      onChangeText={setIngredientQuery}
                      style={controlStyles.field}
                    />
                    {!!draft.ingredients?.length && (
                      <View style={styles.chips}>
                        {draft.ingredients.map((label) => (
                          <Pressable
                            key={label}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${label} ingredient filter`}
                            onPress={() => toggle(label)}
                            style={styles.chip}
                          >
                            <AppText role="support" color="brand" style={{ flexShrink: 1 }}>
                              {label}
                            </AppText>
                            <AppIcon name="close" size={16} color={t.color.brandText} />
                          </Pressable>
                        ))}
                      </View>
                    )}
                  </>
                )}
              </View>
            }
            renderItem={({ item: label }) => {
              const role = section === 'ingredients' ? 'checkbox' : 'radio';
              const selected =
                section === 'ingredients'
                  ? !!draft.ingredients?.includes(label)
                  : draft[section] === label;
              return (
                <Pressable
                  accessibilityRole={role}
                  {...controlStateProps({ checked: selected }, role)}
                  onPress={() => toggle(label)}
                  style={({ pressed }) => [
                    styles.choice,
                    selected && styles.selected,
                    pressed && styles.selected,
                  ]}
                >
                  <View
                    style={[
                      styles.check,
                      role === 'radio' && styles.radio,
                      selected && styles.checked,
                    ]}
                  >
                    <SelectionIndicator selected={selected}>
                      {role === 'radio' ? (
                        <View style={styles.radioDot} />
                      ) : (
                        <AppIcon name="check" color={t.color.onBrand} size={16} />
                      )}
                    </SelectionIndicator>
                  </View>
                  <AppText style={styles.label}>{label}</AppText>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <AppText>
                {catalogue
                  ? `No ${section === 'cuisine' ? 'cuisines' : 'ingredient labels'} match. Try a shorter word.`
                  : 'Recipe filters are unavailable until this workspace catalogue is ready.'}
              </AppText>
            }
          />
          <View testID="filter-actions" style={[styles.actions, enlarged && styles.stackedActions]}>
            <ActionButton
              label="Reset filters"
              variant="quiet"
              style={[!enlarged && styles.action]}
              onPress={() => setDraft({ query: criteria.query ?? '' })}
            />
            <ActionButton
              label="Apply filters"
              disabled={!catalogue}
              style={[!enlarged && styles.action]}
              onPress={apply}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </PresenceModal>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.color.canvas },
    header: {
      padding: t.space.gutter,
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: t.space.xs,
    },
    list: { flex: 1, minHeight: 0 },
    content: { paddingHorizontal: t.space.gutter, paddingBottom: t.space.md },
    listHeader: { gap: t.space.md, paddingBottom: t.space.md },
    actions: {
      flexDirection: 'row',
      gap: t.space.sm,
      padding: t.space.md,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      backgroundColor: t.color.surface,
    },
    stackedActions: { flexDirection: 'column' },
    action: { flexGrow: 1, flexBasis: 0 },
    choice: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      borderBottomWidth: 1,
      borderColor: t.color.divider,
      paddingVertical: t.space.sm,
      paddingHorizontal: t.space.xs,
    },
    selected: { backgroundColor: t.color.selection, borderRadius: t.radius.small },
    check: {
      width: 24,
      height: 24,
      borderWidth: 1,
      borderColor: t.color.controlBorder,
      borderRadius: 7,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checked: { backgroundColor: t.color.brand, borderColor: t.color.brand },
    radio: { borderRadius: 12 },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: t.color.onBrand },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    chip: {
      maxWidth: '100%',
      minHeight: t.control.minimumTarget,
      paddingHorizontal: t.space.sm,
      gap: t.space.xs,
      flexDirection: 'row',
      alignItems: 'center',
      borderRadius: t.radius.pill,
      backgroundColor: t.color.selection,
    },
    label: { flex: 1 },
  });
