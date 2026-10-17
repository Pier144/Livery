import { act, fireEvent, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAtelierEditor } from '@/atelier/editorStore';
import {
  HAZARD_DARK,
  MAX_REPEAT,
  newBaseLayer,
  newFolder,
  newImageLayer,
  newShapeLayer,
  newTextLayer,
  type Decal,
  type FolderLayer,
  type ImageLayer,
  type Layer,
  type MergedLayer,
  type Piece,
  type ShapeLayer,
  type UnsupportedLayer,
} from '@/atelier/project';
import { useToasts } from '@/store/toasts';
import { renderWithProviders, resetStores } from '@/test/render';
import type { AtelierProject } from '@/types';
import { resetDecalUi } from './decalUi';
import { PropertiesPanel } from './PropertiesPanel';
import { repeatCap } from './RepeatSection';
import { useSelectionActions } from './selectionActions';

const S = () => useAtelierEditor.getState();
const toastTexts = () => useToasts.getState().toasts.map((t) => t.message);

/** A decal on the +x side, centred at (0.5, y, z). */
const at = (y: number, z: number): Decal => ({
  center: [0.5, y, z],
  normal: [1, 0, 0],
  up: [0, 1, 0],
  width: 0.2,
  height: 0.1,
  depth: 0.04,
  part: 'all',
  mirror: false,
});

const base = (): Layer => ({ ...newBaseLayer(), id: 'b' });
const image = (id: string, name: string, decal: Decal | null): ImageLayer => ({ ...newImageLayer(`asset-${id}`, decal, name), id });
const shape = (id: string, decal: Decal | null = at(0.3, 0.5)): ShapeLayer => ({ ...newShapeLayer('rect', decal), id });
const place = { x: 0, y: 0, w: 0.5, h: 1, angle: 0 };

/** A merged object holding an image piece and a star piece. */
function merged(): MergedLayer {
  const { decal: _d1, ...picture } = image('pi', 'logo piece', null);
  const { decal: _d2, ...star } = { ...newShapeLayer('star'), id: 'ps' };
  const children: Piece[] = [
    { ...picture, place: { ...place, x: -0.25 } },
    { ...star, place: { ...place, x: 0.25 } },
  ];
  return { id: 'm', kind: 'merged', name: '', visible: true, decal: at(0.3, 0.9), opacity: 1, children };
}

function load(layers: Layer[], select?: string) {
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
  act(() => {
    S().load(project);
    if (select) S().select(select);
  });
}

function renderPanel() {
  return renderWithProviders(
    <PropertiesPanel
      brush={{ size: 0.05, hardness: 0.5, erase: false, part: 'all' }}
      onBrush={vi.fn()}
      checkShared={vi.fn(async () => false)}
      onRemoveBackground={vi.fn()}
      onRefineEdge={vi.fn()}
    />,
  );
}

const layerOf = (id: string) => S().layers.find((l) => l.id === id);
const shapeOf = (id: string) => layerOf(id) as ShapeLayer;

