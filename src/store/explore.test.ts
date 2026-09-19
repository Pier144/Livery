import { beforeEach, describe, expect, it } from 'vitest';
import { exploreDefaults, NO_EXPLORE_FILTERS, useExplore } from './explore';

const state = () => useExplore.getState();

describe('explore store', () => {
  beforeEach(() => useExplore.setState(exploreDefaults()));

  it('starts on the Explore tab, no filters, most downloaded first', () => {
    expect(state()).toMatchObject({ tab: 'explore', sort: 'downloads', ...NO_EXPLORE_FILTERS });
  });

  it('sets and clears each filter', () => {
    state().setNation('GER');
    state().setType('ground');
    state().setClass('MBT');
    state().setVehicle('germ_leopard_2a6');
    state().setCategory('Historical');
    state().setQuery('Kessler');
    expect(state()).toMatchObject({ nation: 'GER', type: 'ground', class: 'MBT', vehicle: 'germ_leopard_2a6', category: 'Historical', q: 'Kessler' });

    state().clear('nation');
    state().clear('q');
    expect(state()).toMatchObject({ nation: null, q: '', type: 'ground' });
  });

  it('treats blank class and vehicle as no filter', () => {
    state().setClass('  ');
    state().setVehicle('');
    expect(state()).toMatchObject({ class: null, vehicle: null });
    state().setVehicle('  su_27 ');
    expect(state().vehicle).toBe('su_27');
  });

  it('clearAll empties every filter but keeps the sort and tab', () => {
    state().setSort('newest');
    state().setTab('following');
    state().setNation('USSR');
    state().setQuery('x');
    state().clearAll();
    expect(state()).toMatchObject({ ...NO_EXPLORE_FILTERS, sort: 'newest', tab: 'following' });
  });

  it('applyVehicle opens the Explore tab on just that vehicle', () => {
    state().setTab('following');
    state().setNation('USSR');
    state().setQuery('winter');
    state().setSort('likes');
    state().applyVehicle('germ_leopard_2a6');
    expect(state()).toMatchObject({ ...NO_EXPLORE_FILTERS, tab: 'explore', vehicle: 'germ_leopard_2a6', sort: 'likes' });
  });

  it('applyAuthor opens the Explore tab searching for the author', () => {
    state().setTab('following');
    state().setVehicle('su_27');
    state().applyAuthor(' Kessler_Wolf ');
    expect(state()).toMatchObject({ ...NO_EXPLORE_FILTERS, tab: 'explore', q: 'Kessler_Wolf' });
  });
});
