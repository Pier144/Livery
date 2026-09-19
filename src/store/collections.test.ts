import { beforeEach, describe, expect, it } from 'vitest';
import type { Collection, CollectionsState } from '@/types';
import { resetCollectionsUi, resolveOpenCollection, useCollectionsUi } from './collections';

const collection = (id: string): Collection => ({ id, name: id, skinIds: [], createdAt: '2026-09-19T10:00:00Z' });
const STATE: CollectionsState = { collections: [collection('c1'), collection('c2'), collection('c3')], activeCollectionId: 'c2' };

beforeEach(() => resetCollectionsUi());

describe('collections ui store', () => {
  it('starts with nothing picked', () => {
    expect(useCollectionsUi.getState()).toMatchObject({ openId: null, renameId: null });
  });

  it('open picks a collection', () => {
    useCollectionsUi.getState().open('c3');
    expect(useCollectionsUi.getState().openId).toBe('c3');
  });

  it('startRename opens the collection and flags its name field once', () => {
    useCollectionsUi.getState().startRename('c9');
    expect(useCollectionsUi.getState()).toMatchObject({ openId: 'c9', renameId: 'c9' });
    useCollectionsUi.getState().renameStarted();
    expect(useCollectionsUi.getState()).toMatchObject({ openId: 'c9', renameId: null });
  });

  it('reset clears both', () => {
    useCollectionsUi.getState().startRename('c1');
    resetCollectionsUi();
    expect(useCollectionsUi.getState()).toMatchObject({ openId: null, renameId: null });
  });
});

describe('resolveOpenCollection', () => {
  it('prefers the picked collection', () => {
    expect(resolveOpenCollection(STATE, 'c3')?.id).toBe('c3');
  });

  it('falls back to the active collection, then the first', () => {
    expect(resolveOpenCollection(STATE, null)?.id).toBe('c2');
    expect(resolveOpenCollection(STATE, 'deleted')?.id).toBe('c2');
    expect(resolveOpenCollection({ ...STATE, activeCollectionId: undefined }, null)?.id).toBe('c1');
    expect(resolveOpenCollection({ ...STATE, activeCollectionId: 'gone' }, 'deleted')?.id).toBe('c1');
  });

  it('is undefined without collections', () => {
    expect(resolveOpenCollection(undefined, 'c1')).toBeUndefined();
    expect(resolveOpenCollection({ collections: [] }, null)).toBeUndefined();
  });
});
