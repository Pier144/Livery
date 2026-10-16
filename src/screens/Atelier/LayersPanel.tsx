import { Eye, EyeOff, GripVertical, Image as ImageIcon, MoreHorizontal, PaintBucket, Plus, ShieldCheck, TriangleAlert, Type } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { DEFAULT_FONT, isDecalLayer, type FontRef, type Layer } from '@/atelier/project';
import { fontStatus, measureTextAspect } from '@/atelier/text';
import { Menu } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/errors';
import { baseName } from '@/lib/format';
import { isTauri, toAppError } from '@/lib/tauri';
import { importImage, useFonts } from '@/queries/atelier';
import { toast } from '@/store/toasts';
import type { AssetRef } from '@/types';
import { noteAssetSize, useDecalUi } from './decalUi';
import { MASK_ROW_ID } from './editorModel';

export const PANEL_LABEL = 'font-mono text-mono-label uppercase leading-[normal] text-ink-4';

/** Pictures Add image offers (the backend imports the same). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga'];

interface Row {
  id: string;
  kind: Layer['kind'];
  /** The layer, or undefined for the Protected areas row before the first stroke. */
  layer: Layer | undefined;
  /** Index in the store's `layers` (bottom to top); -1 for the Protected areas row before the first stroke. */
  index: number;
}

/** A layer's shown name: the user's, else its text (text layers), else its kind's label. */
export function useLayerName() {
  const { t } = useTranslation();
  return (layer: Pick<Layer, 'kind' | 'name'> | undefined, kind: Layer['kind']): string => {
    if (layer?.name) return layer.name;
    if (kind === 'base') return t('atelier.layers.base');
    if (kind === 'mask') return t('atelier.layers.mask');
    if (kind === 'image') return t('atelier.layers.image');
    if (kind === 'text') {
      const text = layer && 'text' in layer && typeof layer.text === 'string' ? layer.text.trim() : '';
      return text || t('atelier.layers.text');
    }
    return t('atelier.layers.unsupported');
  };
}

/** The file name without its extension (a new picture layer's name). */
function pictureName(path: string): string {
  return baseName(path).replace(/\.[^.]+$/, '');
}

/** The font a new text layer starts with: Arial when installed, else the first one listed. */
function startFont(fonts: readonly FontRef[] | undefined): FontRef {
  if (!fonts || fonts.length === 0) return DEFAULT_FONT;
  const arial = fonts.find((f) => f.family === DEFAULT_FONT.family && f.style === DEFAULT_FONT.style);
  const regular = fonts.find((f) => f.style === 'Regular');
  const pick = arial ?? regular ?? fonts[0]!;
  return { family: pick.family, style: pick.style };
}

/**
 * Add image and Add text: the new layer waits for its placement click on the model. Add image
 * picks a picture with the system dialog (in the dev mock, a file input: the mock's import
 * makes its own picture from the name), imports it into the project's assets and waits.
 */
function AddButtons() {
  const { t } = useTranslation();
  const projectId = useAtelierEditor((s) => s.project?.id ?? null);
  const fonts = useFonts();
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const startImage = (asset: AssetRef, name: string) => {
    noteAssetSize(asset.id, asset.width, asset.height);
    useAtelierEditor.getState().beginPlacement({ kind: 'image', assetId: asset.id, aspect: asset.width / asset.height, name });
  };

  const importPath = async (path: string) => {
    if (!projectId) return;
    setImporting(true);
    try {
      startImage(await importImage(projectId, path), pictureName(path));
    } catch (e) {
      toast(errorText(toAppError(e), t));
    } finally {
      setImporting(false);
    }
  };

  const addImage = async () => {
    if (!isTauri()) {
      fileRef.current?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ multiple: false, title: t('atelier.layers.addImage'), filters: [{ name: t('atelier.layers.imageFilter'), extensions: IMAGE_EXTENSIONS }] });
      if (typeof picked === 'string') await importPath(picked);
    } catch (e) {
      toast(errorText(toAppError(e), t));
    }
  };

  const addText = () => {
    const text = t('atelier.text.default');
    const font = startFont(fonts.data);
    const aspect = measureTextAspect({ text, font, outlineWidth: 0, skew: 0 }) ?? text.length * 0.6;
    useAtelierEditor.getState().beginPlacement({ kind: 'text', text, font, aspect });
  };

  const button =
    'flex h-ctl min-w-0 flex-1 items-center justify-center gap-1.5 rounded-ctl border border-line-3 bg-bg-4 px-2 text-meta font-medium text-ink-1 hover:border-line-4 disabled:opacity-50 motion-safe:transition-colors motion-safe:duration-120';
  return (
    <div className="flex gap-1.5">
      {/* Short visible labels (the panel is narrow in every language); the names say "Add …". */}
      <button
        type="button"
        onClick={() => void addImage()}
        disabled={!projectId || importing}
        aria-busy={importing || undefined}
        aria-label={t('atelier.layers.addImage')}
        title={t('atelier.layers.addImage')}
        className={button}
      >
        <Plus size={14} strokeWidth={1.75} aria-hidden className="flex-none" />
        <span className="truncate">{t('atelier.layers.image')}</span>
      </button>
      <button type="button" onClick={addText} disabled={!projectId} aria-label={t('atelier.layers.addText')} title={t('atelier.layers.addText')} className={button}>
        <Plus size={14} strokeWidth={1.75} aria-hidden className="flex-none" />
        <span className="truncate">{t('atelier.layers.text')}</span>
      </button>
      {/* The browser has no file paths: `pnpm dev:mock` only (dropped from the production build). */}
      {import.meta.env.VITE_MOCK_BACKEND === '1' && !isTauri() && (
        <input
          ref={fileRef}
          type="file"
          hidden
          tabIndex={-1}
          aria-hidden
          accept={IMAGE_EXTENSIONS.map((e) => `.${e}`).join(',')}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void importPath(`C:/Users/mock/Pictures/${file.name}`);
          }}
        />
      )}
    </div>
  );
}

