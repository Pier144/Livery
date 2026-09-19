import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import geistLicense from '@/assets/fonts/Geist-OFL.txt?raw';
import plexLicense from '@/assets/fonts/IBMPlexMono-OFL.txt?raw';

/** Bundled fonts: their license texts ship next to the woff2 files. */
const FONTS = [
  { name: 'Geist', license: 'SIL OFL 1.1', text: geistLicense },
  { name: 'IBM Plex Mono', license: 'SIL OFL 1.1', text: plexLicense },
] as const;

/** Main open-source libraries (names and SPDX ids aren't translated). */
const LIBRARIES = [
  { name: 'React', license: 'MIT' },
  { name: 'Tauri', license: 'MIT / Apache-2.0' },
  { name: 'TanStack Query · TanStack Virtual', license: 'MIT' },
  { name: 'Zustand', license: 'MIT' },
  { name: 'i18next · react-i18next', license: 'MIT' },
  { name: 'Lucide', license: 'ISC' },
  { name: 'Tailwind CSS', license: 'MIT' },
] as const;

const FOCUSABLE = 'button:not([disabled]), [tabindex="0"]';

function FontLicense({ name, license, text }: { name: string; license: string; text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const textId = useId();
  return (
    <li className="flex flex-col gap-2 rounded-card border border-line-2 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-body leading-[normal] text-ink-1">{name}</span>
        <span className="font-mono text-mono-sm leading-[normal] text-ink-3">{license}</span>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={textId}
        className="self-start text-meta leading-[normal] text-ink-3 underline underline-offset-[3px] hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
      >
        {open ? t('settings.licenses.hideText') : t('settings.licenses.showText')}
      </button>
      {/* Scrollable, so it takes focus (keyboard scrolling); selectable for copying. */}
      <pre
        id={textId}
        hidden={!open}
        tabIndex={open ? 0 : -1}
        aria-label={t('settings.licenses.text', { name })}
        data-selectable
        className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-ctl border border-line-2 bg-bg-2 p-3 font-mono text-mono-sm text-ink-3"
      >
        {text}
      </pre>
    </li>
  );
}

/**
 * Licenses (Settings → About): the bundled fonts with their OFL texts and the main libraries.
 * Modal: focus starts on the dialog, Tab cycles inside, Escape closes only this layer and focus goes
 * back to the opener.
 */
export function LicensesDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const introId = useId();
  const fontsId = useId();
  const librariesId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Read during the first render, before the dialog takes focus.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [opener]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const dialog = dialogRef.current;
      const focusables = Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => !el.closest('[hidden]'));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && !!dialog?.contains(active) && active !== dialog;
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first?.focus();
      }
    }
    // Keys stay in the modal: section shortcuts (1–5, [ ]) must not change the screen underneath.
    // Ctrl/Cmd combos (palette, undo) still reach the window.
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={onOverlayMouseDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[calc(100vh-80px)] w-[560px] max-w-full flex-col overflow-hidden rounded-dialog border border-line-4 bg-bg-3 shadow-dialog outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-2 py-3.5 pl-6 pr-4">
          <h2 id={titleId} className="text-heading-lg text-ink-1">
            {t('settings.licenses.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('settings.licenses.close')}
            title={t('settings.licenses.close')}
            className="grid h-7 w-7 flex-none place-items-center rounded-ctl text-ink-3 hover:bg-bg-hover hover:text-ink-1 motion-safe:transition-colors motion-safe:duration-120"
          >
            <X size={14} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-5">
          <p id={introId} className="text-body text-ink-3">
            {t('settings.licenses.intro')}
          </p>
          <section aria-labelledby={fontsId} className="flex flex-col gap-2">
            <h3 id={fontsId} className="font-mono text-mono-label uppercase text-ink-4">
              {t('settings.licenses.fonts')}
            </h3>
            <ul className="flex flex-col gap-2">
              {FONTS.map((font) => (
                <FontLicense key={font.name} {...font} />
              ))}
            </ul>
          </section>
          <section aria-labelledby={librariesId} className="flex flex-col gap-2">
            <h3 id={librariesId} className="font-mono text-mono-label uppercase text-ink-4">
              {t('settings.licenses.libraries')}
            </h3>
            <ul className="flex flex-col rounded-card border border-line-2">
              {LIBRARIES.map((lib) => (
                <li
                  key={lib.name}
                  className="flex items-baseline justify-between gap-3 border-b border-line-2 px-3.5 py-2.5 last:border-b-0"
                >
                  <span className="text-body leading-[normal] text-ink-1">{lib.name}</span>
                  <span className="font-mono text-mono-sm leading-[normal] text-ink-3">{lib.license}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
