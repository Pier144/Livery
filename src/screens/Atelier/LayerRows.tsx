import {
  ChevronDown,
  ChevronRight,
  Circle,
  Combine,
  Eye,
  EyeOff,
  Folder,
  FolderInput,
  FolderOpen,
  GripVertical,
  Hexagon,
  Image as ImageIcon,
  MoreHorizontal,
  PaintBucket,
  ShieldCheck,
  Square,
  Star,
  Trash2,
  TriangleAlert,
  Type,
  type LucideIcon,
} from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAtelierEditor } from '@/atelier/editorStore';
import { findLayer, type TreeItem } from '@/atelier/layerTree';
import { isPlacedLayer, type Layer } from '@/atelier/project';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { cn } from '@/lib/cn';
import { MASK_ROW_ID } from './editorModel';

/** One row of the Layers panel. */
export interface RowModel {
  id: string;
  kind: TreeItem['kind'];
  /** The item, or undefined for the Protected areas row before the first stroke. */
  item: TreeItem | undefined;
  /** The container: a folder's or merged object's id, null at the top level. */
  parentId: string | null;
  /** Index in the container (bottom to top); -1 for the Protected areas row before the first stroke. */
  index: number;
  /** Nesting: 0 at the top level, 1 in a folder or merged object, 2 for a piece of a merged object in a folder. */
  depth: number;
  /** Has a grip, Alt+↑/↓ and a menu: layers and folders, not the Base, the mask or pieces. */
  movable: boolean;
  /** A piece of a merged object. */
  piece: boolean;
  /** Folders and merged objects: how many items they hold. */
  count: number;
  /** A folder or merged object holding it is hidden. */
  inHidden: boolean;
}

/**
 * The rows top to bottom: Protected areas, the top-level items in stacking order (an open folder's
 * children and an expanded merged object's pieces under it, indented), then the Base.
 */
export function buildRows(layers: readonly Layer[], expanded: ReadonlySet<string>): RowModel[] {
  const mask = layers.find((l) => l.kind === 'mask');
  const rows: RowModel[] = [
    mask
      ? { id: mask.id, kind: 'mask', item: mask, parentId: null, index: layers.indexOf(mask), depth: 0, movable: false, piece: false, count: 0, inHidden: false }
      : { id: MASK_ROW_ID, kind: 'mask', item: undefined, parentId: null, index: -1, depth: 0, movable: false, piece: false, count: 0, inHidden: false },
  ];
  const push = (items: readonly TreeItem[], parentId: string | null, depth: number, inHidden: boolean, inMerged: boolean) => {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (item.kind === 'base' || item.kind === 'mask') continue;
      const container = item.kind === 'folder' || item.kind === 'merged';
      rows.push({ id: item.id, kind: item.kind, item, parentId, index, depth, movable: !inMerged, piece: inMerged, count: container ? item.children.length : 0, inHidden });
      const hidden = inHidden || !item.visible;
      if (item.kind === 'folder' && !item.collapsed) push(item.children, item.id, depth + 1, hidden, false);
      else if (item.kind === 'merged' && expanded.has(item.id)) push(item.children, item.id, depth + 1, hidden, true);
    }
  };
  push(layers, null, 0, false, false);
  layers.forEach((l, index) => {
    if (l.kind === 'base') rows.push({ id: l.id, kind: 'base', item: l, parentId: null, index, depth: 0, movable: false, piece: false, count: 0, inHidden: false });
  });
  return rows;
}

const SHAPE_ICONS: Record<string, LucideIcon> = { rect: Square, ellipse: Circle, star: Star, polygon: Hexagon };

/** A shape kind's icon (an unknown kind is drawn as a rectangle, so it shows one). */
export function shapeIcon(shape: unknown): LucideIcon {
  return (typeof shape === 'string' && SHAPE_ICONS[shape]) || Square;
}

function rowIcon(row: RowModel): LucideIcon {
  switch (row.kind) {
    case 'base':
      return PaintBucket;
    case 'mask':
      return ShieldCheck;
    case 'image':
      return ImageIcon;
    case 'text':
      return Type;
    case 'shape':
      return shapeIcon(row.item && 'shape' in row.item ? row.item.shape : undefined);
    case 'merged':
      return Combine;
    case 'folder':
      return row.item?.kind === 'folder' && !row.item.collapsed ? FolderOpen : Folder;
    default:
      return TriangleAlert;
  }
}

/** Left padding per nesting level (16 px each); a piece, which has no grip, is pushed one more level to line up. */
const INDENT = ['pl-0.5', 'pl-indent-1', 'pl-indent-2', 'pl-indent-3'];

/** The panel's small buttons (Add bar, multi-select bar); callers add their width and padding (`flex-1 px-2`). */
export const BAR_BUTTON =
  'flex h-ctl min-w-0 items-center justify-center gap-1.5 rounded-ctl border border-line-3 bg-bg-4 text-meta font-medium text-ink-1 hover:border-line-4 disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:hover:border-line-3 motion-safe:transition-colors motion-safe:duration-120';

