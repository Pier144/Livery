import { describe, expect, it } from 'vitest';
import {
  allLayers,
  childrenOf,
  findLayer,
  framedLayers,
  insertLayers,
  isPiece,
  mapLayers,
  moveItems,
  removeLayers,
  replaceLayer,
  spliceLayer,
  textLayers,
  updateLayer,
} from './layerTree';
import type { Decal, FolderLayer, Layer, MergedLayer, Piece, Place, UnsupportedPiece } from './project';
import { newBaseLayer, newImageLayer, newMaskLayer, newShapeLayer, newTextLayer } from './project';

const decal: Decal = { center: [0, 0, 0], normal: [0, 0, 1], up: [0, 1, 0], width: 1, height: 1, depth: 0.1, part: 'all', mirror: false };
const place: Place = { x: 0, y: 0, w: 0.5, h: 0.5, angle: 0 };

function withId<T extends { id: string }>(item: T, id: string): T {
  return { ...item, id };
}

function shapePiece(id: string): Piece {
  const { decal: _d, repeat: _r, ...rest } = newShapeLayer('rect', decal);
  return { ...rest, id, place };
}

function textPiece(id: string, text: string): Piece {
  const { decal: _d, repeat: _r, ...rest } = newTextLayer(text, decal);
  return { ...rest, id, place };
}

function imagePiece(id: string): Piece {
  const { decal: _d, repeat: _r, ...rest } = newImageLayer('asset', decal);
  return { ...rest, id, place };
}

const unsupportedPiece: UnsupportedPiece = {
  id: 'U1',
  kind: 'unsupported',
  name: '',
  visible: true,
  original: { kind: 'sticker', id: 'U1' },
  place,
};

function merged(id: string, children: MergedLayer['children']): MergedLayer {
  return { id, kind: 'merged', name: '', visible: true, decal, opacity: 1, children };
}

function folder(id: string, children: FolderLayer['children']): FolderLayer {
  return { id, kind: 'folder', name: '', visible: true, collapsed: false, children };
}

/**
 * B, I1, F[T1, M1[P1, P2]], M2[P3, U1], T2, K
 */
function tree(): Layer[] {
  return [
    withId(newBaseLayer(), 'B'),
    withId(newImageLayer('asset', decal), 'I1'),
    folder('F', [withId(newTextLayer('folder text', decal), 'T1'), merged('M1', [shapePiece('P1'), textPiece('P2', 'piece text')])]),
    merged('M2', [imagePiece('P3'), unsupportedPiece]),
    withId(newTextLayer('top text', decal), 'T2'),
    withId(newMaskLayer(), 'K'),
  ];
}

const ids = (items: readonly { id: string }[]) => items.map((l) => l.id);

describe('findLayer', () => {
  it('finds a top-level layer', () => {
    const layers = tree();
    const found = findLayer(layers, 'I1');
    expect(found).toEqual({ layer: layers[1], parentId: null, index: 1, parent: null });
    expect(isPiece(found!)).toBe(false);
  });

  it('finds a folder child', () => {
    const layers = tree();
    const found = findLayer(layers, 'T1');
    expect(found?.parentId).toBe('F');
    expect(found?.index).toBe(0);
    expect(found?.parent).toBe(layers[2]);
    expect(found?.layer.id).toBe('T1');
    expect(isPiece(found!)).toBe(false);
  });

  it('finds a piece of a top-level merged object', () => {
    const layers = tree();
    const found = findLayer(layers, 'U1');
    expect(found?.parentId).toBe('M2');
    expect(found?.index).toBe(1);
    expect(found?.parent).toBe(layers[3]);
    expect(isPiece(found!)).toBe(true);
  });

  it('finds a piece of a merged object inside a folder', () => {
    const layers = tree();
    const m1 = (layers[2] as FolderLayer).children[1];
    const found = findLayer(layers, 'P2');
    expect(found?.parentId).toBe('M1');
    expect(found?.index).toBe(1);
    expect(found?.parent).toBe(m1);
    expect(found?.layer.id).toBe('P2');
    expect(isPiece(found!)).toBe(true);
    expect(findLayer(layers, 'M1')?.parentId).toBe('F');
  });

  it('returns null for an unknown id', () => {
    expect(findLayer(tree(), 'nope')).toBeNull();
  });
});

