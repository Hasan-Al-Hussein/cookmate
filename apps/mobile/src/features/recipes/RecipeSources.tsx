import { useTheme, useThemedStyles, type ThemeTokens } from '../../design/ThemeProvider';
import { useState, type ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import type { CatalogueRecipe } from '@cookmate/catalogue';
import { ActionButton, Notice } from '../../components/Controls';
import { AnimatedDisclosure } from '../../components/AnimatedDisclosure';
import { AppIcon, type IconName } from '../../components/Icon';
import { AppText } from '../../components/Typography';
import { safeSourceUrl, youtubeVideoId } from './video/videoModel';

export function RecipeSources({
  recipe,
  notes,
  revealNotes = false,
  onWatch,
}: {
  recipe: CatalogueRecipe;
  notes?: ReactNode;
  revealNotes?: boolean;
  onWatch?: () => void;
}) {
  const styles = useThemedStyles(createStyles);

  const [failedLink, setFailedLink] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(revealNotes);
  async function openSource(url: string) {
    setFailedLink(false);
    try {
      if (!safeSourceUrl(url)) throw new Error('Unsupported source URL');
      await Linking.openURL(url);
    } catch {
      setFailedLink(true);
    }
  }
  const publisher = safeSourceUrl(recipe.originalSourceUrl);
  return (
    <View style={styles.sources}>
      <View style={styles.group}>
        <AppText role="section" accessibilityRole="header">
          Recipe &amp; credits
        </AppText>
        <View style={styles.credits}>
          {safeSourceUrl(recipe.recipePage) ? (
            <CreditRow
              icon="book"
              label="Recipe collection"
              detail="TheMealDB"
              accessibilityLabel="Recipe collection, TheMealDB, opens external site"
              onPress={() => void openSource(recipe.recipePage)}
            />
          ) : (
            <AppText style={styles.missing}>Recipe collection link unavailable.</AppText>
          )}
          <View style={styles.divider} />
          {publisher ? (
            <CreditRow
              icon="globe"
              label="Original publisher"
              detail={publisher.hostname.replace(/^www\./, '')}
              accessibilityLabel={`Original publisher, ${publisher.hostname}, opens external site`}
              onPress={() => void openSource(recipe.originalSourceUrl!)}
            />
          ) : (
            <AppText role="support" color="inkSecondary" style={styles.missing}>
              {recipe.originalSourceUrl
                ? 'Original publisher link unavailable.'
                : 'Original publisher link not supplied.'}
            </AppText>
          )}
        </View>
      </View>
      {youtubeVideoId(recipe.videoUrl) && onWatch ? (
        <ActionButton
          label="Watch recipe"
          accessibilityHint="Opens the recipe video in Instructions."
          variant="quiet"
          style={styles.watch}
          onPress={onWatch}
        />
      ) : recipe.videoUrl && !youtubeVideoId(recipe.videoUrl) ? (
        <View style={styles.group}>
          <AppText role="support" color="inkSecondary">
            This supplied video link cannot be played inside CookMate.
          </AppText>
          {safeSourceUrl(recipe.videoUrl) && (
            <ActionButton
              label="Open video source ↗"
              variant="quiet"
              onPress={() => void openSource(recipe.videoUrl!)}
            />
          )}
        </View>
      ) : null}
      {failedLink && (
        <Notice title="Couldn’t open this source" tone="error">
          <AppText role="support">
            Your recipe is still available here. Check your connection and try opening the link
            again.
          </AppText>
        </Notice>
      )}
      <View style={styles.about}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About this source"
          accessibilityState={{ expanded: aboutOpen }}
          onPress={() => setAboutOpen((open) => !open)}
          style={styles.disclosure}
        >
          <AppText role="bodyStrong">About this source</AppText>
          <View style={{ transform: [{ rotate: aboutOpen ? '-90deg' : '90deg' }] }}>
            <AppIcon name="chevronRight" size={18} />
          </View>
        </Pressable>
        <AppText role="support" color="inkSecondary">
          Recipe credits, supplied tags
          {recipe.annotations.length
            ? ` and ${recipe.annotations.length} reviewed source ${recipe.annotations.length === 1 ? 'note' : 'notes'}`
            : ''}
          .
        </AppText>
        <AnimatedDisclosure expanded={aboutOpen} style={styles.group}>
          <AppText role="support">
            Recipe content and supplied photographs are retained from TheMealDB collection.
            Publisher links are shown as supplied.
          </AppText>
          {recipe.rawTags && (
            <View style={styles.group}>
              <AppText role="bodyStrong">Supplied tags</AppText>
              <View style={styles.tags}>
                {recipe.rawTags.split(',').map((tag, index) => (
                  <View key={index} style={styles.tag}>
                    <AppText role="support">{tag}</AppText>
                  </View>
                ))}
              </View>
              <AppText role="support" color="inkSecondary">
                Source labels only. These are not verified dietary or allergy claims.
              </AppText>
            </View>
          )}
          {notes}
        </AnimatedDisclosure>
      </View>
      <AppText role="support" color="inkSecondary">
        Category and cuisine labels describe the source collection. They do not establish allergy or
        dietary safety.
      </AppText>
    </View>
  );
}

function CreditRow({
  icon,
  label,
  detail,
  accessibilityLabel,
  onPress,
}: {
  icon: IconName;
  label: string;
  detail: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.iconWell}>
        <AppIcon name={icon} size={21} color={t.color.brandText} />
      </View>
      <View style={styles.rowText}>
        <AppText role="bodyStrong">{label}</AppText>
        <AppText role="support" color="inkSecondary">
          {detail}
        </AppText>
      </View>
      <AppIcon name="external" size={18} color={t.color.inkSecondary} />
    </Pressable>
  );
}
const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    sources: { gap: t.space.gutter },
    group: { gap: t.space.sm },
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs },
    tag: {
      maxWidth: '100%',
      paddingHorizontal: t.space.sm,
      paddingVertical: t.space.xs,
      borderRadius: t.radius.small,
      backgroundColor: t.color.surfaceMuted,
    },
    credits: {
      borderRadius: t.radius.control,
      backgroundColor: t.color.surface,
      borderWidth: 1,
      borderColor: t.color.divider,
      paddingHorizontal: t.space.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: t.space.sm,
      paddingVertical: t.space.md,
      minHeight: t.control.minimumTarget,
    },
    rowText: { flex: 1, minWidth: 0, gap: t.space.xxs },
    iconWell: {
      width: 42,
      height: 42,
      flexShrink: 0,
      borderRadius: t.radius.small,
      backgroundColor: t.color.selection,
      alignItems: 'center',
      justifyContent: 'center',
    },
    divider: { marginLeft: 42 + t.space.sm, borderBottomWidth: 1, borderColor: t.color.divider },
    watch: { alignSelf: 'flex-start', paddingHorizontal: 0 },
    pressed: { opacity: 0.7 },
    missing: { paddingVertical: t.space.md },
    about: {
      gap: t.space.xs,
      borderTopWidth: 1,
      borderColor: t.color.divider,
      paddingTop: t.space.xs,
    },
    disclosure: {
      minHeight: t.control.minimumTarget,
      flexDirection: 'row',
      gap: t.space.sm,
      alignItems: 'center',
      justifyContent: 'space-between',
    },
  });