/** Why these items can't go into a new folder together (a folder among them, or already in one), or null. */
export function folderBlockKey(layers: readonly Layer[], ids: readonly string[]): 'atelier.layers.noFolderInFolder' | 'atelier.layers.alreadyInFolder' | null {
  const founds = ids.map((id) => findLayer(layers, id));
  if (founds.some((f) => f?.layer.kind === 'folder')) return 'atelier.layers.noFolderInFolder';
  if (founds.some((f) => f !== null && f.parentId !== null)) return 'atelier.layers.alreadyInFolder';
  return null;
}

/** Where a drag would drop relative to this row. */
export type DropEdge = 'above' | 'below' | 'into';

export interface GripHandlers {
  onPointerDown: (e: PointerEvent<HTMLSpanElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLSpanElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLSpanElement>) => void;
  onPointerCancel: () => void;
}

interface LayerRowProps {
  row: RowModel;
  name: string;
  /** The name a rename back to it clears (the kind's label, or a text layer's text). */
  defaultName: string;
  selected: boolean;
  warning: string | null;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onRename: (name: string) => void;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
  onToggleVisible: () => void;
  /** Folders and merged objects: open or closed, and the chevron's action. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
  menuItems: MenuItem[] | null;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onMenuSelect: (value: string) => void;
  grip: GripHandlers | null;
  /** This row is being dragged. */
  dragging: boolean;
  /** A drag would drop here. */
  drop: DropEdge | null;
}

export function LayerRow({
  row,
  name,
  defaultName,
  selected,
  warning,
  editing,
  onEditingChange,
  onRename,
  onClick,
  onKeyDown,
  onToggleVisible,
  expanded,
  onToggleExpanded,
  menuItems,
  menuOpen,
  onMenuOpenChange,
  onMenuSelect,
  grip,
  dragging,
  drop,
}: LayerRowProps) {
  const { t } = useTranslation();
  const { item } = row;
  const hidden = item !== undefined && !item.visible;
  const Icon = rowIcon(row);
  const container = row.kind === 'folder' || row.kind === 'merged';
  const showCount = row.kind === 'folder' && expanded === false;
  return (
    <li
      data-row={row.id}
      data-parent={row.parentId ?? ''}
      data-index={row.index}
      // Drop targets: layers and folders (pieces and the pinned rows aren't).
      data-drop={row.movable ? (row.kind === 'folder' ? 'folder' : 'layer') : undefined}
      data-open={row.kind === 'folder' ? String(expanded === true) : undefined}
      data-count={row.kind === 'folder' ? row.count : undefined}
      className={cn(
        'group flex h-[34px] items-center gap-1 rounded-ctl border pr-1 motion-safe:transition-colors motion-safe:duration-120',
        INDENT[Math.min(INDENT.length - 1, row.depth + (row.piece ? 1 : 0))],
        selected ? 'border-line-4 bg-bg-4' : 'border-transparent hover:bg-bg-hover',
        drop === 'into' && 'border-amber-60',
        drop === 'above' && 'border-t-amber-60',
        drop === 'below' && 'border-b-amber-60',
        dragging && 'opacity-60',
      )}
    >
      {grip && (
        <span
          aria-hidden
          title={t('atelier.layers.dragHint')}
          className="grid h-6 w-4 flex-none cursor-grab touch-none place-items-center text-ink-5 opacity-0 hover:text-ink-2 group-hover:opacity-100"
          {...grip}
        >
          <GripVertical size={14} strokeWidth={1.75} />
        </span>
      )}
      {container && onToggleExpanded && (
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded === true}
          aria-label={expanded ? t('atelier.layers.collapse', { name }) : t('atelier.layers.expand', { name })}
          title={expanded ? t('atelier.layers.collapse', { name }) : t('atelier.layers.expand', { name })}
          className="grid h-6 w-5 flex-none place-items-center rounded-tag text-ink-4 hover:text-ink-1"
        >
          {expanded ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden /> : <ChevronRight size={14} strokeWidth={1.75} aria-hidden />}
        </button>
      )}
      {editing && item ? (
        <RenameInput
          initial={item.name || name}
          label={t('atelier.layers.renameLabel', { name })}
          onDone={(next) => {
            onEditingChange(false);
            if (next !== null) onRename(next === defaultName ? '' : next);
          }}
        />
      ) : (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onClick}
          onDoubleClick={() => item && onEditingChange(true)}
          onKeyDown={onKeyDown}
          title={item ? t('atelier.layers.renameHint') : undefined}
          aria-describedby={warning ? `atelier-layer-warn-${row.id}` : undefined}
          className={cn(
            'flex h-full min-w-0 flex-1 items-center gap-2 rounded-ctl text-left text-body focus-visible:-outline-offset-2',
            container ? 'px-1' : 'px-2',
            selected ? 'text-ink-1' : 'text-ink-2',
            (hidden || row.inHidden) && 'text-ink-4',
          )}
        >
          <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('flex-none', selected ? 'text-amber' : 'text-ink-4')} />
          <span className="min-w-0 truncate">{name}</span>
          {showCount && (
            <span className="ml-auto flex-none font-mono text-mono-sm text-ink-4" title={t('atelier.layers.itemCount', { count: row.count })}>
              <span aria-hidden>{row.count}</span>
              <span className="sr-only">{t('atelier.layers.itemCount', { count: row.count })}</span>
            </span>
          )}
        </button>
      )}
      {warning && (
        <span id={`atelier-layer-warn-${row.id}`} role="img" aria-label={warning} title={warning} className="grid h-6 w-5 flex-none place-items-center text-amber">
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
        </span>
      )}
      {menuItems && (
        <Menu
          label={t('atelier.layers.actions', { name })}
          align="end"
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          menuWidthClass="min-w-[150px]"
          items={menuItems}
          onSelect={onMenuSelect}
          renderTrigger={(props) => (
            <button
              {...props}
              aria-label={t('atelier.layers.actions', { name })}
              title={t('atelier.layers.actions', { name })}
              className={cn(
                'grid h-6 w-6 flex-none place-items-center rounded-tag text-ink-4 hover:text-ink-1',
                !selected && !menuOpen && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
              )}
            >
              <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        />
      )}
      <button
        type="button"
        disabled={!item}
        onClick={() => item && onToggleVisible()}
        aria-label={hidden ? t('atelier.layers.show', { name }) : t('atelier.layers.hide', { name })}
        title={hidden ? t('atelier.layers.show', { name }) : t('atelier.layers.hide', { name })}
        className={cn(
          'grid h-6 w-6 flex-none place-items-center rounded-tag text-ink-4 enabled:hover:text-ink-1 disabled:opacity-0',
          !hidden && !selected && 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
        )}
      >
        {hidden ? <EyeOff size={14} strokeWidth={1.75} aria-hidden /> : <Eye size={14} strokeWidth={1.75} aria-hidden />}
      </button>
    </li>
  );
}

