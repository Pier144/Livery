import { useEffect } from 'react';
import { useToasts } from '@/store/toasts';
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

/** A modal dialog other than the palette is open (conflict, licenses). */
function modalDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') !== null;
}

/**
 * Window-level shortcuts: Ctrl/Cmd+K palette, Esc close, Ctrl/Cmd+Z undo last toast, 1–5 sections, [ / ] sidebar.
 * Section and sidebar keys are ignored while typing, with modifiers held, and during First run
 * (no sidebar there; leaving it takes the screen's own actions, as in the prototype). A section
 * key moves focus to the new screen's heading (`useScreenFocus`, mounted in App).
 * Ctrl/Cmd+K doesn't open the palette over a modal dialog: its actions would navigate under it.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUi.getState();
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (ui.palette.open || !modalDialogOpen()) ui.togglePalette();
        return;
      }
      if (e.key === 'Escape') {
        ui.dismissTransient();
        return;
      }
      // Ctrl/Cmd+Z undoes the newest undoable toast, so keyboard users needn't reach its button in 6 s.
      // Inputs keep their native text undo.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTypingTarget(e.target)) {
        if (useToasts.getState().undoLatest()) e.preventDefault();
        return;
      }
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || ui.palette.open || ui.screen === 'firstRun') return;
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        ui.toggleSidebar();
        return;
      }
      const section = SECTION_KEYS[e.key];
      if (section) {
        e.preventDefault();
        if (section === ui.screen) return;
        ui.go(section);
        ui.focusHeading();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
