import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import {
  canonicalContentJson,
  validateRecipeContentRef,
  type RecipeContentRef,
} from '@cookmate/catalogue/content';
import { ActionButton } from '../../components/Controls';
import { useOrdinaryContentRuntime } from '../content/ordinaryContentRuntimeContext';
import { usePersonalPorts } from './PersonalUI';
const alwaysCurrent = () => true;
/** Secondary action; notes follow recipe identity without changing source wording or saved status. */
export function RecipePersonalEntry({
  recipeId,
  contentRef,
  isCurrent = alwaysCurrent,
}: {
  recipeId: string;
  contentRef?: Readonly<RecipeContentRef>;
  isCurrent?: () => boolean;
}) {
  const ports = usePersonalPorts();
  const runtime = useOrdinaryContentRuntime();
  const router = useRouter();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const render = { recipeId, contentRef, isCurrent, runtime, ports };
  const latest = useRef(render);
  latest.current = render;
  if (runtime) {
    const state = runtime.host.getSnapshot();
    let serialized: string | undefined;
    try {
      if (contentRef !== undefined) {
        if (!validateRecipeContentRef(contentRef) || contentRef.recipeId !== recipeId) return null;
        serialized = canonicalContentJson(contentRef, 1024);
      }
    } catch {
      return null;
    }
    if (!/^[0-9]{1,20}$/.test(recipeId) || state.status !== 'ready') return null;
    return (
      <ActionButton
        label="Private note & collections"
        variant="quiet"
        onPress={() => {
          const current = runtime.host.getSnapshot();
          if (
            mounted.current &&
            latest.current === render &&
            isCurrent() &&
            current.status === 'ready' &&
            current.scopeKey === state.scopeKey
          )
            router.push({
              pathname: '/recipe-personal/[id]',
              params: { id: recipeId, ...(serialized ? { contentRef: serialized } : {}) },
            });
        }}
      />
    );
  }
  return ports && contentRef === undefined ? (
    <ActionButton
      label="Private note & collections"
      variant="quiet"
      onPress={() => {
        if (mounted.current && latest.current === render && isCurrent())
          router.push({ pathname: '/recipe-personal/[id]', params: { id: recipeId } });
      }}
    />
  ) : null;
}
