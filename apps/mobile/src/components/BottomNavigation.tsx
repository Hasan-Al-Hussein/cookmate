import { MotionPressable as Pressable } from './MotionPressable';
import { useState, type ComponentProps } from 'react';
import { Tabs } from 'expo-router';
import { StyleSheet, View, type LayoutRectangle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useThemedStyles } from '../design/ThemeProvider';
import type { ThemeTokens } from '../design/ThemeProvider';
import { useNativeLayout } from '../hooks/useNativeLayout';
import { AppText } from './Typography';
import { controlStateProps } from './controlStateProps';
import { AppIcon, type IconName } from './Icon';
import { TabSelection } from './TabSelection';

const tabIcons: Record<string, IconName> = {
  index: 'home',
  favourites: 'heart',
  plan: 'calendar',
  assistant: 'chat',
  settings: 'settings',
};

type TabBarProps = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

export function BottomNavigation({ state, descriptors, navigation }: TabBarProps) {
  const { fontScale } = useNativeLayout();
  const { bottom } = useSafeAreaInsets();
  const t = useTheme();
  const styles = useThemedStyles(createStyles);
  const columns = fontScale > 1.8 ? 2 : fontScale > 1.2 ? 3 : state.routes.length;
  const [frames, setFrames] = useState<Record<string, LayoutRectangle>>({});
  const [icons, setIcons] = useState<Record<string, LayoutRectangle>>({});
  const selectedKey = state.routes[state.index]?.key ?? '';
  const frame = frames[selectedKey];
  const icon = icons[selectedKey];
  const position = frame && icon ? { x: frame.x + icon.x, y: frame.y + icon.y } : undefined;
  const remember = (setter: typeof setFrames, key: string, layout: LayoutRectangle) =>
    setter((current) => {
      const old = current[key];
      return old &&
        old.x === layout.x &&
        old.y === layout.y &&
        old.width === layout.width &&
        old.height === layout.height
        ? current
        : { ...current, [key]: layout };
    });
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottom, t.space.xs) }]}>
      <TabSelection position={position} selectionKey={selectedKey} />
      {state.routes.map((route, index) => {
        const selected = state.index === index;
        const title = descriptors[route.key]?.options.title ?? route.name;
        return (
          <Pressable
            key={route.key}
            onLayout={(event) => remember(setFrames, route.key, event.nativeEvent.layout)}
            accessibilityRole="tab"
            accessibilityLabel={title}
            {...controlStateProps({ selected }, 'tab')}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!selected && !event.defaultPrevented)
                navigation.navigate(route.name, route.params);
            }}
            onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
            style={({ pressed }) => [
              styles.tab,
              { width: `${100 / columns}%` },
              pressed && styles.pressed,
            ]}
          >
            <View
              onLayout={(event) => remember(setIcons, route.key, event.nativeEvent.layout)}
              style={[styles.icon, selected && !position && styles.iconSelected]}
            >
              <AppIcon
                name={tabIcons[route.name] ?? 'home'}
                size={23}
                color={selected ? t.color.brandText : t.color.inkSecondary}
                selected={selected}
              />
            </View>
            <AppText
              role="navigation"
              color={selected ? 'brand' : 'inkSecondary'}
              style={styles.label}
            >
              {title}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = (t: ThemeTokens) =>
  StyleSheet.create({
    bar: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'center',
      backgroundColor: t.color.surface,
      borderTopWidth: 1,
      borderTopColor: t.color.divider,
      paddingHorizontal: t.space.xs,
      paddingTop: t.space.xs,
    },
    tab: {
      minHeight: 62,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.space.xxs,
      paddingVertical: t.space.xxs,
      gap: 2,
      borderRadius: t.radius.control,
    },
    pressed: { opacity: 0.7 },
    icon: {
      minWidth: 44,
      height: 30,
      borderRadius: t.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconSelected: { backgroundColor: t.color.selection },
    label: { textAlign: 'center', flexShrink: 1 },
  });
