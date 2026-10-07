import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { useMotionPolicy } from '../design/MotionPolicy';
import { motionTokens } from '../design/motion';

type SheetPhase = 'entering' | 'open' | 'closing' | 'closed';
type Presence = { phase: SheetPhase; presentation: number };

/** Owns decorative presence; the caller still owns close approval and saved state. */
export function useSheetPresence({
  visible,
  onShow,
  onDismiss,
}: {
  visible: boolean;
  onShow?: () => void;
  onDismiss?: () => void;
}) {
  const reduced = useMotionPolicy();
  const [presence, setPresence] = useState<Presence>({
    phase: visible ? 'entering' : 'closed',
    presentation: visible ? 1 : 0,
  });
  const current = useRef(presence);
  const latest = useRef({ visible, reduced, onShow, onDismiss });
  latest.current = { visible, reduced, onShow, onDismiss };
  const mounted = useRef(true);
  const shown = useRef(false);
  const awaitingDismissal = useRef(false);
  const animationVersion = useRef(0);
  const animation = useRef<Animated.CompositeAnimation | null>(null);
  const opacity = useRef(new Animated.Value(visible && !reduced ? 0.65 : 1)).current;
  const translateY = useRef(
    new Animated.Value(visible && !reduced ? motionTokens.distance.contentEnter : 0),
  ).current;

  const update = useCallback((next: Presence) => {
    current.current = next;
    if (mounted.current) setPresence(next);
  }, []);
  const stop = useCallback(() => {
    animationVersion.current += 1;
    animation.current?.stop();
    animation.current = null;
  }, []);
  const settle = useCallback(
    (open: boolean) => {
      stop();
      opacity.setValue(open ? 1 : 0);
      translateY.setValue(open ? 0 : motionTokens.distance.contentEnter);
      awaitingDismissal.current = !open;
      update({ ...current.current, phase: open ? 'open' : 'closed' });
    },
    [opacity, stop, translateY, update],
  );
  const animate = useCallback(
    (open: boolean) => {
      stop();
      update({ ...current.current, phase: open ? 'entering' : 'closing' });
      const version = animationVersion.current;
      const config = {
        duration: open ? motionTokens.duration.sheet : motionTokens.duration.content,
        easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
        isInteraction: false,
      };
      const transition = Animated.parallel([
        Animated.timing(opacity, { ...config, toValue: open ? 1 : 0 }),
        Animated.timing(translateY, {
          ...config,
          toValue: open ? 0 : motionTokens.distance.contentEnter,
        }),
      ]);
      animation.current = transition;
      transition.start(() => {
        if (!mounted.current || animationVersion.current !== version) return;
        // An externally interrupted animation must still leave a real final surface.
        animation.current = null;
        settle(open);
      });
    },
    [opacity, settle, stop, translateY, update],
  );
  const open = useCallback(() => {
    stop();
    shown.current = false;
    awaitingDismissal.current = false;
    opacity.setValue(latest.current.reduced ? 1 : 0.65);
    translateY.setValue(latest.current.reduced ? 0 : motionTokens.distance.contentEnter);
    update({ phase: 'entering', presentation: current.current.presentation + 1 });
  }, [opacity, stop, translateY, update]);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      awaitingDismissal.current = false;
      stop();
    };
  }, [stop]);

  useLayoutEffect(() => {
    const phase = current.current.phase;
    if (visible) {
      if (phase === 'closed') {
        // Reopening an already-hidden native modal waits for its physical dismissal.
        if (!awaitingDismissal.current) open();
      } else if (reduced) settle(true);
      else if (phase === 'closing' || (phase === 'entering' && shown.current && !animation.current))
        animate(true);
    } else if (phase !== 'closed') {
      if (reduced || !shown.current) settle(false);
      else if (phase !== 'closing') animate(false);
    }
  }, [animate, open, reduced, settle, visible]);

  const didShow = useCallback(() => {
    if (
      !mounted.current ||
      !latest.current.visible ||
      current.current.phase === 'closed' ||
      shown.current
    )
      return;
    shown.current = true;
    if (latest.current.reduced) settle(true);
    else animate(true);
    latest.current.onShow?.();
  }, [animate, settle]);

  const didDismiss = useCallback(() => {
    if (
      !mounted.current ||
      current.current.presentation !== presence.presentation ||
      current.current.phase !== 'closed' ||
      !awaitingDismissal.current
    )
      return;
    awaitingDismissal.current = false;
    shown.current = false;
    if (latest.current.visible) open();
    else latest.current.onDismiss?.();
  }, [open, presence.presentation]);

  useEffect(() => {
    if (
      presence.phase !== 'closed' ||
      !awaitingDismissal.current ||
      (Platform.OS !== 'android' && shown.current)
    )
      return;
    // Android has no Modal.onDismiss. A never-shown modal may emit none on any platform.
    // Both paths wait until the hidden modal has left the committed view.
    const frame = requestAnimationFrame(didDismiss);
    return () => cancelAnimationFrame(frame);
  }, [didDismiss, presence.phase]);

  return {
    phase: presence.phase,
    present: presence.phase !== 'closed',
    onShow: didShow,
    onDismiss: didDismiss,
    style: { opacity, transform: [{ translateY }] },
  };
}