describe('childrenOf', () => {
  it('lists each container', () => {
    const layers = tree();
    expect(childrenOf(layers, null)).toBe(layers);
    expect(ids(childrenOf(layers, 'F'))).toEqual(['T1', 'M1']);
    expect(ids(childrenOf(layers, 'M1'))).toEqual(['P1', 'P2']);
    expect(ids(childrenOf(layers, 'M2'))).toEqual(['P3', 'U1']);
  });

  it('returns [] for an unknown id or a non-container', () => {
    const layers = tree();
    expect(childrenOf(layers, 'nope')).toEqual([]);
    expect(childrenOf(layers, 'I1')).toEqual([]);
  });
});

describe('replaceLayer', () => {
  it('replaces at the top level, keeping the other layers', () => {
    const layers = tree();
    const next = { ...layers[1], name: 'renamed' } as Layer;
    const out = replaceLayer(layers, 'I1', next);
    expect(out).not.toBe(layers);
    expect(out[1]).toBe(next);
    for (const i of [0, 2, 3, 4, 5]) expect(out[i]).toBe(layers[i]);
  });

  it('replaces a folder child: new folder, untouched siblings', () => {
    const layers = tree();
    const f = layers[2] as FolderLayer;
    const next = { ...f.children[0]!, name: 'x' };
    const out = replaceLayer(layers, 'T1', next);
    const outF = out[2] as FolderLayer;
    expect(outF).not.toBe(f);
    expect(outF.children).not.toBe(f.children);
    expect(outF.children[0]).toBe(next);
    expect(outF.children[1]).toBe(f.children[1]);
    expect(out[3]).toBe(layers[3]);
    expect(out[1]).toBe(layers[1]);
  });

  it('replaces a piece inside a folder merged object, rebuilding only the path', () => {
    const layers = tree();
    const f = layers[2] as FolderLayer;
    const m1 = f.children[1] as MergedLayer;
    const next = { ...m1.children[0], name: 'p' } as Piece;
    const out = replaceLayer(layers, 'P1', next);
    const outF = out[2] as FolderLayer;
    const outM1 = outF.children[1] as MergedLayer;
    expect(outF).not.toBe(f);
    expect(outM1).not.toBe(m1);
    expect(outM1.children[0]).toBe(next);
    expect(outM1.children[1]).toBe(m1.children[1]);
    expect(outF.children[0]).toBe(f.children[0]);
    expect(out[3]).toBe(layers[3]);
  });

  it('returns the same array for an unknown id', () => {
    const layers = tree();
    expect(replaceLayer(layers, 'nope', layers[1]!)).toBe(layers);
  });
});

describe('updateLayer', () => {
  it('applies the change at any depth', () => {
    const layers = tree();
    const out = updateLayer(layers, 'P3', (item) => ({ ...item, name: 'updated' }));
    expect(findLayer(out, 'P3')?.layer.name).toBe('updated');
    expect(out[2]).toBe(layers[2]);
  });

  it('returns the same array when the change returns the item itself', () => {
    const layers = tree();
    expect(updateLayer(layers, 'P2', (item) => item)).toBe(layers);
    expect(updateLayer(layers, 'nope', (item) => ({ ...item, name: 'x' }))).toBe(layers);
  });
});

