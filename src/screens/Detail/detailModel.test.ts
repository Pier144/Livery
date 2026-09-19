import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import type { WtInstall } from '@/store/installs';
import type { HangarSkin, TextureInfo, Vehicle, WtLiveSkin } from '@/types';
import {
  deriveTryState,
  formatCount,
  formatPosted,
  formatTextureSize,
  galleryViews,
  initialOf,
  needsAttention,
  orderTextures,
  resolutionText,
  rovingIndex,
  sameVehicleSkins,
  stepParts,
  texturesTotal,
  textureWarning,
} from './detailModel';

const MB = 1024 * 1024;
const TIGER: Vehicle = { code: 'germ_tiger', name: 'Tiger', nation: 'GER', type: 'ground', class: 'Heavy tank' };
const T34: Vehicle = { code: 'ussr_t34', name: 'T-34', nation: 'USSR', type: 'ground', class: 'Medium tank' };

const hangarSkin = (extra: Partial<HangarSkin> = {}): HangarSkin => ({
  id: 'h1',
  folder: 'germ_tiger_Kessler',
  name: 'Tiger',
  vehicle: TIGER,
  origin: 'wtlive',
  sizeBytes: 1,
  active: true,
  installedAt: '2026-09-19T10:00:00Z',
  sourceId: 's1',
  ...extra,
});
const track = (extra: Partial<WtInstall>): WtInstall => ({ installId: 'i1', mode: 'temporary', step: 'download', pct: 0, ...extra });
const post = (id: string, vehicle: Vehicle): WtLiveSkin => ({
  id,
  name: id,
  vehicle,
  author: { id: 'a', name: 'A', url: '' },
  category: 'Historical',
  downloads: 0,
  likes: 0,
  postedAt: '2026-06-12T17:48:09Z',
  sizeBytes: 0,
  images: [],
  postUrl: '',
  downloadUrl: '',
});

describe('deriveTryState', () => {
  it('is idle with nothing installed or running', () => {
    expect(deriveTryState(undefined, undefined)).toBe('idle');
  });

  it('is installing while a temporary install runs, including a finished one awaiting the hangar', () => {
    expect(deriveTryState(track({ step: 'extract', pct: 50 }), undefined)).toBe('installing');
    expect(deriveTryState(track({ step: 'done', pct: 100 }), undefined)).toBe('installing');
  });

  it('ignores normal installs and failed tries', () => {
    expect(deriveTryState(track({ mode: 'normal' }), undefined)).toBe('idle');
    expect(deriveTryState(track({ step: 'error' }), undefined)).toBe('idle');
  });

  it('is active when the hangar holds a temporary copy, kept when a normal one', () => {
    expect(deriveTryState(track({ step: 'done', pct: 100 }), hangarSkin({ temporary: true }))).toBe('active');
    expect(deriveTryState(undefined, hangarSkin())).toBe('kept');
  });
});

