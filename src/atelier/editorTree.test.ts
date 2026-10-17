import { describe, expect, it } from 'vitest';
import { insertTarget } from './editorTree';
import { newBaseLayer, newFolder, newImageLayer, newMaskLayer, type Decal, type FolderLayer, type ImageLayer, type Layer, type MergedLayer } from './project';

const DECAL: Decal = {
  center: [0.5, 0, 0],
  normal: [1, 0, 0],
  up: [0, 1, 0],
  width: 0.4,
  height: 0.2,
  depth: 0.04,
  part: 'all',
  mirror: false,
};
const image = (id: string): ImageLayer => ({ ...newImageLayer(`img-${id}`, DECAL), id });
const folderOf = (id: string, children: FolderLayer['children']): FolderLayer => ({ ...newFolder(id, children), id });

describe('insertTarget', () => {
  const { decal: _d, ...pictureOfP } = image('p');
  const merged: MergedLayer = {
    id: 'M',
    kind: 'merged',
    name: '',
    visible: true,
    decal: DECAL,
    opacity: 1,
    children: [{ ...pictureOfP, place: { x: 0, y: 0, w: 1, h: 1, angle: 0 } }],
  };
  const layers: Layer[] = [{ ...newBaseLayer(), id: 'B' }, image('x'), folderOf('F', [image('a'), image('b')]), merged, { ...newMaskLayer(), id: 'K' }];

  it('goes above the selected layer in its container, or at the top of a selected folder', () => {
    expect(insertTarget(layers, 'x')).toEqual({ parentId: null, index: 2 });
    expect(insertTarget(layers, 'a')).toEqual({ parentId: 'F', index: 1 });
    expect(insertTarget(layers, 'F')).toEqual({ parentId: 'F', index: 2 });
    expect(insertTarget(layers, 'M')).toEqual({ parentId: null, index: 4 });
  });

  it('goes above the merged object of a selected piece', () => {
    expect(insertTarget(layers, 'p')).toEqual({ parentId: null, index: 4 });
    const inFolder: Layer[] = [layers[0]!, folderOf('G', [image('y'), merged])];
    expect(insertTarget(inFolder, 'p')).toEqual({ parentId: 'G', index: 2 });
  });

  it('goes just under the mask with the Base, the mask or nothing selected', () => {
    for (const id of ['B', 'K', null, 'gone']) expect(insertTarget(layers, id)).toEqual({ parentId: null, index: 4 });
    expect(insertTarget(layers.slice(0, 4), null)).toEqual({ parentId: null, index: 4 });
  });
});
