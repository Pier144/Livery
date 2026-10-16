import { Eye, EyeOff, PaintBucket, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import type { Layer } from '@/atelier/project';
import { cn } from '@/lib/cn';
import { MASK_ROW_ID } from './editorModel';

export const PANEL_LABEL = 'font-mono text-mono-label uppercase leading-[normal] text-ink-4';

interface Row {
  id: string;
  kind: Layer['kind'];
  /** The layer, or undefined for the Protected areas row before the first stroke. */
  layer: Layer | undefined;
}

/** A layer's shown name: the user's, else its kind's label. */
export function useLayerName() {
  const { t } = useTranslation();
  return (layer: Pick<Layer, 'kind' | 'name'> | undefined, kind: Layer['kind']): string => {
    if (layer?.name) return layer.name;
    if (kind === 'base') return t('atelier.layers.base');
    if (kind === 'mask') return t('atelier.layers.mask');
    return t('atelier.layers.unsupported');
  };
}

/**
 * The layers, top to bottom: Protected areas (always listed: the first stroke creates the layer),
 * layers this version can't edit, and the Base. Click selects, the eye hides, double-click (or F2)
 * renames.
 */
export function LayersPanel() {
  const { t } = useTranslation();
  const layers = useAtelierEditor((s) => s.layers);
  const selectedId = useAtelierEditor((s) => s.selectedId);
  const select = useAtelierEditor((s) => s.select);
  const toggleVisible = useAtelierEditor((s) => s.toggleLayerVisible);
  const rename = useAtelierEditor((s) => s.renameLayer);
  const nameOf = useLayerName();
  const [editing, setEditing] = useState<string | null>(null);

  const mask = layers.find((l) => l.kind === 'mask');
  const rows: Row[] = [
    mask ? { id: mask.id, kind: 'mask', layer: mask } : { id: MASK_ROW_ID, kind: 'mask', layer: undefined },
    ...layers
      .filter((l) => l.kind === 'unsupported')
      .reverse()
      .map((l) => ({ id: l.id, kind: l.kind, layer: l })),
    ...layers.filter((l) => l.kind === 'base').map((l) => ({ id: l.id, kind: l.kind, layer: l })),
  ];
  const selected = selectedId === MASK_ROW_ID && mask ? mask.id : selectedId;

  return (
    <section aria-labelledby="atelier-layers-title" className="flex flex-col gap-2 px-4 pb-4 pt-4.5">
      <h2 id="atelier-layers-title" className={PANEL_LABEL}>
        {t('atelier.layers.title')}
      </h2>
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => {
          const name = nameOf(row.layer, row.kind);
          const isSelected = row.id === selected;
          const hidden = row.layer !== undefined && !row.layer.visible;
          const Icon = row.kind === 'base' ? PaintBucket : row.kind === 'mask' ? ShieldCheck : TriangleAlert;
          const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'F2' && row.layer) {
              e.preventDefault();
              setEditing(row.id);
            }
          };
          return (
            <li
              key={row.id}
              className={cn(
                'group flex h-[34px] items-center gap-1 rounded-ctl border pl-0.5 pr-1 motion-safe:transition-colors motion-safe:duration-120',
                isSelected ? 'border-line-4 bg-bg-4' : 'border-transparent hover:bg-bg-hover',
              )}
            >
              {editing === row.id && row.layer ? (
                <RenameInput
                  initial={row.layer.name || name}
                  label={t('atelier.layers.renameLabel', { name })}
                  onDone={(next) => {
                    setEditing(null);
                    if (next !== null && row.layer) rename(row.id, next === nameOf(undefined, row.kind) ? '' : next);
                  }}
                />
              ) : (
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => select(row.id)}
                  onDoubleClick={() => row.layer && setEditing(row.id)}
                  onKeyDown={onKeyDown}
                  title={row.layer ? t('atelier.layers.renameHint') : undefined}
                  className={cn(
                    'flex h-full min-w-0 flex-1 items-center gap-2 rounded-ctl px-2 text-left text-body focus-visible:-outline-offset-2',
                    isSelected ? 'text-ink-1' : 'text-ink-2',
                    hidden && 'text-ink-4',
                  )}
                >
                  <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('flex-none', isSelected ? 'text-amber' : 'text-ink-4')} />
                  <span className="min-w-0 truncate">{name}</span>
                </button>
              )}
              <button
                type="button"
                disabled={!row.layer}
                onClick={() => row.layer && toggleVisible(row.id)}
                aria-label={hidden ? t('atelier.layers.show', { name }) : t('atelier.layers.hide', { name })}
                title={hidden ? t('atelier.layers.show', { name }) : t('atelier.layers.hide', { name })}
                className={cn(
                  'grid h-6 w-6 flex-none place-items-center rounded-tag text-ink-4 enabled:hover:text-ink-1 disabled:opacity-0',
                  !hidden && !isSelected && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                )}
              >
                {hidden ? <EyeOff size={14} strokeWidth={1.75} aria-hidden /> : <Eye size={14} strokeWidth={1.75} aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RenameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      // Rename starts on a deliberate double-click or F2: focusing the field is what the user asked for.
      autoFocus
      value={value}
      maxLength={60}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value.trim() || null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(null);
        }
      }}
      className="h-[28px] min-w-0 flex-1 rounded-ctl border border-line-4 bg-bg-input px-2 text-body text-ink-1 outline-none"
    />
  );
}
