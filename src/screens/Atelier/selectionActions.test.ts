import { describe, expect, it } from 'vitest';
import { newBaseLayer, newFolder, type Layer } from '@/atelier/project';
import { nextFolderName } from './selectionActions';

const label = (n: number) => `Folder ${n}`;
const withFolders = (...names: string[]): Layer[] => [newBaseLayer(), ...names.map((name) => newFolder(name))];

describe('nextFolderName', () => {
  it('takes the first number no folder is called', () => {
    expect(nextFolderName(withFolders(), label)).toBe('Folder 1');
    expect(nextFolderName(withFolders('Folder 1', 'Folder 2'), label)).toBe('Folder 3');
    // After deleting "Folder 1" of three, counting would give "Folder 3" again.
    expect(nextFolderName(withFolders('Folder 2', 'Folder 3'), label)).toBe('Folder 1');
    expect(nextFolderName(withFolders('Folder 1', 'Folder 3'), label)).toBe('Folder 2');
    // Renamed folders don't hold a number.
    expect(nextFolderName(withFolders('Decals', 'Folder 1'), label)).toBe('Folder 2');
  });
});