/**
 * The layers, top to bottom: Protected areas (always listed: the first stroke creates the layer),
 * the image, text and unsupported layers in stacking order, and the Base. Click selects, the eye
 * hides, double-click (or F2) renames; image and text layers have a menu (Duplicate, Delete) and
 * reorder by dragging their grip or with Alt+↑ / Alt+↓ (between the Base and the mask). A
 * picture that can't be read, a missing font or a placement that didn't load shows a warning.
 */
export function LayersPanel() {
  const { t } = useTranslation();
  const layers = useAtelierEditor((s) => s.layers);
  const selectedId = useAtelierEditor((s) => s.selectedId);
  const select = useAtelierEditor((s) => s.select);
  const toggleVisible = useAtelierEditor((s) => s.toggleLayerVisible);
  const rename = useAtelierEditor((s) => s.renameLayer);
  const missingAssets = useDecalUi((s) => s.missingAssets);
  useDecalUi((s) => s.fontsVersion);
  const nameOf = useLayerName();
  const [editing, setEditing] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; over: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const mask = layers.find((l) => l.kind === 'mask');
  const middle = layers.map((l, index) => ({ l, index })).filter(({ l }) => l.kind !== 'base' && l.kind !== 'mask');
  const rows: Row[] = [
    mask ? { id: mask.id, kind: 'mask', layer: mask, index: layers.indexOf(mask) } : { id: MASK_ROW_ID, kind: 'mask', layer: undefined, index: -1 },
    ...middle.reverse().map(({ l, index }) => ({ id: l.id, kind: l.kind, layer: l, index })),
    ...layers.filter((l) => l.kind === 'base').map((l) => ({ id: l.id, kind: l.kind, layer: l, index: layers.indexOf(l) })),
  ];
  const selected = selectedId === MASK_ROW_ID && mask ? mask.id : selectedId;

  const warning = (layer: Layer | undefined): string | null => {
    if (!isDecalLayer(layer)) return null;
    if (layer.decal === null) return t('atelier.layers.notPlaced');
    if (layer.kind === 'image' && missingAssets[layer.assetId]) return t('atelier.layers.missingPicture');
    if (layer.kind === 'text' && fontStatus(layer.font) === 'missing') return t('atelier.layers.missingFont', { font: `${layer.font.family} ${layer.font.style}` });
    return null;
  };

  const deleteWithToast = (layer: Layer) => {
    const store = useAtelierEditor.getState();
    const index = store.layers.findIndex((l) => l.id === layer.id);
    store.deleteLayer(layer.id);
    const revision = useAtelierEditor.getState().revision;
    const name = nameOf(layer, layer.kind);
    toast.undoable(t('atelier.layers.deleted', { name }), () => {
      const now = useAtelierEditor.getState();
      if (now.layers.some((l) => l.id === layer.id)) return;
      // Nothing else changed since: the editor's own undo (redo keeps working); else put it back.
      if (now.revision === revision && now.past.length > 0) now.undo();
      else now.restoreLayer(layer, index);
    });
  };

  /** The store index a dragged row lands at for a pointer at `clientY` (rows are top to bottom). */
  const dropIndex = (clientY: number): number | null => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-layer-index]') ?? []);
    let best: number | null = null;
    let bestDist = Infinity;
    for (const item of items) {
      const rect = item.getBoundingClientRect();
      const d = Math.abs(clientY - (rect.top + rect.height / 2));
      if (d < bestDist) {
        bestDist = d;
        best = Number(item.dataset.layerIndex);
      }
    }
    return best;
  };

  const gripHandlers = (row: Row) => ({
    onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragging({ id: row.id, over: row.index });
    },
    onPointerMove: (e: PointerEvent<HTMLSpanElement>) => {
      if (dragging?.id !== row.id) return;
      const over = dropIndex(e.clientY);
      if (over !== null && over !== dragging.over) setDragging({ id: row.id, over });
    },
    onPointerUp: (e: PointerEvent<HTMLSpanElement>) => {
      if (dragging?.id !== row.id) return;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      if (dragging.over !== row.index) useAtelierEditor.getState().moveLayer(row.id, dragging.over);
      setDragging(null);
    },
    onPointerCancel: () => setDragging(null),
  });

  return (
    <section aria-labelledby="atelier-layers-title" className="flex flex-col gap-2 px-4 pb-4 pt-4.5">
      <h2 id="atelier-layers-title" className={PANEL_LABEL}>
        {t('atelier.layers.title')}
      </h2>
      <AddButtons />
      <ul ref={listRef} className="flex flex-col gap-0.5" aria-describedby={middle.length > 1 ? 'atelier-layers-hint' : undefined}>
        {rows.map((row) => {
          const name = nameOf(row.layer, row.kind);
          const isSelected = row.id === selected;
          const hidden = row.layer !== undefined && !row.layer.visible;
          const movable = row.layer !== undefined && row.kind !== 'base' && row.kind !== 'mask';
          const warn = warning(row.layer);
          const Icon =
            row.kind === 'base' ? PaintBucket : row.kind === 'mask' ? ShieldCheck : row.kind === 'image' ? ImageIcon : row.kind === 'text' ? Type : TriangleAlert;
          const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'F2' && row.layer) {
              e.preventDefault();
              setEditing(row.id);
            } else if (movable && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              // Up the list is up the stack.
              useAtelierEditor.getState().moveLayer(row.id, row.index + (e.key === 'ArrowUp' ? 1 : -1));
            }
          };
          const dropTarget = dragging !== null && dragging.id !== row.id && dragging.over === row.index;
          return (
            <li
              key={row.id}
              data-layer-index={movable ? row.index : undefined}
              className={cn(
                'group flex h-[34px] items-center gap-1 rounded-ctl border pl-0.5 pr-1 motion-safe:transition-colors motion-safe:duration-120',
                isSelected ? 'border-line-4 bg-bg-4' : 'border-transparent hover:bg-bg-hover',
                dropTarget && 'border-amber-60',
                dragging?.id === row.id && 'opacity-60',
              )}
            >
              {movable && (
                <span
                  aria-hidden
                  title={t('atelier.layers.dragHint')}
                  className="grid h-6 w-4 flex-none cursor-grab touch-none place-items-center text-ink-5 opacity-0 hover:text-ink-2 group-hover:opacity-100"
                  {...gripHandlers(row)}
                >
                  <GripVertical size={14} strokeWidth={1.75} />
                </span>
              )}
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
                  aria-describedby={warn ? `atelier-layer-warn-${row.id}` : undefined}
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
              {warn && (
                <span id={`atelier-layer-warn-${row.id}`} role="img" aria-label={warn} title={warn} className="grid h-6 w-5 flex-none place-items-center text-amber">
                  <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
                </span>
              )}
              {movable && row.layer && (
                <Menu
                  label={t('atelier.layers.actions', { name })}
                  align="end"
                  open={menuOpen === row.id}
                  onOpenChange={(open) => setMenuOpen(open ? row.id : null)}
                  menuWidthClass="min-w-[150px]"
                  items={[
                    ...(isDecalLayer(row.layer) ? [{ value: 'duplicate', label: t('atelier.layers.duplicate') }] : []),
                    { value: 'delete', label: t('atelier.layers.delete') },
                  ]}
                  onSelect={(action) => {
                    const layer = row.layer;
                    if (!layer) return;
                    if (action === 'duplicate') useAtelierEditor.getState().duplicateLayer(layer.id);
                    else if (action === 'delete') deleteWithToast(layer);
                  }}
                  renderTrigger={(props) => (
                    <button
                      {...props}
                      aria-label={t('atelier.layers.actions', { name })}
                      title={t('atelier.layers.actions', { name })}
                      className={cn(
                        'grid h-6 w-6 flex-none place-items-center rounded-tag text-ink-4 hover:text-ink-1',
                        !isSelected && menuOpen !== row.id && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                      )}
                    >
                      <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
                    </button>
                  )}
                />
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
      {middle.length > 1 && (
        <p id="atelier-layers-hint" className="text-meta text-ink-4">
          {t('atelier.layers.reorderHint')}
        </p>
      )}
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
