import { beforeEach, describe, expect, it } from 'vitest';
import { resetStores } from '@/test/render';
import { hangarDefaults, NO_FILTERS, useHangarStore } from './hangar';

const store = () => useHangarStore.getState();
const selected = () => [...store().selection].sort();

beforeEach(() => {
  resetStores();
  useHangarStore.setState(hangarDefaults());
});

describe('hangar store', () => {
  it('starts in grid view with nothing filtered or selected', () => {
    expect(store().view).toBe('grid');
    expect(store().q).toBe('');
    expect(store().filters).toEqual(NO_FILTERS);
    expect(store().selection.size).toBe(0);
  });

  it('sets and clears search and chip filters', () => {
    store().setQuery('tiger');
    store().setFilter('nation', 'GER');
    store().setFilter('origin', 'mine');
    expect(store().filters).toEqual({ nation: 'GER', type: null, origin: 'mine' });
    store().setFilter('nation', null);
    expect(store().filters.nation).toBeNull();
    store().clearFilters();
    expect(store().q).toBe('');
    expect(store().filters).toEqual(NO_FILTERS);
  });

  it('toggles single skins with a fresh Set each time', () => {
    const before = store().selection;
    store().toggle('a');
    store().toggle('b');
    expect(store().selection).not.toBe(before);
    expect(selected()).toEqual(['a', 'b']);
    store().toggle('a');
    expect(selected()).toEqual(['b']);
  });

  it('selectAll replaces the selection; clear empties it', () => {
    store().toggle('x');
    store().selectAll(['a', 'b', 'c']);
    expect(selected()).toEqual(['a', 'b', 'c']);
    store().clear();
    expect(store().selection.size).toBe(0);
    expect(store().anchor).toBeNull();
  });

  it('Shift ranges select from the anchor in on-screen order, either direction', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    store().toggle('b');
    store().selectRange(order, 'd');
    expect(selected()).toEqual(['b', 'c', 'd']);
    store().selectRange(order, 'a');
    expect(selected()).toEqual(['a', 'b', 'c', 'd']);
    // No anchor (or one that's filtered out): a plain toggle.
    store().clear();
    store().selectRange(order, 'e');
    expect(selected()).toEqual(['e']);
    expect(store().anchor).toBe('e');
    store().selectRange(['x', 'y'], 'y');
    expect(selected()).toEqual(['e', 'y']);
  });

  it('persists only the grid/list preference', () => {
    store().setView('list');
    store().setQuery('abrams');
    store().toggle('a');
    const saved = JSON.parse(localStorage.getItem('livery.hangar') ?? '{}');
    expect(saved.state).toEqual({ view: 'list' });
  });
});