describe('removeLayers', () => {
  it('removes top-level layers', () => {
    const layers = tree();
    const out = removeLayers(layers, ['I1', 'T2']);
    expect(ids(out)).toEqual(['B', 'F', 'M2', 'K']);
    expect(out[1]).toBe(layers[2]);
  });

  it('removes a container with its children', () => {
    const layers = tree();
    const out = removeLayers(layers, new Set(['F']));
    expect(ids(out)).toEqual(['B', 'I1', 'M2', 'T2', 'K']);
    expect(findLayer(out, 'P1')).toBeNull();
  });

  it('removes a folder child, leaving the folder (even empty)', () => {
    const layers = tree();
    const out = removeLayers(layers, ['T1', 'M1']);
    const outF = out[2] as FolderLayer;
    expect(outF.id).toBe('F');
    expect(outF.children).toEqual([]);
    expect(out[3]).toBe(layers[3]);
  });

  it('removes a piece, keeping the merged object and untouched containers', () => {
    const layers = tree();
    const out = removeLayers(layers, ['P1']);
    const f = layers[2] as FolderLayer;
    const outF = out[2] as FolderLayer;
    expect(ids((outF.children[1] as MergedLayer).children)).toEqual(['P2']);
    expect(outF.children[0]).toBe(f.children[0]);
    expect(out[3]).toBe(layers[3]);
  });

  it('removes across containers at once', () => {
    const layers = tree();
    const out = removeLayers(layers, ['U1', 'T1', 'I1']);
    expect(ids(allLayers(out))).toEqual(['B', 'F', 'M1', 'P1', 'P2', 'M2', 'P3', 'T2', 'K']);
  });

  it('returns the same array when nothing matches', () => {
    const layers = tree();
    expect(removeLayers(layers, ['nope'])).toBe(layers);
    expect(removeLayers(layers, [])).toBe(layers);
  });
});

describe('insertLayers', () => {
  const extra = () => [withId(newShapeLayer('star', decal), 'S1'), withId(newShapeLayer('ellipse', decal), 'S2')];

  it('inserts at the top level at the index', () => {
    const layers = tree();
    const out = insertLayers(layers, null, 2, extra());
    expect(ids(out)).toEqual(['B', 'I1', 'S1', 'S2', 'F', 'M2', 'T2', 'K']);
    expect(out[4]).toBe(layers[2]);
  });

  it('keeps the Base first and the mask last', () => {
    const layers = tree();
    expect(ids(insertLayers(layers, null, 0, extra())).slice(0, 3)).toEqual(['B', 'S1', 'S2']);
    expect(ids(insertLayers(layers, null, -5, extra())).slice(0, 2)).toEqual(['B', 'S1']);
    expect(ids(insertLayers(layers, null, 6, extra())).slice(-3)).toEqual(['S1', 'S2', 'K']);
    expect(ids(insertLayers(layers, null, 99, extra())).slice(-3)).toEqual(['S1', 'S2', 'K']);
  });

  it('appends at the top when there is no mask', () => {
    const layers = tree().slice(0, 5);
    expect(ids(insertLayers(layers, null, 99, extra())).slice(-2)).toEqual(['S1', 'S2']);
  });

  it('inserts into a folder, clamping the index', () => {
    const layers = tree();
    const out = insertLayers(layers, 'F', 99, extra());
    const outF = out[2] as FolderLayer;
    expect(ids(outF.children)).toEqual(['T1', 'M1', 'S1', 'S2']);
    expect(outF.children[0]).toBe((layers[2] as FolderLayer).children[0]);
    expect(out[3]).toBe(layers[3]);
    expect(ids((insertLayers(layers, 'F', -1, extra())[2] as FolderLayer).children)).toEqual(['S1', 'S2', 'T1', 'M1']);
  });

  it('inserts pieces into a merged object inside a folder', () => {
    const layers = tree();
    const out = insertLayers(layers, 'M1', 1, [shapePiece('P9')]);
    const outF = out[2] as FolderLayer;
    expect(ids((outF.children[1] as MergedLayer).children)).toEqual(['P1', 'P9', 'P2']);
    expect(outF.children[0]).toBe((layers[2] as FolderLayer).children[0]);
    expect(out[3]).toBe(layers[3]);
  });

  it('returns the same array for an unknown container or no items', () => {
    const layers = tree();
    expect(insertLayers(layers, 'nope', 0, extra())).toBe(layers);
    expect(insertLayers(layers, 'F', 0, [])).toBe(layers);
  });
});

