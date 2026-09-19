import { describe, expect, it } from 'vitest';
import type { DetectEvent, GameDetection, HangarSkin, Vehicle } from '@/types';
import {
  INITIAL_FIRST_RUN,
  firstRunReducer,
  initialFirstRun,
  importSummary,
  importTag,
  rowState,
  shortVersion,
  stepIndex,
  type FirstRunAction,
  type FirstRunState,
} from './firstRunMachine';

const run = (actions: FirstRunAction[], from: FirstRunState = INITIAL_FIRST_RUN) => actions.reduce(firstRunReducer, from);
const ev = (source: DetectEvent['source'], state: DetectEvent['state']): FirstRunAction => ({
  type: 'detectEvent',
  event: { source, state },
});
const ticks = (n: number): FirstRunAction[] => Array.from({ length: n }, () => ({ type: 'tick' }));
const rows = (s: FirstRunState) => [rowState(s, 'steam'), rowState(s, 'standalone'), rowState(s, 'custom')];

const STEAM: GameDetection = {
  found: true,
  source: 'steam',
  path: 'D:\\SteamLibrary\\steamapps\\common\\War Thunder',
  version: '2.59.0.13',
  existingSkins: 3,
};
const NONE: GameDetection = { found: false, existingSkins: 0 };

/** Detection that answers at once: all events plus the reply. */
const detectedSteam = run([ev('steam', 'checking'), ev('steam', 'found'), ev('standalone', 'notFound'), ev('custom', 'skipped'), { type: 'detectDone', detection: STEAM }]);
const detectedNone = run([ev('steam', 'notFound'), ev('standalone', 'notFound'), ev('custom', 'skipped'), { type: 'detectDone', detection: NONE }]);
/** Enough ticks to reach 100 % and settle. */
const ALL = 40;

describe('detection pacing', () => {
  it('starts on Detect with Steam checking and the rest queued', () => {
    expect(INITIAL_FIRST_RUN.step).toBe('detect');
    expect(rows(INITIAL_FIRST_RUN)).toEqual(['checking', 'queued', 'queued']);
  });

  it('reveals results at ~30 %, ~70 % and 100 % even when they arrive at once', () => {
    let s = detectedSteam;
    expect(rows(s)).toEqual(['checking', 'queued', 'queued']);
    s = run(ticks(7), s); // 28 %
    expect(s.progress).toBe(28);
    expect(rows(s)).toEqual(['checking', 'queued', 'queued']);
    s = run(ticks(1), s); // 32 %
    expect(rows(s)).toEqual(['found', 'checking', 'queued']);
    s = run(ticks(10), s); // 72 %
    expect(rows(s)).toEqual(['found', 'notFound', 'skipped']);
    s = run(ticks(7), s);
    expect(s.progress).toBe(100);
    expect(s.step).toBe('detect');
  });

  it('waits for Steam before revealing later rows, even when those are known', () => {
    const s = run([ev('custom', 'skipped'), ...ticks(18)]);
    expect(s.progress).toBe(29);
    expect(rows(s)).toEqual(['checking', 'queued', 'queued']);
  });

  it('holds before a row whose result has not arrived yet', () => {
    let s = run(ticks(20));
    expect(s.progress).toBe(29);
    expect(rowState(s, 'steam')).toBe('checking');
    s = run([ev('steam', 'notFound'), ...ticks(20)], s);
    expect(s.progress).toBe(69);
    expect(rows(s)).toEqual(['notFound', 'checking', 'queued']);
    s = run([ev('standalone', 'notFound'), ev('custom', 'notFound'), ...ticks(20)], s);
    expect(s.progress).toBe(99); // still waiting for the reply
    expect(s.step).toBe('detect');
    s = run([{ type: 'detectDone', detection: NONE }, ...ticks(ALL)], s);
    expect(s.step).toBe('confirm');
  });

  it('never lets a late "checking" hide a known result', () => {
    const s = run([ev('steam', 'found'), ev('steam', 'checking')]);
    expect(s.results.steam).toBe('found');
  });

  it('fills sources whose final event never arrived from the reply', () => {
    const s = run([ev('steam', 'checking'), { type: 'detectDone', detection: STEAM }]);
    expect(s.results).toEqual({ steam: 'found', standalone: 'notFound', custom: 'skipped' });
  });

  it('treats a failed detection as nothing found', () => {
    const s = run([{ type: 'detectFailed' }, ...ticks(ALL)]);
    expect(s.detection).toEqual(NONE);
    expect(s.step).toBe('confirm');
    expect(s.view).toBe('notFound');
  });

  it('stays at 100 % for a moment, then auto-advances to the found view', () => {
    let s = run(ticks(25), detectedSteam);
    expect(s.progress).toBe(100);
    s = run(ticks(4), s);
    expect(s.step).toBe('detect');
    s = run(ticks(1), s);
    expect(s).toMatchObject({ step: 'confirm', view: 'found', detection: STEAM });
  });

  it('auto-advances to the not-found view when nothing was found', () => {
    expect(run(ticks(ALL), detectedNone)).toMatchObject({ step: 'confirm', view: 'notFound' });
  });

  it('ignores detection actions and ticks outside Detect', () => {
    const confirm = run(ticks(ALL), detectedSteam);
    expect(run([ev('steam', 'notFound'), { type: 'detectDone', detection: NONE }, { type: 'detectFailed' }, ...ticks(3)], confirm)).toBe(confirm);
  });

  it('a new detection resets everything and bumps the run id', () => {
    const confirm = run([...ticks(ALL), { type: 'togglePath' }], detectedSteam);
    const again = firstRunReducer(confirm, { type: 'detectStart' });
    expect(again).toEqual({ ...INITIAL_FIRST_RUN, runId: confirm.runId + 1 });
  });
});

