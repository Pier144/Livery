import { useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { AboutSection } from './Settings/AboutSection';
import { BackupsSection } from './Settings/BackupsSection';
import { ConflictsSection } from './Settings/ConflictsSection';
import { GameSection } from './Settings/GameSection';
import { GeneralSection } from './Settings/GeneralSection';
import { LanguageSection } from './Settings/LanguageSection';
import { SECTIONS, useSettingsUi, type SettingsSection } from './Settings/settingsUi';
import { UpdatesSection } from './Settings/UpdatesSection';

const PANELS: Record<SettingsSection, () => JSX.Element> = {
  general: GeneralSection,
  game: GameSection,
  conflicts: ConflictsSection,
  backups: BackupsSection,
  language: LanguageSection,
  updates: UpdatesSection,
  about: AboutSection,
};

/**
 * Settings (README §7): section nav on the left (a vertical tablist: ↑/↓ move and open, Home/End),
 * the open section on the right (640px of content at most). The open section is remembered while the app runs.
 */
export function Settings() {
  const { t } = useTranslation();
  const section = useSettingsUi((s) => s.section);
  const setSection = useSettingsUi((s) => s.setSection);
  const baseId = useId();
  const tabId = (s: SettingsSection) => `${baseId}-tab-${s}`;
  const panelId = `${baseId}-panel`;
  const tabs = useRef<Partial<Record<SettingsSection, HTMLButtonElement | null>>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // A newly opened section starts at the top.
  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [section]);

  const open = (next: SettingsSection) => {
    setSection(next);
    tabs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = SECTIONS.length;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = (i + 1) % n;
        break;
      case 'ArrowUp':
        next = (i - 1 + n) % n;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = n - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    open(SECTIONS[next] ?? section);
  };

  const Panel = PANELS[section];

  return (
    <div className="relative grid h-full min-h-0 grid-cols-[200px_minmax(0,1fr)]">
      <h1 className="sr-only">{t('settings.title')}</h1>
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('settings.sections')}
        className="flex flex-col gap-0.5 border-r border-line-2 px-3 py-4.5"
      >
        {SECTIONS.map((s, i) => {
          const active = s === section;
          return (
            <button
              key={s}
              ref={(el) => {
                tabs.current[s] = el;
              }}
              id={tabId(s)}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              onClick={() => open(s)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                'flex h-8 flex-none items-center rounded-ctl px-2.5 text-left text-body font-medium leading-[normal] motion-safe:transition-colors motion-safe:duration-120',
                active ? 'bg-bg-hover text-ink-1' : 'text-ink-3 hover:bg-bg-hover hover:text-ink-1',
              )}
            >
              {t(`settings.nav.${s}`)}
            </button>
          );
        })}
      </div>
      {/* Focusable: some sections have no enabled control, and the panel scrolls. */}
      <div
        ref={panelRef}
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(section)}
        tabIndex={0}
        className="min-h-0 overflow-y-auto focus-visible:-outline-offset-2"
      >
        {/* 640px of content plus the 32px side padding (the prototype's content-box max-width: 640px). */}
        <div className="flex max-w-[704px] flex-col gap-5 px-8 py-6">
          <Panel key={section} />
        </div>
      </div>
    </div>
  );
}
