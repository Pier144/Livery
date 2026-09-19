import type { DetectEvent, DetectState, GameDetection, GameSource, HangarSkin } from '@/types';

/**
 * First run flow as a pure reducer: Detect → Confirm (found / not found) → Import.
 * Side effects (backend calls, toasts, navigation) live in `FirstRun.tsx`.
 */

export type FirstRunStep = 'detect' | 'confirm' | 'import';
export type ConfirmView = 'found' | 'notFound';
/** What a detection row shows; `queued` = the paced reveal hasn't reached that row yet. */
export type RowState = 'queued' | DetectState;

export const SOURCES = ['steam', 'standalone', 'custom'] as const satisfies readonly GameSource[];

/**
 * Detection answers in milliseconds, but the rows are revealed over ~1.2 s so the step is readable
 * (as in the prototype): progress at which each row starts "checking…" and at which its result shows.
 */
const ROW_START: Record<GameSource, number> = { steam: 0, standalone: 30, custom: 70 };
const ROW_REVEAL: Record<GameSource, number> = { steam: 30, standalone: 70, custom: 100 };
export const TICK_MS = 48;
const TICK_STEP = 4; // 25 ticks × 48 ms ≈ 1.2 s
/** Ticks the completed list stays on screen before Confirm (~0.25 s). */
const SETTLE_TICKS = 5;

export interface FirstRunState {
  step: FirstRunStep;
  view: ConfirmView;
  /** Bumped on every (re-)detection; `FirstRun` runs `detect_game` whenever it changes. */
  runId: number;
  /** Latest backend state per source, from `game://detect` (revealed by `progress`). */
  results: Partial<Record<GameSource, DetectState>>;
  /** Displayed detection progress, 0–100. */
  progress: number;
  /** Ticks spent at 100 % before advancing. */
  settle: number;
  /** `detect_game` result; null while detection runs. */
  detection: GameDetection | null;
  showPath: boolean;
  /** The last picked/dropped folder was rejected as not War Thunder. */
  invalidFolder: boolean;
}

export type FirstRunAction =
  | { type: 'detectStart' }
  | { type: 'detectEvent'; event: DetectEvent }
  | { type: 'detectDone'; detection: GameDetection }
  | { type: 'detectFailed' }
  | { type: 'tick' }
  | { type: 'togglePath' }
  | { type: 'chooseAnother' }
  | { type: 'back' }
  | { type: 'folderSubmitted' }
  | { type: 'folderInvalid' }
  | { type: 'toImport' };

export const INITIAL_FIRST_RUN: FirstRunState = {
  step: 'detect',
  view: 'found',
  runId: 0,
  results: {},
  progress: 0,
  settle: 0,
  detection: null,
  showPath: false,
  invalidFolder: false,
};

/**
 * Where a run starts: `detect` = the onboarding (Detect first); `choose` = Settings → Game → Change,
 * straight to the folder picker (not-found view) without detecting. The screen offers "Back to
 * Settings" there instead of "Back", so a choose entry never detects.
 */
export function initialFirstRun(step: 'detect' | 'choose'): FirstRunState {
  return step === 'choose' ? { ...INITIAL_FIRST_RUN, step: 'confirm', view: 'notFound', progress: 100 } : INITIAL_FIRST_RUN;
}

const NOT_FOUND: GameDetection = { found: false, existingSkins: 0 };

const isFinal = (s: DetectState | undefined): s is Exclude<DetectState, 'checking'> =>
  s === 'found' || s === 'notFound' || s === 'skipped';

/** Fills sources whose final event never arrived (events and the command reply aren't ordered). */
function settleResults(results: FirstRunState['results'], d: GameDetection): FirstRunState['results'] {
  const out = { ...results };
  for (const source of SOURCES) {
    if (isFinal(out[source])) continue;
    out[source] = d.found && d.source === source ? 'found' : source === 'custom' ? 'skipped' : 'notFound';
  }
  return out;
}