describe('gallery', () => {
  it('uses the post images, else the four placeholder views', () => {
    expect(galleryViews(['a.jpg', 'b.jpg']).map((v) => [v.n, v.src])).toEqual([
      [1, 'a.jpg'],
      [2, 'b.jpg'],
    ]);
    expect(galleryViews([]).map((v) => v.view)).toEqual(['front', 'side', 'rear', 'detail']);
  });

  it('moves a roving index with arrows (wrapping), Home and End', () => {
    expect(rovingIndex('ArrowRight', 3, 4)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(rovingIndex('ArrowDown', 1, 4)).toBe(2);
    expect(rovingIndex('Home', 2, 4)).toBe(0);
    expect(rovingIndex('End', 0, 4)).toBe(3);
    expect(rovingIndex('Enter', 0, 4)).toBeNull();
    expect(rovingIndex('ArrowRight', 0, 0)).toBeNull();
  });

  it('lists other skins of the same vehicle once, without the skin itself', () => {
    const self = post('s1', TIGER);
    const lists = [[post('s2', TIGER), self, post('s3', T34)], undefined, [post('s2', TIGER), post('s4', TIGER)]];
    expect(sameVehicleSkins(self, lists).map((s) => s.id)).toEqual(['s2', 's4']);
  });
});

describe('textures', () => {
  const rows: TextureInfo[] = [
    { file: 'germ_tiger.blk', format: 'BLK', sizeBytes: 2048 },
    { file: 'hull_c.dds', width: 8192, height: 8192, format: 'BC7', sizeBytes: 85.3 * MB, warningKind: 'heavy', warning: 'x' },
    { file: 'turret_n.dds', missing: true, warningKind: 'missing' },
    { file: 'tracks_c.dds', width: 2048, height: 2048, format: 'BC7', sizeBytes: 5.3 * MB },
  ];

  it('puts the blk last and keeps the textures in order', () => {
    expect(orderTextures(rows).map((r) => r.file)).toEqual(['hull_c.dds', 'turret_n.dds', 'tracks_c.dds', 'germ_tiger.blk']);
  });

  it('counts attention rows and sums the existing files', () => {
    expect(rows.filter(needsAttention).map((r) => r.file)).toEqual(['hull_c.dds', 'turret_n.dds']);
    expect(formatTextureSize(texturesTotal(rows))).toBe('90.6 MB');
  });

  it('formats resolutions and sizes like the Textures tab', () => {
    expect(resolutionText(rows[1]!)).toBe('8192×8192');
    expect(resolutionText(rows[2]!)).toBe('—');
    expect(formatTextureSize(2048)).toBe('2 KB');
    expect(formatTextureSize(300)).toBe('1 KB');
    expect(formatTextureSize(21.3 * MB)).toBe('21.3 MB');
    expect(formatTextureSize(0)).toBe('0 KB');
  });

  it('localizes warnings by kind and falls back to the backend text', async () => {
    const t = i18n.t.bind(i18n);
    expect(textureWarning(t, rows[1]!)).toBe('Very heavy texture (8192²). Load times may suffer.');
    expect(textureWarning(t, rows[2]!)).toBe('Referenced in skin.blk but not in the archive.');
    expect(textureWarning(t, { file: 'a.dds', width: 1000, height: 1000, warningKind: 'notSquarePow2' })).toContain('(1000×1000)');
    expect(textureWarning(t, { file: 'a.dds', warningKind: 'unreadable' })).toBe('The header can’t be read. The file may be damaged.');
    expect(textureWarning(t, { file: 'a.dds', warning: 'Something new' })).toBe('Something new');
    expect(textureWarning(t, { file: 'a.dds', missing: true })).toBe('Referenced in skin.blk but not in the archive.');
    expect(textureWarning(t, rows[3]!)).toBeNull();
    await i18n.changeLanguage('it');
    try {
      expect(textureWarning(i18n.t.bind(i18n), rows[1]!)).toBe('Texture molto pesante (8192²). I caricamenti potrebbero rallentare.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('install steps', () => {
  it('splits finished steps from the running one', () => {
    expect(stepParts('download')).toEqual({ done: [], now: 'download' });
    expect(stepParts('verify')).toEqual({ done: ['download', 'extract'], now: 'verify' });
    expect(stepParts('done')).toEqual({ done: ['download', 'extract', 'verify'], now: 'done' });
  });
});

describe('formatting', () => {
  it('formats posted dates and counts in the UI language', () => {
    expect(formatPosted('2026-06-12T12:00:00Z', 'en')).toBe('12 Jun 2026');
    expect(formatPosted('2026-09-10T12:00:00Z', 'en')).toBe('10 Sep 2026');
    expect(formatPosted('2026-06-12T12:00:00Z', 'it')).toBe('12 giu 2026');
    expect(formatPosted('not a date', 'en')).toBe('—');
    expect(formatCount(24120, 'en')).toBe('24,120');
    expect(formatCount(24120, 'it')).toBe('24.120');
  });

  it('takes the first letter of a name for the avatar', () => {
    expect(initialOf('kessler_Wolf')).toBe('K');
    expect(initialOf('  ')).toBe('?');
  });
});
