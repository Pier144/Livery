import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAtelierEditor } from '@/atelier/editorStore';
import { findLayer } from '@/atelier/layerTree';
import { HAZARD_ASPECT, newBaseLayer, newFolder, newImageLayer, newShapeLayer, type Decal, type FolderLayer, type ImageLayer, type Layer, type MergedLayer } from '@/atelier/project';
import { useToasts } from '@/store/toasts';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AtelierProject } from '@/types';
import { resetDecalUi } from './decalUi';
import { LayersPanel } from './LayersPanel';

const S = () => useAtelierEditor.getState();
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);

/** A decal on the +x side (or facing `normal`), centred at (0.5, y, z). */
const at = (y: number, z: number, normal: Decal['normal'] = [1, 0, 0]): Decal => ({
  center: [0.5, y, z],
  normal,
  up: [0, 1, 0],
  width: 0.2,
  height: 0.1,
  depth: 0.04,
  part: 'all',
  mirror: false,
});

const image = (id: string, name: string, decal: Decal | null): ImageLayer => ({ ...newImageLayer(`asset-${id}`, decal, name), id });

function load(layers: Layer[]) {
  const project: AtelierProject = {
    version: 1,
    id: 'p1',
    name: 'Desert',
    vehicle: 'germ_pzkpfw_VI_ausf_b_tiger_IIH',
    createdAt: '2026-10-17T09:00:00Z',
    updatedAt: '2026-10-17T09:00:00Z',
    slots: [],
    output: { highQuality: false },
    layers,
  };
  act(() => S().load(project));
}

const base = (): Layer => ({ ...newBaseLayer(), id: 'b' });
const folder = (children: ImageLayer[] = [image('c', 'child', at(0.6, 0.2))]): FolderLayer => ({ ...newFolder('Folder 1', children), id: 'f' });

const panel = () => within(screen.getByRole('region', { name: 'Layers' }));