export function RenameInput({ initial, label, onDone }: { initial: string; label: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      // Rename starts on a deliberate double-click, F2 or a new folder: focusing the field is what the user asked for.
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

/**
 * With two or more layers selected: Merge, Put in folder and Delete. Merge is unavailable with a
 * folder or an unplaced layer in the selection, Put in folder with a folder or layers already in a
 * folder (one level only); the button says why.
 */
export function SelectionBar({ ids, onMerge, onPutInFolder, onDelete }: { ids: string[]; onMerge: () => void; onPutInFolder: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const layers = useAtelierEditor((s) => s.layers);
  const founds = ids.map((id) => findLayer(layers, id));
  const hasFolder = founds.some((f) => f?.layer.kind === 'folder');
  const unplaced = founds.some((f) => !f || !isPlacedLayer(f.layer as Layer) || !('decal' in f.layer) || f.layer.decal === null);
  const mergeBlock = hasFolder ? t('atelier.layers.mergeNoFolders') : unplaced ? t('atelier.layers.mergeUnplaced') : null;
  const folderKey = folderBlockKey(layers, ids);
  const folderBlock = folderKey ? t(folderKey) : null;
  // Icons only: three worded buttons don't fit the 232 px panel in every language. The names are
  // the labels, a reason the button can't act is its title.
  const button = cn(BAR_BUTTON, 'flex-1 px-2');
  return (
    <div role="group" aria-labelledby="atelier-layers-selection" className="flex flex-col gap-1.5 border-t border-line-2 pt-2">
      <p id="atelier-layers-selection" className="text-meta text-ink-3">
        {t('atelier.layers.selected', { count: ids.length })}
      </p>
      <div className="flex gap-1.5">
        {/* aria-disabled keeps the reason reachable: the button stays focusable and shows its title. */}
        <button
          type="button"
          aria-label={t('atelier.layers.merge')}
          aria-disabled={mergeBlock !== null || undefined}
          title={mergeBlock ?? t('atelier.layers.merge')}
          onClick={() => mergeBlock === null && onMerge()}
          className={button}
        >
          <Combine size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={t('atelier.layers.putInFolder')}
          aria-disabled={folderBlock !== null || undefined}
          title={folderBlock ?? t('atelier.layers.putInFolder')}
          onClick={() => folderBlock === null && onPutInFolder()}
          className={button}
        >
          <FolderInput size={14} strokeWidth={1.75} aria-hidden />
        </button>
        <button type="button" aria-label={t('atelier.layers.delete')} title={t('atelier.layers.delete')} onClick={onDelete} className={button}>
          <Trash2 size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}
