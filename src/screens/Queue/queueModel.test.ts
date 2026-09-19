import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import type { HangarSkin, QueueItem, Vehicle } from '@/types';
import { conflictTarget, detailsNote, headerMeta, rowLine, skinName, stepsView } from './queueModel';

const t = i18n.t;
const TIGER: Vehicle = { code: 'germ_tiger', name: 'Tiger II (H)', nation: 'GER', type: 'ground', class: '' };
const item = (extra: Partial<QueueItem> = {}): QueueItem => ({
  id: 'q1',
  path: 'C:\\Downloads\\tiger2_winter.zip',
  fileName: 'tiger2_winter.zip',
  sizeBytes: 1,
  status: 'ready',
  ...extra,
});
const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}.dds`, sizeBytes: 1 }));
const HANGAR: HangarSkin[] = [
  {
    id: 'h1',
    folder: 'Bundeswehr Flecktarn',
    name: 'Bundeswehr Flecktarn',
    vehicle: { ...TIGER, name: 'Leopard 2A4' },
    origin: 'imported',
    sizeBytes: 1,
    active: true,
    installedAt: '2026-09-19T10:00:00Z',
  },
];

describe('queueModel', () => {
  it('builds the ready note from the analysis fields', () => {
    expect(detailsNote(item({ files: files(6), textureCount: 2, blkOk: true }), t)).toBe('6 files · 2 textures · skin.blk ok');
    expect(detailsNote(item({ files: files(1), textureCount: 1, blkOk: false }), t)).toBe('1 file · 1 texture · skin.blk has problems');
    // Nothing to count: the backend's own note, or nothing.
    expect(detailsNote(item({ note: 'Looks fine' }), t)).toBe('Looks fine');
    expect(detailsNote(item(), t)).toBeUndefined();
  });

  it('writes "Status · Vehicle · note" per status', () => {
    expect(rowLine(item({ status: 'analyzing' }), t, '')).toEqual({ note: 'Analyzing…' });
    expect(rowLine(item({ vehicle: TIGER, files: files(5), textureCount: 4, blkOk: true }), t, '')).toEqual({
      label: 'Ready',
      vehicle: 'Tiger II (H)',
      note: '5 files · 4 textures · skin.blk ok',
    });
    expect(rowLine(item({ status: 'conflict', vehicle: TIGER }), t, 'Bundeswehr Flecktarn').note).toBe(
      'Same folder name as “Bundeswehr Flecktarn” (installed)',
    );
    expect(rowLine(item({ status: 'needsLook', candidates: [TIGER, TIGER, TIGER] }), t, '')).toEqual({
      label: 'Needs a look',
      vehicle: undefined,
      note: 'Can’t detect the vehicle: 3 folders inside. Pick one to continue.',
    });
    expect(rowLine(item({ status: 'installing', vehicle: TIGER }), t, '')).toEqual({ label: 'Installing', vehicle: 'Tiger II (H)' });
    expect(rowLine(item({ status: 'done' }), t, '').note).toBe('Now in My Hangar');
    expect(rowLine(item({ status: 'error', error: 'RAR archives arrive later.' }), t, '')).toEqual({
      label: 'Error',
      vehicle: undefined,
      note: 'RAR archives arrive later.',
    });
    expect(rowLine(item({ status: 'error' }), t, '').note).toBe('Something went wrong.');
  });

  it('names the installed skin a conflict clashes with', () => {
    expect(conflictTarget(item({ conflictWith: 'h1', vehicle: TIGER }), HANGAR)).toEqual({ name: 'Bundeswehr Flecktarn', vehicle: 'Leopard 2A4' });
    expect(conflictTarget(item({ conflictWith: 'disk:Old camo', vehicle: TIGER }), HANGAR)).toEqual({ name: 'Old camo', vehicle: 'Tiger II (H)' });
    // Hangar not loaded (or skin unknown): the folder it would be installed as.
    expect(conflictTarget(item({ conflictWith: 'h1', targetFolder: 'Tiger winter' }), undefined)).toEqual({ name: 'Tiger winter', vehicle: undefined });
    expect(skinName(item())).toBe('tiger2_winter');
    expect(skinName(item({ fileName: 'Some folder' }))).toBe('Some folder');
  });

  it('names another queued item a conflict clashes with, and says it is queued', () => {
    const other = item({ id: 'q2', targetFolder: 'Winter camo', vehicle: TIGER });
    const mine = item({ status: 'conflict', conflictWith: 'queue:q2', targetFolder: 'Winter camo' });
    expect(conflictTarget(mine, HANGAR, [mine, other])).toEqual({ name: 'Winter camo', vehicle: 'Tiger II (H)', queued: true });
    expect(rowLine(mine, t, 'Winter camo', true).note).toBe('Same folder name as “Winter camo” (queued)');
  });

  it('shows the install steps like the Explore card', () => {
    expect(stepsView('extract', 56.4, t)).toEqual({ done: [], now: 'Extracting 56%', next: ['Verify', 'Done'] });
    expect(stepsView('download', 3, t)).toEqual({ done: [], now: 'Extracting 3%', next: ['Verify', 'Done'] });
    expect(stepsView('verify', 80, t)).toEqual({ done: ['Extract'], now: 'Verifying 80%', next: ['Done'] });
    expect(stepsView('done', 100, t)).toEqual({ done: ['Extract', 'Verify'], now: 'Done', next: [] });
  });

  it('summarises the queue in the header', () => {
    expect(headerMeta([item(), item({ id: 'q2', status: 'conflict' }), item({ id: 'q3' })], t)).toBe('3 archives · 2 ready');
    expect(headerMeta([item({ status: 'done' })], t)).toBe('1 archive · 0 ready');
  });

  it('reads naturally in Italian', async () => {
    await i18n.changeLanguage('it');
    try {
      expect(headerMeta([item(), item({ id: 'q2', status: 'error' })], i18n.t)).toBe('2 archivi · 1 pronto');
      expect(detailsNote(item({ files: files(6), textureCount: 2, blkOk: true }), i18n.t)).toBe('6 file · 2 texture · skin.blk ok');
      expect(stepsView('verify', 80, i18n.t).now).toBe('Verifica 80%');
      // Error rows keep only the backend's English message: known ones read in Italian.
      expect(rowLine(item({ status: 'error', error: 'Not a skin folder or archive' }), i18n.t, '').note).toBe(
        'Non è una cartella di skin né un archivio',
      );
      expect(rowLine(item({ status: 'error', error: 'Qualcosa è andato storto.' }), i18n.t, '').note).toBe('Qualcosa è andato storto.');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
