import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandPalette } from '@/components/chrome/CommandPalette';
import { DropOverlay } from '@/components/chrome/DropOverlay';
import { Sidebar } from '@/components/chrome/Sidebar';
import { TitleBar } from '@/components/chrome/TitleBar';
import { Toaster } from '@/components/chrome/Toaster';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useInstallEvents } from '@/hooks/useInstallEvents';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useLanguageSync } from '@/hooks/useLanguageSync';
import { useSettings } from '@/queries/settings';
import { Collections } from '@/screens/Collections';
import { Explore } from '@/screens/Explore';
import { FirstRun } from '@/screens/FirstRun/FirstRun';
import { Hangar } from '@/screens/Hangar';
import { Queue } from '@/screens/Queue';
import { Settings } from '@/screens/Settings';
import { useUi } from '@/store/ui';
import type { Screen } from '@/types';

const SCREENS: Record<Screen, () => JSX.Element> = {
  explore: Explore,
  hangar: Hangar,
  collections: Collections,
  queue: Queue,
  settings: Settings,
  firstRun: FirstRun,
};

/**
 * Picks the start screen once, when settings first arrive: no game folder and onboarding not
 * finished → First run. Later settings changes and `go()` calls are never overridden.
 * Returns false until then, so the shell shows no sidebar and no screen (no flash of Explore).
 */
function useBootScreen(): boolean {
  const { data, isError } = useSettings();
  const decided = useRef(false);
  const [booted, setBooted] = useState(false);

  // Layout effect: the screen switch and the reveal land in one commit, before paint.
  useLayoutEffect(() => {
    if (decided.current || (!data && !isError)) return;
    decided.current = true;
    // Unreadable settings: open the app rather than trap the user in First run.
    if (data && !data.onboarded && !data.gamePath) useUi.getState().go('firstRun');
    setBooted(true);
  }, [data, isError]);

  return booted;
}

export function App() {
  useKeyboardShortcuts();
  useFileDrop();
  useInstallEvents();
  useLanguageSync();
  const booted = useBootScreen();
  const { t } = useTranslation();
  const screen = useUi((s) => s.screen);
  const Screen = SCREENS[screen];
  // First run takes the full width, as in the prototype.
  const withSidebar = booted && screen !== 'firstRun';

  const label = !booted
    ? t('common.loading')
    : screen === 'firstRun'
      ? t('firstRun.label')
      : t(`common.nav.${screen}`);

  return (
    <div className="flex h-full flex-col bg-bg-2 text-ink-1">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        {withSidebar && <Sidebar />}
        {/* Content areas carry the 28px ruled grid; sidebar and title bar do not. */}
        <main
          aria-label={label}
          aria-busy={booted ? undefined : true}
          className="relative min-w-0 flex-1 overflow-hidden bg-grid"
        >
          {booted && <Screen />}
        </main>
      </div>
      <CommandPalette />
      <DropOverlay />
      <Toaster />
    </div>
  );
}