describe('Atelier Properties panel', () => {
  beforeEach(() => {
    resetStores();
    resetDecalUi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a shape shows the shape picker; switching to Star shows Points and Inner size', async () => {
    const user = userEvent.setup();
    load([base(), shape('s')], 's');
    renderPanel();
    expect(screen.getByRole('button', { name: 'Rectangle', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ellipse', pressed: false })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Corner rounding' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Points' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Star' }));
    expect(shapeOf('s').shape).toBe('star');
    expect(screen.getByRole('button', { name: 'Star', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Points' })).toHaveValue('5');
    expect(screen.getByRole('slider', { name: 'Inner size' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Corner rounding' })).toBeNull();
    fireEvent.change(screen.getByRole('slider', { name: 'Points' }), { target: { value: '7' } });
    expect(shapeOf('s').points).toBe(7);
    // The shared rows follow.
    for (const name of ['Opacity', 'Wear', 'Depth']) expect(screen.getByRole('slider', { name })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Mirror to the other side' })).toBeInTheDocument();
  });

  it('Fill Stripes keeps the colour first, shows angle and stripe width and writes the fill', async () => {
    const user = userEvent.setup();
    load([base(), shape('s')], 's');
    renderPanel();
    expect(screen.queryByRole('slider', { name: 'Stripe angle' })).toBeNull();
    await user.click(screen.getByRole('radio', { name: 'Stripes' }));
    expect(shapeOf('s').fill).toEqual({ kind: 'stripes', colors: ['#e8b600', HAZARD_DARK], angle: 45, stripeWidth: 0.08 });
    expect(screen.getByRole('slider', { name: 'Stripe angle' })).toHaveValue('45');
    fireEvent.change(screen.getByRole('slider', { name: 'Stripe width' }), { target: { value: '0.2' } });
    expect(shapeOf('s').fill).toMatchObject({ kind: 'stripes', stripeWidth: 0.2 });
    expect(screen.getByLabelText('Colour 2')).toHaveValue(HAZARD_DARK);
    // Back to Solid: the first stripe colour.
    await user.click(screen.getByRole('radio', { name: 'Solid' }));
    expect(shapeOf('s').fill).toEqual({ kind: 'solid', color: '#e8b600' });
  });

  it('the size fields write the decal in centimetres on Enter; text that is not a size puts it back', async () => {
    const user = userEvent.setup();
    load([base(), shape('s')], 's');
    renderPanel();
    const width = screen.getByRole('textbox', { name: 'Width' });
    expect(width).toHaveValue('20');
    await user.clear(width);
    await user.type(width, '150{Enter}');
    expect(shapeOf('s').decal?.width).toBeCloseTo(1.5);
    const height = screen.getByRole('textbox', { name: 'Height' });
    await user.clear(height);
    await user.type(height, '5,5{Enter}');
    expect(shapeOf('s').decal?.height).toBeCloseTo(0.055);
    expect(S().past).toHaveLength(2);
    await user.clear(height);
    await user.type(height, 'abc{Enter}');
    expect(height).toHaveValue('5.5');
    expect(shapeOf('s').decal?.height).toBeCloseTo(0.055);
  });

  it('the Repeat switch adds a repeat; Copies changes the count in one undo step', async () => {
    const user = userEvent.setup();
    load([base(), shape('s')], 's');
    renderPanel();
    expect(screen.queryByRole('slider', { name: 'Copies' })).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Repeat' }));
    expect(shapeOf('s').repeat).toEqual({ count: 3, gap: 0.5, direction: 'row' });
    const copies = screen.getByRole('slider', { name: 'Copies' });
    expect(copies).toHaveAttribute('max', String(MAX_REPEAT));
    const before = S().past.length;
    fireEvent.change(copies, { target: { value: '6' } });
    fireEvent.change(copies, { target: { value: '7' } });
    fireEvent.pointerUp(copies);
    expect(shapeOf('s').repeat?.count).toBe(7);
    expect(S().past).toHaveLength(before + 1);
    await user.click(screen.getByRole('radio', { name: 'Column' }));
    expect(shapeOf('s').repeat?.direction).toBe('column');
    // Solid shapes may alternate their colour.
    await user.click(screen.getByRole('switch', { name: 'Alternate colour' }));
    expect(shapeOf('s').repeat?.alternate).toBe(HAZARD_DARK);
    expect(screen.getByLabelText('Colour of every second copy')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Repeat' }));
    expect(shapeOf('s').repeat).toBeUndefined();
  });

  it('Copies offers no more than the draw budget leaves, mirror copies counted', () => {
    const full = (id: string, count: number): ShapeLayer => ({ ...shape(id), repeat: { count, gap: 0.5, direction: 'row' } });
    const others = [...Array.from({ length: 7 }, (_, i) => full(`r${i}`, 50)), full('r7', 30)];
    const single = shape('s');
    expect(repeatCap([base(), ...others, single], single, 2)).toBe(20);
    const mirrored = { ...single, decal: { ...single.decal!, mirror: true } };
    expect(repeatCap([base(), ...others, mirrored], mirrored, 2)).toBe(10);
    expect(repeatCap([base(), single], single, 2)).toBe(MAX_REPEAT);
  });

  it('a piece shows its content and the separate note, without placement or repeat', () => {
    load([base(), merged()], 'pi');
    renderPanel();
    expect(screen.getByText('To move this piece or change its picture, separate the object.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Flip horizontally' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove background' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Depth' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Repeat' })).toBeNull();
    expect(screen.getByRole('slider', { name: 'Opacity' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Wear' })).toBeInTheDocument();
    // A shape piece gets the shape options but no size.
    act(() => S().select('ps'));
    expect(screen.getByRole('button', { name: 'Star', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Width' })).toBeNull();
    fireEvent.change(screen.getByRole('slider', { name: 'Opacity' }), { target: { value: '0.5' } });
    expect((layerOf('m') as MergedLayer).children[1]).toMatchObject({ id: 'ps', opacity: 0.5 });
  });

  it('a merged object lists its pieces, has no Wear, and Separate splits it', async () => {
    const user = userEvent.setup();
    load([base(), merged()], 'm');
    renderPanel();
    expect(screen.getByText('Holds 2 pieces')).toBeInTheDocument();
    expect(screen.getByText('logo piece')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Depth' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Wear' })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Repeat' })).toBeInTheDocument();
    act(() => S().setLayerProps('m', { repeat: { count: 2, gap: 0.5, direction: 'row' } }));
    await user.click(screen.getByRole('button', { name: 'Separate' }));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'pi', 'ps']);
    expect(toastTexts()).toContain('Separated. The repeat was removed');
  });

  it('several selected layers show "N layers selected" and the selection actions', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1))], 'a');
    act(() => S().toggleSelect('d'));
    renderPanel();
    expect(screen.getByRole('region', { name: '2 layers selected' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge' })).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('button', { name: 'Put in folder' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(S().layers.map((l) => l.id)).toEqual(['b']);
    expect(toastTexts()).toContain('Deleted 2 layers');
  });

  it('Merge from the panel merges the selection; with a folder selected it is unavailable', async () => {
    const user = userEvent.setup();
    load([base(), image('a', 'logo', at(0.3, 0.5)), image('d', 'badge', at(0.3, 0.1))], 'a');
    act(() => S().toggleSelect('d'));
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Merge' }));
    expect(S().layers.map((l) => l.kind)).toEqual(['base', 'merged']);
    expect(toastTexts()).toContain('Merged 2 layers');

    const folder: FolderLayer = { ...newFolder('Folder 1'), id: 'f' };
    load([base(), image('a', 'logo', at(0.3, 0.5)), folder], 'a');
    act(() => S().toggleSelect('f'));
    expect(screen.getByRole('button', { name: 'Merge' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Put in folder' })).toHaveAttribute('title', 'A folder can’t go inside another folder');
  });

  it('a folder shows its item count, Dissolve folder and Delete folder and content', async () => {
    const user = userEvent.setup();
    const folder: FolderLayer = { ...newFolder('Decals', [image('c', 'child', at(0.6, 0.2))]), id: 'f' };
    load([base(), folder], 'f');
    renderPanel();
    expect(screen.getByText('1 item')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Dissolve folder' }));
    expect(S().layers.map((l) => l.id)).toEqual(['b', 'c']);
    act(() => S().undo());
    act(() => S().select('f'));
    await user.click(screen.getByRole('button', { name: 'Delete folder and content' }));
    expect(S().layers.map((l) => l.id)).toEqual(['b']);
    expect(toastTexts()).toContain('Deleted folder “Decals”');
  });

  it('image and text layers keep their rows and gain Repeat', () => {
    load([base(), image('a', 'logo', at(0.3, 0.5)), { ...newTextLayer('TIGER', at(0.3, 0.1)), id: 't' }], 'a');
    renderPanel();
    expect(screen.getByRole('switch', { name: 'Flip horizontally' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove background' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refine edge' })).toBeInTheDocument();
    for (const name of ['Opacity', 'Wear', 'Depth']) expect(screen.getByRole('slider', { name })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Mirror to the other side' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Repeat' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Alternate colour' })).toBeNull();
    act(() => S().select('t'));
    expect(screen.getByRole('textbox', { name: 'Text' })).toHaveValue('TIGER');
    expect(screen.getByRole('combobox', { name: 'Font' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Slant' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Depth' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Repeat' })).toBeInTheDocument();
  });

  it('leaving a size field unchanged keeps the exact size (no rounding, no undo step)', async () => {
    const user = userEvent.setup();
    load([base(), shape('s', { ...at(0.3, 0.5), width: 0.12345 })], 's');
    renderPanel();
    const width = screen.getByRole('textbox', { name: 'Width' });
    expect(width).toHaveValue('12.3');
    await user.click(width);
    await user.tab();
    await user.click(width);
    await user.keyboard('{Enter}');
    expect(shapeOf('s').decal?.width).toBe(0.12345);
    expect(S().past).toHaveLength(0);
    // After Enter the field follows the frame again, focus or not.
    await user.clear(width);
    await user.type(width, '30{Enter}');
    act(() => S().undo());
    expect(width).toHaveValue('12.3');
  });

  it('the copies cap counts layers past the budget; the hint shows only at the cap', () => {
    const full = (id: string, count: number): ShapeLayer => ({ ...shape(id), repeat: { count, gap: 0.5, direction: 'row' } });
    // 360 boxes drawn, then a 50-copy layer the budget leaves out: it still counts, so nothing is
    // left for the selected layer, which keeps the 2 copies it may have.
    const others = [...Array.from({ length: 7 }, (_, i) => full(`r${i}`, 50)), full('r7', 10), full('x', 50)];
    const selected = full('s', 3);
    expect(repeatCap([base(), ...others, selected], selected, 2)).toBe(2);

    const some = [...Array.from({ length: 7 }, (_, i) => full(`r${i}`, 50)), full('r7', 30)];
    load([base(), ...some, full('s', 3)], 's');
    renderPanel();
    // 380 + 3 boxes: the cap is 20 copies, 3 are shown, no hint yet.
    expect(screen.getByRole('slider', { name: 'Copies' })).toHaveAttribute('max', '20');
    expect(screen.queryByText('The project can’t draw more copies')).toBeNull();
    fireEvent.change(screen.getByRole('slider', { name: 'Copies' }), { target: { value: '20' } });
    expect(screen.getByText('The project can’t draw more copies')).toBeInTheDocument();
  });

  it('Put in folder never makes an empty folder: a refusal says why', () => {
    const unsupported: UnsupportedLayer = { id: 'u', kind: 'unsupported', name: '', visible: true, original: { kind: 'sticker' } };
    load([base(), image('a', 'logo', at(0.3, 0.5)), unsupported], 'a');
    const { result } = renderHook(() => useSelectionActions());
    let id: string | null = 'x';
    act(() => {
      id = result.current.putInFolder(['a', 'u']);
    });
    expect(id).toBeNull();
    expect(S().layers.some((l) => l.kind === 'folder')).toBe(false);
    expect(toastTexts()).toContain('Only image, text, shape and merged layers can go in a folder');
  });
});
