import { beforeEach, describe, expect, it } from 'vitest';
import { resetStores } from '@/test/render';
import { resetDetail, useDetail } from './detail';
import { useUi } from './ui';

beforeEach(() => {
  resetStores();
  resetDetail();
});

describe('detail store', () => {
  it('starts fresh on every entry into the Skin detail', () => {
    useUi.getState().openSkin('s1');
    const s = useDetail.getState();
    expect(s.skinId).toBe('s1');
    s.setTab('textures');
    s.setGalleryIndex(2);
    s.openCompare('s2');

    // Another skin → reset.
    useUi.getState().openSkin('s3');
    expect(useDetail.getState()).toMatchObject({ skinId: 's3', tab: 'gallery', galleryIndex: 0, zoom: false, compare: false, compareWith: null, tabSettled: false });

    // Same skin again after leaving → reset too (prototype openSkin).
    useDetail.getState().setTab('try');
    useUi.getState().go('explore');
    useUi.getState().openSkin('s3');
    expect(useDetail.getState().tab).toBe('gallery');
  });

  it('opens on Try in game once the hangar shows a skin being tried, unless a tab was picked', () => {
    useUi.getState().openSkin('s1');
    useDetail.getState().settleTab(true);
    expect(useDetail.getState().tab).toBe('try');

    useUi.getState().openSkin('s2');
    useDetail.getState().setTab('textures');
    useDetail.getState().settleTab(true);
    expect(useDetail.getState().tab).toBe('textures');

    useUi.getState().openSkin('s3');
    useDetail.getState().settleTab(false);
    useDetail.getState().settleTab(true); // settled already: a later try doesn't switch tabs
    expect(useDetail.getState().tab).toBe('gallery');
  });

  it('compare turns zoom off and remembers pane B', () => {
    const s = useDetail.getState();
    s.toggleZoom();
    s.openCompare('s2');
    expect(useDetail.getState()).toMatchObject({ zoom: false, compare: true, compareWith: 's2' });
    s.setCompareWith('s4');
    s.exitCompare();
    s.openCompare('s2');
    expect(useDetail.getState().compareWith).toBe('s4');
  });

  it('Escape closes one layer per press on the Gallery: zoom, then compare', () => {
    const s = useDetail.getState();
    useDetail.setState({ zoom: true, compare: true });
    expect(s.escape()).toBe(true);
    expect(useDetail.getState()).toMatchObject({ zoom: false, compare: true });
    expect(s.escape()).toBe(true);
    expect(useDetail.getState().compare).toBe(false);
    expect(s.escape()).toBe(false);

    // Other tabs have no layers to close.
    useDetail.setState({ tab: 'textures', zoom: true });
    expect(s.escape()).toBe(false);
    expect(useDetail.getState().zoom).toBe(true);
  });
});
