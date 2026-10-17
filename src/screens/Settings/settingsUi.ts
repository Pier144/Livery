import { create } from 'zustand';
import { useUi } from '@/store/ui';

/** Left-nav order (WT Live sits after Backups, Atelier before About). */
export const SECTIONS = ['general', 'game', 'conflicts', 'backups', 'wtlive', 'language', 'updates', 'atelier', 'about'] as const;
export type SettingsSection = (typeof SECTIONS)[number];

interface SettingsUiState {
  /** Open section; kept while the app runs (leaving Settings and coming back reopens it), not persisted. */
  section: SettingsSection;
  /**
   * Backups → Clear waits for its Undo window: ids of the backups it will delete (hidden from the
   * UI until the toast leaves), or null when no Clear is pending.
   */
  clearingBackups: readonly string[] | null;
  /** Game → Change sent the user to First run: focus that button again when Settings comes back. */
  refocusGameChange: boolean;
  setSection: (section: SettingsSection) => void;
}

const initial: Pick<SettingsUiState, 'section' | 'clearingBackups' | 'refocusGameChange'> = {
  section: 'general',
  clearingBackups: null,
  refocusGameChange: false,
};

export const useSettingsUi = create<SettingsUiState>()((set) => ({
  ...initial,
  setSection: (section) => set({ section }),
}));

/** Opens Settings on a section (e.g. "Open Settings" in the WT Live "turned off" states). */
export function openSettingsAt(section: SettingsSection) {
  useSettingsUi.getState().setSection(section);
  useUi.getState().go('settings');
}

/** Tests: back to the first section with nothing pending. */
export function resetSettingsUi() {
  useSettingsUi.setState(initial);
}