describe('confirm', () => {
  const found = run(ticks(ALL), detectedSteam);
  const notFound = run(ticks(ALL), detectedNone);

  it('toggles the path', () => {
    expect(run([{ type: 'togglePath' }], found).showPath).toBe(true);
    expect(run([{ type: 'togglePath' }, { type: 'togglePath' }], found).showPath).toBe(false);
  });

  it('"Choose another folder" opens the not-found view and "Back" returns to the found install', () => {
    const other = run([{ type: 'chooseAnother' }], found);
    expect(other).toMatchObject({ step: 'confirm', view: 'notFound' });
    expect(run([{ type: 'back' }], other)).toMatchObject({ step: 'confirm', view: 'found', detection: STEAM });
  });

  it('"Back" re-runs detection when nothing was found', () => {
    const again = run([{ type: 'back' }], notFound);
    expect(again).toMatchObject({ step: 'detect', progress: 0, detection: null, runId: notFound.runId + 1 });
  });

  it('"Back" does nothing on the found view', () => {
    expect(run([{ type: 'back' }], found)).toBe(found);
  });

  it('flags an invalid folder and clears the flag on the next attempt or view change', () => {
    const invalid = run([{ type: 'folderInvalid' }], notFound);
    expect(invalid.invalidFolder).toBe(true);
    expect(run([{ type: 'folderSubmitted' }], invalid).invalidFolder).toBe(false);
    const other = run([{ type: 'chooseAnother' }, { type: 'folderInvalid' }, { type: 'back' }], found);
    expect(other.invalidFolder).toBe(false);
  });

  it('moves to Import only from Confirm', () => {
    expect(run([{ type: 'toImport' }], found).step).toBe('import');
    expect(run([{ type: 'toImport' }], detectedSteam).step).toBe('detect');
    expect(run([{ type: 'chooseAnother' }], detectedSteam)).toBe(detectedSteam);
  });
});

describe('helpers', () => {
  it('maps steps to tracker indexes', () => {
    expect([stepIndex('detect'), stepIndex('confirm'), stepIndex('import')]).toEqual([0, 1, 2]);
  });

  it('shortens the game version to major.minor', () => {
    expect(shortVersion('2.59.0.13')).toBe('2.59');
    expect(shortVersion('2')).toBe('2');
    expect(shortVersion(' ')).toBeUndefined();
    expect(shortVersion(undefined)).toBeUndefined();
  });

  const vehicle = (code: string): Vehicle => ({ code, name: code, nation: 'USSR', type: 'ground', class: 'Medium tank' });
  const skin = (id: string, code: string, extra: Partial<HangarSkin> = {}): HangarSkin => ({
    id,
    folder: id,
    name: id,
    vehicle: vehicle(code),
    origin: 'imported',
    sizeBytes: 1,
    active: true,
    installedAt: '2026-09-19T00:00:00Z',
    ...extra,
  });

  it('summarises skins, distinct vehicles and skins needing attention', () => {
    const skins = [
      skin('a', 'ussr_t_34_85_d_5t'),
      skin('b', 'ussr_t_34_85_d_5t', { attention: [{ kind: 'noBlk', message: 'no blk' }] }),
      skin('c', 'germ_pzkpfw_VI_ausf_e_tiger', { attention: [] }),
    ];
    expect(importSummary(skins)).toEqual({ skins: 3, vehicles: 2, attention: 1 });
    expect(importSummary([])).toEqual({ skins: 0, vehicles: 0, attention: 0 });
  });

  it('tags attention first, then skins the user made, else ok', () => {
    const attention = [{ kind: 'missingTexture' as const, message: 'x', file: 'x.dds' }];
    expect(importTag(skin('a', 'v', { origin: 'mine', attention }))).toBe('attention');
    expect(importTag(skin('b', 'v', { origin: 'mine' }))).toBe('mine');
    expect(importTag(skin('c', 'v', { attention: [] }))).toBe('ok');
  });
});

describe('entry (Settings → Game → Change)', () => {
  it('starts the onboarding on Detect', () => {
    expect(initialFirstRun('detect')).toBe(INITIAL_FIRST_RUN);
  });

  it('starts a choose entry on the not-found view, without detecting', () => {
    const s = initialFirstRun('choose');
    expect(s).toMatchObject({ step: 'confirm', view: 'notFound', runId: 0, detection: null });
    expect(stepIndex(s.step)).toBe(1);
    // Ticks and late detection answers change nothing there.
    expect(run([...ticks(ALL), { type: 'detectDone', detection: STEAM }], s)).toEqual(s);
  });

  // The screen shows "Back to Settings" instead of "Back" on a choose entry; the reducer itself
  // still treats a not-found view without a detection like the onboarding's.
  it('"Back" with no detection yet looks for the game, then offers what it found', () => {
    let s = run([{ type: 'back' }], initialFirstRun('choose'));
    expect(s).toMatchObject({ step: 'detect', runId: 1, progress: 0 });
    s = run([ev('steam', 'found'), ev('standalone', 'notFound'), ev('custom', 'skipped'), { type: 'detectDone', detection: STEAM }, ...ticks(ALL)], s);
    expect(s).toMatchObject({ step: 'confirm', view: 'found' });
  });

  it('a folder picked from a choose entry can go on to Import', () => {
    const s = run([{ type: 'folderSubmitted' }, { type: 'toImport' }], initialFirstRun('choose'));
    expect(s.step).toBe('import');
  });
});