describe('allLayers / framedLayers / textLayers', () => {
  it('walks depth-first, bottom to top, containers before their children', () => {
    expect(ids(allLayers(tree()))).toEqual(['B', 'I1', 'F', 'T1', 'M1', 'P1', 'P2', 'M2', 'P3', 'U1', 'T2', 'K']);
  });

  it('lists framed layers at the top level and in folders, not pieces or folders', () => {
    expect(ids(framedLayers(tree()))).toEqual(['I1', 'T1', 'M1', 'M2', 'T2']);
  });

  it('finds text layers in folders and text pieces', () => {
    const texts = textLayers(tree());
    expect(ids(texts)).toEqual(['T1', 'P2', 'T2']);
    expect(texts.map((t) => t.text)).toEqual(['folder text', 'piece text', 'top text']);
  });
});

describe('kind guards', () => {
  it('refuses a piece at the top level (type error and runtime)', () => {
    const layers = tree();
    // @ts-expect-error pieces need a merged object's id
    expect(insertLayers(layers, null, 1, [shapePiece('X')])).toBe(layers);
  });

  it('refuses a piece in a folder and a layer in a merged object', () => {
    const layers = tree();
    expect(insertLayers(layers, 'F', 0, [shapePiece('X')])).toBe(layers);
    expect(insertLayers(layers, 'M2', 0, [withId(newShapeLayer('rect', decal), 'X')])).toBe(layers);
  });

  it('accepts an unsupported piece without a place in a merged object', () => {
    const { place: _p, ...bare } = unsupportedPiece;
    const out = insertLayers(tree(), 'M2', 0, [{ ...bare, id: 'U2' }]);
    expect(ids(childrenOf(out, 'M2'))).toEqual(['U2', 'P3', 'U1']);
  });

  it('refuses replacing across the layer/piece boundary', () => {
    const layers = tree();
    expect(replaceLayer(layers, 'I1', shapePiece('X'))).toBe(layers);
    expect(replaceLayer(layers, 'T1', shapePiece('X'))).toBe(layers);
    expect(replaceLayer(layers, 'P1', withId(newShapeLayer('rect', decal), 'X'))).toBe(layers);
    expect(updateLayer(layers, 'P3', (item) => withId(newShapeLayer('rect', decal), item.id))).toBe(layers);
  });
});

describe('insertLayers edge cases', () => {
  const one = () => [withId(newShapeLayer('star', decal), 'S1')];

  it('inserts at the very bottom of a top-level list without a Base', () => {
    const layers = tree().slice(1);
    expect(ids(insertLayers(layers, null, 0, one()))).toEqual(['S1', 'I1', 'F', 'M2', 'T2', 'K']);
    expect(ids(insertLayers(layers, null, -Infinity, one()))[0]).toBe('S1');
  });

  it('handles NaN and infinite indices', () => {
    const layers = tree();
    expect(ids(insertLayers(layers, null, NaN, one())).slice(-2)).toEqual(['S1', 'K']);
    expect(ids(insertLayers(layers, null, Infinity, one())).slice(-2)).toEqual(['S1', 'K']);
    expect(ids(insertLayers(layers, null, -Infinity, one())).slice(0, 2)).toEqual(['B', 'S1']);
    expect(ids((insertLayers(layers, 'F', NaN, one())[2] as FolderLayer).children)).toEqual(['T1', 'M1', 'S1']);
    expect(ids((insertLayers(layers, 'F', -Infinity, one())[2] as FolderLayer).children)).toEqual(['S1', 'T1', 'M1']);
  });

  it('inserts pieces into a top-level merged object', () => {
    const layers = tree();
    const out = insertLayers(layers, 'M2', 1, [shapePiece('P9')]);
    expect(ids(childrenOf(out, 'M2'))).toEqual(['P3', 'P9', 'U1']);
    expect(out[2]).toBe(layers[2]);
    expect(out[1]).toBe(layers[1]);
  });
});