/** Progress may reach a row's reveal point only once that row's result is known, and 100 only with the reply. */
function paceLimit(s: FirstRunState): number {
  let limit = s.detection ? 100 : 99;
  for (const source of SOURCES) {
    if (!isFinal(s.results[source])) limit = Math.min(limit, ROW_REVEAL[source] - 1);
  }
  return limit;
}

export function firstRunReducer(s: FirstRunState, a: FirstRunAction): FirstRunState {
  switch (a.type) {
    case 'detectStart':
      return { ...INITIAL_FIRST_RUN, runId: s.runId + 1 };
    case 'detectEvent': {
      if (s.step !== 'detect') return s;
      const { source, state } = a.event;
      // A late "checking" never hides a result that is already known.
      if (state === 'checking' && isFinal(s.results[source])) return s;
      return { ...s, results: { ...s.results, [source]: state } };
    }
    case 'detectDone':
      if (s.step !== 'detect') return s;
      return { ...s, detection: a.detection, results: settleResults(s.results, a.detection) };
    case 'detectFailed':
      if (s.step !== 'detect') return s;
      return { ...s, detection: NOT_FOUND, results: settleResults(s.results, NOT_FOUND) };
    case 'tick': {
      if (s.step !== 'detect') return s;
      if (s.progress < 100) {
        const progress = Math.min(paceLimit(s), s.progress + TICK_STEP);
        return progress > s.progress ? { ...s, progress } : s;
      }
      if (s.settle + 1 < SETTLE_TICKS) return { ...s, settle: s.settle + 1 };
      // Auto-advance, found or not.
      return { ...s, step: 'confirm', view: s.detection?.found ? 'found' : 'notFound', settle: 0 };
    }
    case 'togglePath':
      return { ...s, showPath: !s.showPath };
    case 'chooseAnother':
      if (s.step !== 'confirm') return s;
      return { ...s, view: 'notFound', invalidFolder: false };
    case 'back':
      if (s.step !== 'confirm' || s.view !== 'notFound') return s;
      // Back to what detection found, or look again when it found nothing.
      return s.detection?.found ? { ...s, view: 'found', invalidFolder: false } : firstRunReducer(s, { type: 'detectStart' });
    case 'folderSubmitted':
      return { ...s, invalidFolder: false };
    case 'folderInvalid':
      return { ...s, invalidFolder: true };
    case 'toImport':
      if (s.step !== 'confirm') return s;
      return { ...s, step: 'import', invalidFolder: false };
  }
}

/** What the detection row for `source` shows at the current paced progress. */
export function rowState(s: FirstRunState, source: GameSource): RowState {
  const result = s.results[source];
  // Nothing to check: shown as soon as the row's turn comes.
  if (result === 'skipped' && s.progress >= ROW_START[source]) return 'skipped';
  if (isFinal(result) && s.progress >= ROW_REVEAL[source]) return result;
  return s.progress >= ROW_START[source] ? 'checking' : 'queued';
}

/** Index in the "01 DETECT · 02 CONFIRM · 03 IMPORT" tracker. */
export function stepIndex(step: FirstRunStep): 0 | 1 | 2 {
  return step === 'detect' ? 0 : step === 'confirm' ? 1 : 2;
}

/** "2.59.0.13" → "2.59" (the game's own major.minor). */
export function shortVersion(version: string | undefined): string | undefined {
  const v = version?.trim();
  if (!v) return undefined;
  return v.split('.').slice(0, 2).join('.');
}

export interface ImportSummary {
  skins: number;
  vehicles: number;
  attention: number;
}

export function importSummary(skins: readonly HangarSkin[]): ImportSummary {
  return {
    skins: skins.length,
    vehicles: new Set(skins.map((s) => s.vehicle.code)).size,
    attention: skins.filter((s) => (s.attention?.length ?? 0) > 0).length,
  };
}

export type ImportTag = 'attention' | 'mine' | 'ok';

/** Right-hand tag of an import row: problems first, then skins the user made (`template_…`). */
export function importTag(skin: HangarSkin): ImportTag {
  if ((skin.attention?.length ?? 0) > 0) return 'attention';
  return skin.origin === 'mine' ? 'mine' : 'ok';
}
