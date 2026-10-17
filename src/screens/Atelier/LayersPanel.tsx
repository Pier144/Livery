import { FolderPlus, TriangleAlert } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { findLayer, type TreeItem } from '@/atelier/layerTree';
import { isPlacedLayer, type Layer } from '@/atelier/project';
import { fontStatus } from '@/atelier/text';
import type { MenuItem } from '@/components/ui/Menu';
import { AddButtons } from './AddButtons';
import { useDecalUi } from './decalUi';
import { MASK_ROW_ID } from './editorModel';
import { LayerRow, SelectionBar, buildRows, type DropEdge, type GripHandlers, type RowModel } from './LayerRows';
import { useSelectionActions } from './selectionActions';

export const PANEL_LABEL = 'font-mono text-mono-label uppercase leading-[normal] text-ink-4';

/** What a layer's name is read from: any item of the tree (shapes add their kind, text layers their text). */
type Named = Pick<TreeItem, 'kind' | 'name'>;

/**
 * A layer's shown name: the user's, else its text (text layers), else its kind's label (shapes:
 * the shape's; folders "Folder", merged objects "Merged object").
 */
export function useLayerName() {
  const { t } = useTranslation();
  return (layer: Named | undefined, kind: TreeItem['kind']): string => {
    if (layer?.name) return layer.name;
    switch (kind) {
      case 'base':
        return t('atelier.layers.base');
      case 'mask':
        return t('atelier.layers.mask');
      case 'image':
        return t('atelier.layers.image');
      case 'text': {
        const text = layer && 'text' in layer && typeof layer.text === 'string' ? layer.text.trim() : '';
        return text || t('atelier.layers.text');
      }
      case 'shape': {
        const shape = layer && 'shape' in layer ? layer.shape : undefined;
        if (shape === 'rect') return t('atelier.shape.rect');
        if (shape === 'ellipse') return t('atelier.shape.ellipse');
        if (shape === 'star') return t('atelier.shape.star');
        if (shape === 'polygon') return t('atelier.shape.polygon');
        return t('atelier.layers.shape');
      }
      case 'folder':
        return t('atelier.layers.folder');
      case 'merged':
        return t('atelier.layers.merged');
      default:
        return t('atelier.layers.unsupported');
    }
  };
}

/**
 * Where a dragged row would land: the row it was dropped on, the row the marker shows on (under an
 * expanded group: its last visible row), and the container and index for `moveInto`.
 */
interface Drop {
  rowId: string;
  markerId: string;
  edge: DropEdge;
  parentId: string | null;
  index: number;
}

/**
 * The layers, top to bottom: Protected areas (always listed: the first stroke creates the layer),
 * the top-level items in stacking order (folders with their children, merged objects with their
 * pieces when expanded) and the Base. Click selects (Ctrl adds or removes, Shift selects a range,
 * in one container), the eye hides, double-click (or F2) renames; layers and folders have a menu
 * and reorder by dragging their grip (onto a folder row: into it) or with Alt+↑ / Alt+↓ within
 * their container. With several layers selected a bar offers Merge, Put in folder and Delete. A
 * picture that can't be read, a missing font or a placement that didn't load shows a warning.
 */