describe('framedLayers / removeLayers edge cases', () => {
  it('includes unplaced layers', () => {
    const layers = [...tree().slice(0, 5), withId(newImageLayer('asset', null), 'I2'), ...tree().slice(5)];
    expect(ids(framedLayers(layers))).toEqual(['I1', 'T1', 'M1', 'M2', 'T2', 'I2']);
  });

  it('leaves an empty merged object when every piece is removed', () => {
    const out = removeLayers(tree(), ['P3', 'U1']);
    const m2 = out[3] as MergedLayer;
    expect(m2.id).toBe('M2');
    expect(m2.children).toEqual([]);
  });
});

describe('spliceLayer', () => {
  const two = () => [withId(newShapeLayer('star', decal), 'S1'), withId(newShapeLayer('ellipse', decal), 'S2')];

  it('replaces one folder child by several, in place', () => {
    const layers = tree();
    const f = layers[2] as FolderLayer;
    const out = spliceLayer(layers, 'T1', two());
    const outF = out[2] as FolderLayer;
    expect(ids(outF.children)).toEqual(['S1', 'S2', 'M1']);
    expect(outF.children[2]).toBe(f.children[1]);
    expect(out[3]).toBe(layers[3]);
  });

  it('replaces a top-level layer and a piece', () => {
    expect(ids(spliceLayer(tree(), 'I1', two()))).toEqual(['B', 'S1', 'S2', 'F', 'M2', 'T2', 'K']);
    expect(ids(childrenOf(spliceLayer(tree(), 'P1', [shapePiece('Q1'), shapePiece('Q2')]), 'M1'))).toEqual(['Q1', 'Q2', 'P2']);
  });

  it('removes the item when given nothing', () => {
    expect(ids(spliceLayer(tree(), 'T2', []))).toEqual(['B', 'I1', 'F', 'M2', 'K']);
  });

  it('returns the same array for an unknown id or items that do not fit', () => {
    const layers = tree();
    expect(spliceLayer(layers, 'nope', two())).toBe(layers);
    expect(spliceLayer(layers, 'T1', [shapePiece('X')])).toBe(layers);
    expect(spliceLayer(layers, 'P1', two())).toBe(layers);
  });
});

describe('mapLayers', () => {
  it('maps every item bottom-up, children before their container', () => {
    const seen: string[] = [];
    mapLayers(tree(), (item) => {
      seen.push(item.id);
      return item;
    });
    expect(seen).toEqual(['B', 'I1', 'T1', 'P1', 'P2', 'M1', 'F', 'P3', 'U1', 'M2', 'T2', 'K']);
  });

  it('gives a container its mapped children', () => {
    let m1Children: string[] = [];
    mapLayers(tree(), (item) => {
      if (item.kind === 'text') return { ...item, name: 'T' };
      if (item.id === 'M1' && item.kind === 'merged') m1Children = item.children.map((c) => c.name);
      return item;
    });
    expect(m1Children).toEqual(['', 'T']);
  });

  it('keeps untouched items and containers, and returns the same array when nothing changes', () => {
    const layers = tree();
    expect(mapLayers(layers, (item) => item)).toBe(layers);
    const out = mapLayers(layers, (item) => (item.id === 'P3' ? { ...item, name: 'x' } : item));
    expect(findLayer(out, 'P3')?.layer.name).toBe('x');
    expect(out[3]).not.toBe(layers[3]);
    expect((out[3] as MergedLayer).children[1]).toBe((layers[3] as MergedLayer).children[1]);
    for (const i of [0, 1, 2, 4, 5]) expect(out[i]).toBe(layers[i]);
  });
});

