import { useTranslation } from 'react-i18next';
import { CommandPalette } from '@/components/chrome/CommandPalette';
import { DropOverlay } from '@/components/chrome/DropOverlay';
import { Sidebar } from '@/components/chrome/Sidebar';
import { TitleBar } from '@/components/chrome/TitleBar';
import { Toaster } from '@/components/chrome/Toaster';
import { useFileDrop } from '@/hooks/useFileDrop';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { useLanguageSync } from '@/hooks/useLanguageSync';
import { Collections } from '@/screens/Collections';
import { Explore } from '@/screens/Explore';
import { Hangar } from '@/screens/Hangar';
import { Queue } from '@/screens/Queue';
import { Settings } from '@/screens/Settings';
import { useUi } from '@/store/ui';
import type { Section } from '@/types';

const SCREENS: Record<Section, () => JSX.Element> = {
  explore: Explore,
  hangar: Hangar,
  collections: Collections,
  queue: Queue,
  settings: Settings,
};

export function App() {
  useKeyboardShortcuts();
  useFileDrop();
  useLanguageSync();
  const { t } = useTranslation();
  const screen = useUi((s) => s.screen);
  const Screen = SCREENS[screen];

  return (
    <div className="flex h-full flex-col bg-bg-2 text-ink-1">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        {/* Content areas carry the 28px ruled grid; sidebar and title bar do not. */}
        <main aria-label={t(`common.nav.${screen}`)} className="relative min-w-0 flex-1 overflow-hidden bg-grid">
          <Screen />
        </main>
      </div>
      <CommandPalette />
      <DropOverlay />
      <Toaster />
    </div>
  );
}