describe('Atelier Layers panel', () => {
  beforeEach(() => {
    resetStores();
    resetDecalUi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Add shape starts a shape placement; Hazard stripe sets the preset and its aspect', async () => {
    const user = userEvent.setup();
    load([base()]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'Add shape' }));
    await user.click(screen.getByRole('menuitem', { name: 'Star' }));
    expect(S().pending).toEqual({ kind: 'shape', shape: 'star', aspect: 1 });
    await user.click(panel().getByRole('button', { name: 'Add shape' }));
    await user.click(screen.getByRole('menuitem', { name: 'Hazard stripe' }));
    expect(S().pending).toEqual({ kind: 'shape', shape: 'rect', hazard: true, name: 'Hazard stripe', aspect: HAZARD_ASPECT });
  });

  it('New folder creates "Folder N" and starts renaming it', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5))]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'New folder' }));
    const made = S().layers.find((l) => l.kind === 'folder');
    expect(made).toMatchObject({ kind: 'folder', name: 'Folder 1', children: [] });
    const input = panel().getByRole('textbox', { name: 'New name for Folder 1' });
    expect(input).toHaveFocus();
    await user.keyboard('Decals{Enter}');
    expect(S().layers.find((l) => l.kind === 'folder')?.name).toBe('Decals');
    // The next one takes the first free number: "Folder 1" is free again after the rename.
    await user.click(panel().getByRole('button', { name: 'New folder' }));
    expect(panel().getByRole('textbox', { name: 'New name for Folder 1' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await user.click(panel().getByRole('button', { name: 'New folder' }));
    expect(panel().getByRole('textbox', { name: 'New name for Folder 2' })).toBeInTheDocument();
  });

  it('collapsing a folder hides its children and shows how many it holds; the eye hides the whole folder', async () => {
    const user = userEvent.setup();
    load([base(), folder()]);
    renderWithProviders(<LayersPanel />);
    expect(panel().getByRole('button', { name: 'child' })).toBeInTheDocument();
    const chevron = panel().getByRole('button', { name: 'Collapse Folder 1' });
    expect(chevron).toHaveAttribute('aria-expanded', 'true');
    await user.click(chevron);
    expect(panel().queryByRole('button', { name: 'child' })).toBeNull();
    expect(panel().getByRole('button', { name: 'Expand Folder 1' })).toHaveAttribute('aria-expanded', 'false');
    expect(panel().getByText('1 item')).toBeInTheDocument();
    // Collapse is saved but isn't an undo step.
    expect((S().layers[1] as FolderLayer).collapsed).toBe(true);
    expect(S().past).toHaveLength(0);
    await user.click(panel().getByRole('button', { name: 'Hide Folder 1' }));
    expect(S().layers[1]!.visible).toBe(false);
    expect(panel().getByRole('button', { name: 'Show Folder 1' })).toBeInTheDocument();
  });

  it('Ctrl+click selects two rows and shows the multi-select bar; Merge makes a merged object', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1))]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'logo' }));
    await user.keyboard('{Control>}');
    await user.click(panel().getByRole('button', { name: 'badge' }));
    await user.keyboard('{/Control}');
    expect(S().selectedIds).toEqual(['a', 'd']);
    expect(panel().getByRole('button', { name: 'logo', pressed: true })).toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'badge', pressed: true })).toBeInTheDocument();
    const bar = within(panel().getByRole('group', { name: '2 layers selected' }));
    await user.click(bar.getByRole('button', { name: 'Merge' }));
    expect(S().layers.map((l) => l.kind)).toEqual(['base', 'merged']);
    expect(toastTexts()).toContain('Merged 2 layers');
    expect(panel().getByRole('button', { name: 'Merged object', pressed: true })).toBeInTheDocument();
    expect(panel().queryByRole('group', { name: /selected/ })).toBeNull();
    // Its pieces show when expanded, selectable but without a menu.
    await user.click(panel().getByRole('button', { name: 'Expand Merged object' }));
    await user.click(panel().getByRole('button', { name: 'logo' }));
    expect(S().selectedId).toBe('a');
    expect(panel().queryByRole('button', { name: 'logo actions' })).toBeNull();
  });

  it('a merge of layers facing opposite ways is refused with the reason', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.5, [-1, 0, 0]))]);
    renderWithProviders(<LayersPanel />);
    act(() => {
      S().select('a');
      S().toggleSelect('d');
    });
    await user.click(panel().getByRole('button', { name: 'Merge' }));
    expect(toastTexts()).toContain('These layers face too differently to become one object');
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'a', 'd']);
  });

  it('Merge is unavailable with a folder or an unplaced layer selected, and says why', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', null), image('d', 'badge', at(0.3, 0.1)), folder()]);
    renderWithProviders(<LayersPanel />);
    act(() => {
      S().select('a');
      S().toggleSelect('d');
    });
    const merge = panel().getByRole('button', { name: 'Merge' });
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    expect(merge).toHaveAttribute('title', 'Place every selected layer on the vehicle first');
    await user.click(merge);
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'a', 'd', 'f']);
    act(() => S().toggleSelect('f'));
    expect(panel().getByRole('button', { name: 'Put in folder' })).toHaveAttribute('title', 'A folder can’t go inside another folder');
  });

  it('Separate from the merged row’s menu gives the layers back and says when the repeat went', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1))]);
    renderWithProviders(<LayersPanel />);
    let id = '';
    act(() => {
      const result = S().mergeLayers(['a', 'd']);
      if (result.ok) id = result.id;
      S().setLayerProps(id, { repeat: { count: 3, gap: 0.5, direction: 'row' } });
    });
    await user.click(panel().getByRole('button', { name: 'Merged object actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Separate' }));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'a', 'd']);
    expect(toastTexts()).toContain('Separated. The repeat was removed');
  });

  it('Delete folder and content shows an undo toast; Undo brings the folder back', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), folder()]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'Folder 1 actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder and content' }));
    expect(findLayer(S().layers, 'f')).toBeNull();
    expect(findLayer(S().layers, 'c')).toBeNull();
    const shown = useToasts.getState().toasts.find((t) => t.message === 'Deleted folder “Folder 1”');
    expect(shown?.onUndo).toBeDefined();
    // Another edit came after: Undo puts the folder back with its content instead of undoing that edit.
    act(() => S().renameLayer('a', 'renamed'));
    await act(() => useToasts.getState().undo(shown!.id));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'a', 'f']);
    expect(findLayer(S().layers, 'c')?.parentId).toBe('f');
    expect((S().layers[1] as ImageLayer).name).toBe('renamed');
  });

  it('multi-select Delete removes every selected layer, Undo restores them', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1))]);
    renderWithProviders(<LayersPanel />);
    act(() => {
      S().select('a');
      S().toggleSelect('d');
    });
    await user.click(within(panel().getByRole('group', { name: '2 layers selected' })).getByRole('button', { name: 'Delete' }));
    expect(S().layers.map((l) => l.id)).toEqual(['b']);
    const shown = useToasts.getState().toasts.find((t) => t.message === 'Deleted 2 layers');
    await act(() => useToasts.getState().undo(shown!.id));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'a', 'd']);
  });

  it('row menus move a layer into a folder and out again', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), folder()]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'logo actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Put in Folder 1' }));
    // At the top of the folder.
    expect((findLayer(S().layers, 'f')!.layer as FolderLayer).children.map((c) => c.id)).toEqual(['c', 'a']);
    await user.click(panel().getByRole('button', { name: 'logo actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move out of folder' }));
    // Right above the folder.
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'f', 'a']);
  });

  /** Rows 34 px tall, top to bottom in list order; the rows' ids. */
  function mockRows(): string[] {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const items = Array.from(this.parentElement?.children ?? []);
      const i = Math.max(0, items.indexOf(this));
      return { top: i * 34, bottom: i * 34 + 34, height: 34, left: 0, right: 200, width: 200, x: 0, y: i * 34, toJSON: () => ({}) } as DOMRect;
    });
    return Array.from(document.querySelectorAll<HTMLElement>('li[data-row]')).map((r) => r.dataset.row!);
  }

  const rowEl = (id: string) => document.querySelector<HTMLElement>(`li[data-row="${id}"]`)!;

  /** Drags the row's grip to `clientY`; `during` runs before the drop (the marker is showing). */
  function drag(id: string, clientY: number, during?: () => void) {
    const grip = rowEl(id).querySelector<HTMLElement>('[title="Drag to reorder"]')!;
    const fire = (type: string, y: number) => act(() => void grip.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY: y })));
    fire('pointerdown', grip.getBoundingClientRect().top);
    fire('pointermove', clientY);
    during?.();
    fire('pointerup', clientY);
  }

  it('dragging a layer onto a folder row puts it at the top of the folder', () => {
    load([base(), image('a', 'logo', at(0.3, 0.5)), folder()]);
    renderWithProviders(<LayersPanel />);
    // Protected areas, Folder 1, child, logo, Base.
    expect(mockRows()).toEqual(['mask:new', 'f', 'c', 'a', 'b']);
    drag('a', 34 + 17, () => expect(rowEl('f')).toHaveClass('border-amber-60'));
    expect((findLayer(S().layers, 'f')!.layer as FolderLayer).children.map((c) => c.id)).toEqual(['c', 'a']);
  });

  it('dropping above a row higher in the same list moves the layer there', () => {
    load([base(), image('x', 'x', at(0.3, 0.5)), image('y', 'y', at(0.3, 0.3)), image('z', 'z', at(0.3, 0.1))]);
    renderWithProviders(<LayersPanel />);
    expect(mockRows()).toEqual(['mask:new', 'z', 'y', 'x', 'b']);
    // The upper half of z's row: above z, the top of the stack.
    drag('x', 34 + 5, () => expect(rowEl('z')).toHaveClass('border-t-amber-60'));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'y', 'z', 'x']);
  });

  it('dropping between a folder’s rows puts the layer in the folder there', () => {
    load([base(), folder([image('c1', 'c1', at(0.6, 0.2)), image('c2', 'c2', at(0.6, 0.4))]), image('a', 'logo', at(0.3, 0.5))]);
    renderWithProviders(<LayersPanel />);
    expect(mockRows()).toEqual(['mask:new', 'a', 'f', 'c2', 'c1', 'b']);
    // The lower half of c2's row: between c2 and c1.
    drag('a', 3 * 34 + 30, () => expect(rowEl('c2')).toHaveClass('border-b-amber-60'));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'f']);
    expect((findLayer(S().layers, 'f')!.layer as FolderLayer).children.map((c) => c.id)).toEqual(['c1', 'a', 'c2']);
  });

  it('under an expanded merged object the marker shows on its last piece', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1)), image('e', 'top', at(0.6, 0.1))]);
    renderWithProviders(<LayersPanel />);
    act(() => void S().mergeLayers(['a', 'd']));
    const merged = S().layers[1]!.id;
    await user.click(panel().getByRole('button', { name: 'Expand Merged object' }));
    expect(mockRows()).toEqual(['mask:new', 'e', merged, 'd', 'a', 'b']);
    drag('e', 2 * 34 + 30, () => {
      expect(rowEl('a')).toHaveClass('border-b-amber-60');
      expect(rowEl(merged)).not.toHaveClass('border-b-amber-60');
    });
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'e', merged]);
  });

  it('Shift+click selects the range in one list; Escape in the panel goes back to one', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1)), image('e', 'top', at(0.6, 0.1))]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'logo' }));
    await user.keyboard('{Shift>}');
    await user.click(panel().getByRole('button', { name: 'top' }));
    await user.keyboard('{/Shift}');
    expect(S().selectedIds).toEqual(['a', 'd', 'e']);
    expect(panel().getByRole('group', { name: '3 layers selected' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(S().selectedIds).toEqual([]);
    expect(S().selectedId).toBe('a');
    expect(panel().queryByRole('group', { name: /selected/ })).toBeNull();
  });

  it('New folder with a folder in the selection says why instead of making an empty folder', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), folder()]);
    renderWithProviders(<LayersPanel />);
    act(() => {
      S().select('a');
      S().toggleSelect('f');
    });
    await user.click(panel().getByRole('button', { name: 'New folder' }));
    expect(S().layers.filter((l) => l.kind === 'folder')).toHaveLength(1);
    expect(toastTexts()).toContain('A folder can’t go inside another folder');
  });

  it('the delete toast’s Undo uses the editor’s undo while the layers are unchanged', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5))]);
    renderWithProviders(<LayersPanel />);
    await user.click(panel().getByRole('button', { name: 'logo actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    // A project setting changes the revision, not the layers.
    act(() => S().setName('Renamed'));
    const shown = useToasts.getState().toasts.find((t) => t.message === 'Deleted layer “logo”');
    await act(() => useToasts.getState().undo(shown!.id));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'a']);
    // The editor's undo: redo can delete it again.
    expect(S().future).toHaveLength(1);
  });

  it('Alt+↓ moves a folder within the top level', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), folder()]);
    renderWithProviders(<LayersPanel />);
    panel().getByRole('button', { name: 'Folder 1' }).focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'f', 'a']);
  });

  it('shape and merged rows are named after their kind', () => {
    const { decal: _decal, ...rest } = image('p', '', null);
    const merged: MergedLayer = { id: 'm', kind: 'merged', name: '', visible: true, decal: at(0.3, 0.9), opacity: 1, children: [{ ...rest, place: { x: 0, y: 0, w: 1, h: 1, angle: 0 } }] };
    load([base(), { ...newShapeLayer('polygon', at(0.3, 0.5)), id: 's' }, merged]);
    renderWithProviders(<LayersPanel />);
    expect(panel().getByRole('button', { name: 'Polygon' })).toBeInTheDocument();
    expect(panel().getByRole('button', { name: 'Merged object' })).toBeInTheDocument();
  });
});