export function LayersPanel() {
  const { t } = useTranslation();
  const layers = useAtelierEditor((s) => s.layers);
  const selectedId = useAtelierEditor((s) => s.selectedId);
  const selectedIds = useAtelierEditor((s) => s.selectedIds);
  const toggleVisible = useAtelierEditor((s) => s.toggleLayerVisible);
  const rename = useAtelierEditor((s) => s.renameLayer);
  const missingAssets = useDecalUi((s) => s.missingAssets);
  const truncated = useDecalUi((s) => s.drawTruncated);
  useDecalUi((s) => s.fontsVersion);
  const nameOf = useLayerName();
  const actions = useSelectionActions();
  const [editing, setEditing] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dragging, setDragging] = useState<{ id: string; drop: Drop | null } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const rows = buildRows(layers, expanded);
  const mask = layers.find((l) => l.kind === 'mask');
  const selected = selectedId === MASK_ROW_ID && mask ? mask.id : selectedId;
  const multi = selectedIds.length >= 2;
  const movableCount = rows.filter((r) => r.movable).length;
  const folders = layers.filter((l) => l.kind === 'folder');

  const warning = (item: TreeItem | undefined): string | null => {
    if (!item) return null;
    if (isPlacedLayer(item as Layer) && 'decal' in item && item.decal === null) return t('atelier.layers.notPlaced');
    if (item.kind === 'image' && missingAssets[item.assetId]) return t('atelier.layers.missingPicture');
    if (item.kind === 'text' && fontStatus(item.font) === 'missing') return t('atelier.layers.missingFont', { font: `${item.font.family} ${item.font.style}` });
    return null;
  };

  /** A new folder, renamed right away; with `ids`, holding them (refused with the reason when they can't go in). */
  const newFolder = (ids?: string[]) => {
    const id = actions.putInFolder(ids);
    if (id) setEditing(id);
  };

  const menuFor = (row: RowModel): MenuItem[] | null => {
    const { item } = row;
    if (!row.movable || !item) return null;
    if (item.kind === 'folder') {
      return [
        { value: 'rename', label: t('atelier.layers.rename') },
        { value: 'dissolve', label: t('atelier.layers.dissolve') },
        { value: 'delete-folder', label: t('atelier.layers.deleteFolder') },
      ];
    }
    const items: MenuItem[] = [];
    if (isPlacedLayer(item as Layer)) items.push({ value: 'duplicate', label: t('atelier.layers.duplicate') });
    if (item.kind === 'merged') items.push({ value: 'separate', label: t('atelier.layers.separate') });
    for (const folder of folders) {
      if (folder.id !== row.parentId) items.push({ value: `into:${folder.id}`, label: t('atelier.layers.putIn', { name: nameOf(folder, 'folder') }) });
    }
    if (row.parentId !== null) items.push({ value: 'out', label: t('atelier.layers.moveOut') });
    else if (isPlacedLayer(item as Layer)) items.push({ value: 'into-new', label: t('atelier.layers.putInNew') });
    items.push({ value: 'delete', label: t('atelier.layers.delete') });
    return items;
  };

  const onMenuSelect = (row: RowModel, name: string, action: string) => {
    const store = useAtelierEditor.getState();
    if (action === 'duplicate') store.duplicateLayer(row.id);
    else if (action === 'separate') actions.separate(row.id);
    else if (action === 'delete') actions.deleteOne(row.id, name);
    else if (action === 'rename') setEditing(row.id);
    else if (action === 'dissolve') store.dissolveFolder(row.id);
    else if (action === 'delete-folder') actions.deleteFolder(row.id, name);
    else if (action === 'into-new') newFolder([row.id]);
    else if (action === 'out' && row.parentId !== null) {
      // Right above its folder.
      const folder = findLayer(store.layers, row.parentId);
      if (folder) store.moveInto(row.id, null, folder.index + 1);
    } else if (action.startsWith('into:')) {
      const folderId = action.slice('into:'.length);
      const folder = findLayer(store.layers, folderId)?.layer;
      // At the top of the folder.
      if (folder?.kind === 'folder') store.moveInto(row.id, folderId, folder.children.length);
    }
  };

  /** Where a row dragged to `clientY` lands: on a folder's middle, into it; else between rows, in that row's container. */
  const dropAt = (clientY: number, dragged: RowModel): Drop | null => {
    const draggingFolder = dragged.kind === 'folder';
    let best: { el: HTMLElement; rect: DOMRect; dist: number } | null = null;
    for (const el of listRef.current?.querySelectorAll<HTMLElement>('[data-drop]') ?? []) {
      const parent = el.dataset.parent ?? '';
      // A folder only lands at the top level, and never among its own children.
      if (draggingFolder && parent !== '') continue;
      if (parent === dragged.id) continue;
      const rect = el.getBoundingClientRect();
      const dist = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (!best || dist < best.dist) best = { el, rect, dist };
    }
    if (!best) return null;
    const { el, rect } = best;
    const rowId = el.dataset.row ?? '';
    const parentId = el.dataset.parent || null;
    const index = Number(el.dataset.index);
    const isFolder = el.dataset.drop === 'folder';
    const count = Number(el.dataset.count ?? 0);
    const at = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
    const drop = (edge: DropEdge, parent: string | null, i: number, markerId = rowId): Drop => ({ rowId, markerId, edge, parentId: parent, index: i });
    if (isFolder && !draggingFolder && at > 0.25 && at < 0.75) return drop('into', rowId, count);
    // Rows are top to bottom, the stack bottom to top: above a row is one index higher.
    if (at < 0.5) return drop('above', parentId, index + 1);
    // Under an open folder's row is the top of its children.
    if (isFolder && !draggingFolder && el.dataset.open === 'true' && count > 0) return drop('below', rowId, count);
    // Under the whole group otherwise: the marker goes on its last visible row.
    return drop('below', parentId, index, lastRowOf(rowId));
  };

  /** The last row shown for this row's group (an open folder's last child, an expanded merged object's last piece), else the row. */
  const lastRowOf = (id: string): string => {
    const start = rows.findIndex((r) => r.id === id);
    if (start < 0) return id;
    let end = start;
    while (rows[end + 1] && rows[end + 1]!.depth > rows[start]!.depth) end++;
    return rows[end]!.id;
  };

  const gripHandlers = (row: RowModel): GripHandlers => ({
    onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture?.(e.pointerId);
      setDragging({ id: row.id, drop: null });
    },
    onPointerMove: (e: PointerEvent<HTMLSpanElement>) => {
      if (dragging?.id !== row.id) return;
      const drop = dropAt(e.clientY, row);
      const was = dragging.drop;
      const same = drop && was && drop.markerId === was.markerId && drop.edge === was.edge && drop.parentId === was.parentId && drop.index === was.index;
      if (!same) setDragging({ id: row.id, drop });
    },
    onPointerUp: (e: PointerEvent<HTMLSpanElement>) => {
      if (dragging?.id !== row.id) return;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      const { drop } = dragging;
      setDragging(null);
      // `moveInto` takes the index in the target's terms before the move, within a container too.
      if (drop && drop.rowId !== row.id) useAtelierEditor.getState().moveInto(row.id, drop.parentId, drop.index);
    },
    onPointerCancel: () => setDragging(null),
  });

  const onRowClick = (row: RowModel, e: MouseEvent<HTMLButtonElement>) => {
    const store = useAtelierEditor.getState();
    if (!row.piece && (e.ctrlKey || e.metaKey)) store.toggleSelect(row.id);
    else if (!row.piece && e.shiftKey) store.selectRange(row.id);
    else store.select(row.id);
  };

  const toggleExpanded = (row: RowModel) => {
    if (row.kind === 'folder') {
      useAtelierEditor.getState().toggleCollapsed(row.id);
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  };

  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Escape in the panel goes back to a single selection (a waiting placement keeps its own Escape).
    if (e.key !== 'Escape' || !multi || useAtelierEditor.getState().pending) return;
    e.preventDefault();
    e.stopPropagation();
    useAtelierEditor.getState().select(selectedId);
  };

  return (
    <section aria-labelledby="atelier-layers-title" onKeyDown={onPanelKeyDown} className="flex flex-col gap-2 px-4 pb-4 pt-4.5">
      <div className="flex h-5 items-center justify-between gap-2">
        <h2 id="atelier-layers-title" className={PANEL_LABEL}>
          {t('atelier.layers.title')}
        </h2>
        <button
          type="button"
          onClick={() => newFolder(multi ? selectedIds : undefined)}
          disabled={layers.length === 0}
          aria-label={t('atelier.layers.newFolder')}
          title={t('atelier.layers.newFolder')}
          className="-mr-1 grid h-6 w-6 flex-none place-items-center rounded-tag text-ink-4 enabled:hover:text-ink-1 disabled:opacity-50"
        >
          <FolderPlus size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <AddButtons />
      <ul ref={listRef} className="flex flex-col gap-0.5" aria-describedby={movableCount > 1 ? 'atelier-layers-hint' : undefined}>
        {rows.map((row) => {
          const { item } = row;
          const name = nameOf(item, row.kind);
          const defaultName = nameOf(item ? { ...item, name: '' } : undefined, row.kind);
          const isSelected = row.id === selected || selectedIds.includes(row.id);
          const container = row.kind === 'folder' || row.kind === 'merged';
          const open = row.kind === 'folder' ? item?.kind === 'folder' && !item.collapsed : expanded.has(row.id);
          const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'F2' && item) {
              e.preventDefault();
              setEditing(row.id);
            } else if (row.movable && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              e.preventDefault();
              // Up the list is up the stack (within the row's container).
              useAtelierEditor.getState().moveLayer(row.id, row.index + (e.key === 'ArrowUp' ? 1 : -1));
            }
          };
          return (
            <LayerRow
              key={row.id}
              row={row}
              name={name}
              defaultName={defaultName}
              selected={isSelected}
              warning={warning(item)}
              editing={editing === row.id}
              onEditingChange={(on) => setEditing(on ? row.id : null)}
              onRename={(next) => rename(row.id, next)}
              onClick={(e) => onRowClick(row, e)}
              onKeyDown={onKeyDown}
              onToggleVisible={() => toggleVisible(row.id)}
              expanded={container ? open : undefined}
              onToggleExpanded={container ? () => toggleExpanded(row) : undefined}
              menuItems={menuFor(row)}
              menuOpen={menuOpen === row.id}
              onMenuOpenChange={(on) => setMenuOpen(on ? row.id : null)}
              onMenuSelect={(action) => onMenuSelect(row, name, action)}
              grip={row.movable ? gripHandlers(row) : null}
              dragging={dragging?.id === row.id}
              drop={dragging && dragging.id !== row.id && dragging.drop?.markerId === row.id ? dragging.drop.edge : null}
            />
          );
        })}
      </ul>
      {truncated && (
        <p role="status" className="flex items-start gap-1.5 text-meta text-amber">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-px flex-none" />
          {t('atelier.layers.truncated')}
        </p>
      )}
      {multi && <SelectionBar ids={selectedIds} onMerge={() => actions.merge(selectedIds)} onPutInFolder={() => newFolder(selectedIds)} onDelete={() => actions.deleteMany(selectedIds)} />}
      {movableCount > 1 && (
        <p id="atelier-layers-hint" className="text-meta text-ink-4">
          {t('atelier.layers.reorderHint')}
        </p>
      )}
    </section>
  );
}