describe('moveItems', () => {
  it('moves up at the top level, correcting the index for the removed item below', () => {
    // Index 5 is K's slot before the move: I1 lands right under the mask.
    expect(ids(moveItems(tree(), ['I1'], null, 5))).toEqual(['B', 'F', 'M2', 'T2', 'I1', 'K']);
  });

  it('moves down at the top level', () => {
    expect(ids(moveItems(tree(), ['T2'], null, 1))).toEqual(['B', 'T2', 'I1', 'F', 'M2', 'K']);
  });

  it('keeps the tree order of several items whatever order the ids come in', () => {
    expect(ids(moveItems(tree(), ['T2', 'I1'], null, 5))).toEqual(['B', 'F', 'M2', 'I1', 'T2', 'K']);
    expect(ids(moveItems(tree(), ['T2', 'I1'], null, 3))).toEqual(['B', 'F', 'I1', 'T2', 'M2', 'K']);
  });

  it('moves top-level layers into a folder and a folder child out', () => {
    const into = moveItems(tree(), ['I1', 'T2'], 'F', 1);
    expect(ids(into)).toEqual(['B', 'F', 'M2', 'K']);
    expect(ids(childrenOf(into, 'F'))).toEqual(['T1', 'I1', 'T2', 'M1']);
    const out = moveItems(tree(), ['T1'], null, 1);
    expect(ids(out)).toEqual(['B', 'T1', 'I1', 'F', 'M2', 'T2', 'K']);
    expect(ids(childrenOf(out, 'F'))).toEqual(['M1']);
  });

  it('moves pieces between merged objects and within one', () => {
    const across = moveItems(tree(), ['P3'], 'M1', 0);
    expect(ids(childrenOf(across, 'M1'))).toEqual(['P3', 'P1', 'P2']);
    expect(ids(childrenOf(across, 'M2'))).toEqual(['U1']);
    expect(ids(childrenOf(moveItems(tree(), ['P1'], 'M1', 2), 'M1'))).toEqual(['P2', 'P1']);
  });

  it('carries a container with its children, ignoring children named as well', () => {
    const out = moveItems(tree(), ['F', 'T1'], null, 99);
    expect(ids(out)).toEqual(['B', 'I1', 'M2', 'T2', 'F', 'K']);
    expect(ids(childrenOf(out, 'F'))).toEqual(['T1', 'M1']);
  });

  it('returns the same array when nothing would change', () => {
    const layers = tree();
    expect(moveItems(layers, ['I1'], null, 1)).toBe(layers);
    expect(moveItems(layers, ['I1'], null, 2)).toBe(layers);
    expect(moveItems(layers, ['I1', 'F'], null, 1)).toBe(layers);
    expect(moveItems(layers, ['P2'], 'M1', 99)).toBe(layers);
  });

  it('refuses unknown targets, self-nesting and items that do not fit', () => {
    const layers = tree();
    expect(moveItems(layers, ['nope'], null, 1)).toBe(layers);
    expect(moveItems(layers, ['I1'], 'nope', 0)).toBe(layers);
    expect(moveItems(layers, ['I1'], 'T2', 0)).toBe(layers);
    expect(moveItems(layers, ['F'], 'F', 0)).toBe(layers);
    expect(moveItems(layers, ['M1'], 'M1', 0)).toBe(layers);
    expect(moveItems(layers, ['P1'], null, 1)).toBe(layers);
    expect(moveItems(layers, ['P1'], 'F', 0)).toBe(layers);
    expect(moveItems(layers, ['I1'], 'M2', 0)).toBe(layers);
    expect(moveItems(layers, ['I1', 'P1'], 'F', 0)).toBe(layers);
  });
});

describe('purity', () => {
  it('never mutates its input', () => {
    const layers = tree();
    const before = structuredClone(layers);
    replaceLayer(layers, 'P1', shapePiece('P1x'));
    updateLayer(layers, 'T1', (item) => ({ ...item, name: 'changed' }));
    removeLayers(layers, ['F', 'U1', 'T2']);
    insertLayers(layers, 'M2', 0, [shapePiece('P8')]);
    insertLayers(layers, 'F', 0, [withId(newShapeLayer('rect', decal), 'S3')]);
    insertLayers(layers, null, 3, [withId(newShapeLayer('rect', decal), 'S4')]);
    spliceLayer(layers, 'P2', [shapePiece('P7'), shapePiece('P6')]);
    mapLayers(layers, (item) => ({ ...item, name: 'mapped' }));
    moveItems(layers, ['I1', 'T2'], 'F', 1);
    moveItems(layers, ['P3'], 'M1', 0);
    allLayers(layers);
    framedLayers(layers);
    textLayers(layers);
    expect(layers).toEqual(before);
  });
});
