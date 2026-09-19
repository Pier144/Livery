import { useEffect } from 'react';
import { useUi } from '@/store/ui';
import type { Section } from '@/types';

/** Digit (and ",") → section. "," mirrors the Settings hint shown in the sidebar. */
export const SECTION_KEYS: Record<string, Section> = {
  '1': 'explore',
  '2': 'hangar',
  '3': 'collections',
  '4': 'queue',
  '5': 'settings',
  ',': 'settings',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Window-level shortcuts: Ctrl/Cmd+K palette, Esc close, 1–5 sections, [ / ] sidebar.
 * Section and sidebar keys are ignored while typing or with modifiers held.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ui.togglePalette();
        return;
      }
      if (e.key === 'Escape') {
        ui.dismissTransient();
        return;
      }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || ui.palette.open) return;
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        ui.toggleSidebar();
        return;
      }
      const section = SECTION_KEYS[e.key];
      if (section) {
        e.preventDefault();
        ui.go(section);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
