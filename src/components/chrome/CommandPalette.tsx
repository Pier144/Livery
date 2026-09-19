import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Kbd } from '@/components/ui/Kbd';
import { vehicles } from '@/data/vehicles';
import { focusScreenHeading } from '@/hooks/useScreenFocus';
import { cn } from '@/lib/cn';
import { cachedWtLiveSkins } from '@/screens/Explore/exploreModel';
import { useExplore } from '@/store/explore';
import { useUi } from '@/store/ui';
import { buildPaletteItems, type PaletteActionKey, type PaletteItem } from './paletteItems';

/** Ctrl+K command palette. Open/close state lives in the UI store. */
export function CommandPalette() {
  const open = useUi((s) => s.palette.open);
  return open ? <PalettePanel /> : null;
}

function PalettePanel() {
  const { t } = useTranslation();
  const query = useUi((s) => s.palette.query);
  const index = useUi((s) => s.palette.index);
  const go = useUi((s) => s.go);
  const openSkin = useUi((s) => s.openSkin);
  const applyVehicle = useExplore((s) => s.applyVehicle);
  const closePalette = useUi((s) => s.closePalette);
  const setPaletteQuery = useUi((s) => s.setPaletteQuery);
  const setPaletteIndex = useUi((s) => s.setPaletteIndex);

  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  // Read during the first render, before the input takes focus.
  const [opener] = useState(() => document.activeElement);
  // Set when the chosen result opened another screen or skin: focus goes to its heading instead.
  const navigated = useRef(false);
  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (navigated.current) return;
      if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
      else focusScreenHeading();
    };
  }, [opener]);

  const translate = useCallback((key: PaletteActionKey) => t(key), [t]);
  // WT Live skins already fetched (Explore pages, posts, Following), read once per opening.
  const qc = useQueryClient();
  const [skins] = useState(() => cachedWtLiveSkins(qc));
  const items = useMemo(
    () => buildPaletteItems(query, { t: translate, vehicles, skins, go, openSkin, applyVehicle }),
    [query, translate, skins, go, openSkin, applyVehicle],
  );
  const active = Math.min(index, Math.max(0, items.length - 1));
  const activeItem = items[active];

  const runItem = (item: PaletteItem) => {
    const before = useUi.getState();
    try {
      item.run();
    } finally {
      const after = useUi.getState();
      // A new screen (or another skin): its heading takes focus once it has rendered (useScreenFocus).
      if (after.screen !== before.screen || after.detailSkinId !== before.detailSkinId) {
        navigated.current = true;
        after.focusHeading();
      }
      closePalette();
    }
  };

  // Focus never leaves the input: rows are not tab stops and clicks inside the panel keep the caret.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setPaletteIndex(Math.max(0, Math.min(active + 1, items.length - 1)));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setPaletteIndex(Math.max(active - 1, 0));
        break;
      case 'Enter':
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        if (activeItem) runItem(activeItem);
        break;
      case 'Escape':
        // Close only the palette, not transients underneath it.
        e.preventDefault();
        e.stopPropagation();
        closePalette();
        break;
      case 'Tab':
        e.preventDefault();
        inputRef.current?.focus();
        break;
    }
  };

  const onOverlayMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) closePalette();
  };
  const onPanelMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== inputRef.current) e.preventDefault();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-overlay pt-[120px]" onMouseDown={onOverlayMouseDown}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('common.palette.label')}
        onKeyDown={onKeyDown}
        onMouseDown={onPanelMouseDown}
        className="flex w-[560px] flex-col self-start overflow-hidden rounded-dialog border border-line-4 bg-bg-3 shadow-dialog"
      >
        <div className="flex items-center gap-2.5 border-b border-line-2 px-3.5">
          <span aria-hidden className="font-mono text-[12px] leading-[normal] text-amber">
            &gt;
          </span>
          {/* No outline: inside this modal the caret and the highlighted row are the focus indicator. */}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label={t('common.palette.input')}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={activeItem ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setPaletteQuery(e.target.value)}
            placeholder={t('common.palette.placeholder')}
            className="h-[46px] min-w-0 flex-1 border-0 bg-transparent font-sans text-[14px] text-ink-1 outline-none placeholder:text-ink-4"
          />
          <Kbd tone="ink4">{t('common.palette.esc')}</Kbd>
        </div>
        <div className="flex flex-col p-1.5">
          <div id={listboxId} role="listbox" aria-label={t('common.palette.results')} className="flex flex-col">
            {items.map((item, i) => {
              const highlighted = i === active;
              return (
                <div
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={highlighted}
                  onClick={() => runItem(item)}
                  onMouseMove={() => {
                    if (!highlighted) setPaletteIndex(i);
                  }}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-ctl px-2.5 py-[9px] leading-[normal] hover:bg-bg-hover',
                    highlighted && 'bg-bg-hover',
                  )}
                >
                  {/* The kind tells results apart, so it needs 4.5:1: ink-4 on bg-3, ink-3 on the highlighted bg-hover (docs/a11y.md). */}
                  <span className={cn('min-w-[56px] font-mono text-[10px] tracking-[.06em]', highlighted ? 'text-ink-3' : 'text-ink-4')}>
                    {t(`common.palette.kind.${item.kind}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-1">{item.label}</span>
                  <span
                    className={cn(
                      'flex-none font-mono text-[11px]',
                      item.kind === 'vehicle' || highlighted ? 'text-ink-3' : 'text-ink-4',
                    )}
                  >
                    {item.hint}
                  </span>
                </div>
              );
            })}
          </div>
          <div role="status">
            {items.length === 0 && (
              <div className="p-4 text-center text-[12px] leading-[normal] text-ink-4">{t('common.palette.empty')}</div>
            )}
          </div>
        </div>
        {/* ink-4, not ink-5: 10px text needs 4.5:1 on bg-3 (docs/a11y.md). */}
        <div className="flex gap-3.5 border-t border-line-2 px-3.5 py-2 font-mono text-[10px] leading-[normal] text-ink-4">
          <span>{t('common.palette.hintNavigate')}</span>
          <span>{t('common.palette.hintOpen')}</span>
          <span>{t('common.palette.hintClose')}</span>
        </div>
      </div>
    </div>
  );
}
