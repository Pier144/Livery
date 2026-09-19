import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/en.json';
import { resetStores } from '@/test/render';
import type { AppError, InstallProgress, QueueItem, Vehicle } from '@/types';
import { selectPendingCount, selectReadyCount, useQueue } from './queue';
import { useToasts } from './toasts';

type Args = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string, args?: Record<string, unknown>) => backend.call(cmd, args),
}));

const TIGER: Vehicle = { code: 'germ_pzkpfw_VI_ausf_b_tiger_IIH', name: 'Tiger II (H)', nation: 'GER', type: 'ground', class: '' };
const SU27: Vehicle = { code: 'su_27', name: 'Su-27', nation: 'USSR', type: 'air', class: '' };

const item = (id: string, extra: Partial<QueueItem> = {}): QueueItem => ({
  id,
  path: `C:\\Downloads\\${id}.zip`,
  fileName: `${id}.zip`,
  sizeBytes: 1024,
  status: 'ready',
  vehicle: TIGER,
  ...extra,
});

const NOT_A_SKIN: AppError = { code: 'invalidInput', message: 'Not a skin folder or archive' };

/** Analysis results by path; a missing path is "not a skin". */
let analyses: Record<string, QueueItem | AppError>;
/** Deferred analysis replies (resolve by hand). */
let deferred: Record<string, (value: QueueItem) => void>;
let installReply: (args: Args) => unknown;

const calls = (cmd: string) => backend.call.mock.calls.filter(([c]) => c === cmd).map(([, args]) => args);
const messages = () => useToasts.getState().toasts.map((t) => t.message);
const q = () => useQueue.getState();

beforeEach(() => {
  resetStores();
  useQueue.setState({ installs: {}, picked: {}, batchRunning: false });
  backend.call.mockReset();
  analyses = {};
  deferred = {};
  installReply = (args) => ({ installId: `i-${String(args.queueId)}` });
  backend.call.mockImplementation(async (cmd: string, args: Args = {}) => {
    switch (cmd) {
      case 'analyze_archive': {
        const path = args.path as string;
        if (path in deferred) return new Promise((resolve) => (deferred[path] = resolve));
        const r = analyses[path];
        if (!r) throw NOT_A_SKIN;
        if ('code' in r) throw r;
        return r;
      }
      case 'install_from_archive':
        return installReply(args);
      case 'remove_queue_item':
        return null;
      default:
        throw { code: 'noBackend', message: `unexpected ${cmd}` };
    }
  });
});

describe('queue store — adding paths', () => {
  it('adds analyzing placeholders at once (newest first), then swaps in the analysis by backend id', async () => {
    analyses['C:\\Downloads\\tiger.zip'] = item('q1', { path: 'C:\\Downloads\\tiger.zip', fileName: 'tiger.zip' });
    analyses['D:\\Skins\\Su-27 camo\\'] = item('q2', { path: 'D:\\Skins\\Su-27 camo', fileName: 'Su-27 camo', status: 'needsLook', vehicle: undefined });

    q().addPaths(['C:\\Downloads\\old.zip']);
    const added = q().addPaths(['C:\\Downloads\\tiger.zip', 'D:\\Skins\\Su-27 camo\\', 'C:\\Downloads\\tiger.zip']);

    // Synchronous: one placeholder per distinct path, folders named without the trailing separator.
    expect(added.map((i) => [i.fileName, i.status])).toEqual([
      ['tiger.zip', 'analyzing'],
      ['Su-27 camo', 'analyzing'],
    ]);
    expect(q().items.map((i) => i.fileName)).toEqual(['tiger.zip', 'Su-27 camo', 'old.zip']);
    expect(added.every((i) => i.id.startsWith('p-'))).toBe(true);

    await waitFor(() => expect(q().items.map((i) => i.id)).toEqual(['q1', 'q2']));
    expect(q().items.map((i) => i.status)).toEqual(['ready', 'needsLook']);
    expect(calls('analyze_archive')).toEqual([
      { path: 'C:\\Downloads\\old.zip' },
      { path: 'C:\\Downloads\\tiger.zip' },
      { path: 'D:\\Skins\\Su-27 camo\\' },
    ]);
  });

  it('drops paths that are not skins with a single toast for the whole drop', async () => {
    analyses['a.zip'] = item('qa', { path: 'a.zip', fileName: 'a.zip' });
    q().addPaths(['notes.txt', 'a.zip', 'preview.png']);
    await waitFor(() => expect(q().items.map((i) => i.id)).toEqual(['qa']));
    expect(messages()).toEqual(['2 items aren’t skin archives or folders']);

    useToasts.getState().clear();
    q().addPaths(['C:\\Downloads\\readme.txt']);
    await waitFor(() => expect(messages()).toEqual(['“readme.txt” isn’t a skin archive or folder']));
    expect(q().items.map((i) => i.id)).toEqual(['qa']);
  });

  it('turns other analysis failures into error rows with the backend message', async () => {
    analyses['C:\\gone.zip'] = { code: 'io', message: 'The file can’t be read' };
    const [p] = q().addPaths(['C:\\gone.zip']);
    await waitFor(() => expect(q().items[0]).toMatchObject({ id: p!.id, status: 'error', error: 'The file can’t be read' }));
    expect(messages()).toEqual([]);
  });

  it('keeps unsupported archives as error rows (the backend returns them as items)', async () => {
    analyses['x.7z'] = item('q7', { path: 'x.7z', fileName: 'x.7z', status: 'error', vehicle: undefined, error: '7z archives can be unpacked once their library is approved.' });
    q().addPaths(['x.7z']);
    await waitFor(() => expect(q().items).toEqual([analyses['x.7z']]));
  });

  it('forgets an analysis whose placeholder was removed, here and in the backend', async () => {
    deferred['late.zip'] = () => {};
    const [p] = q().addPaths(['late.zip']);
    await waitFor(() => expect(calls('analyze_archive')).toHaveLength(1));
    q().remove(p!.id);
    expect(q().items).toEqual([]);
    expect(calls('remove_queue_item')).toEqual([]);
    deferred['late.zip']!(item('q-late'));
    await waitFor(() => expect(calls('remove_queue_item')).toEqual([{ queueId: 'q-late' }]));
    expect(q().items).toEqual([]);
  });

  it('keeps one row when the backend answers with an id already in the queue', async () => {
    useQueue.setState({ items: [item('q1', { status: 'done' })] });
    analyses['C:\\Downloads\\q1.zip'] = item('q1');
    q().addPaths(['C:\\Downloads\\q1.zip']);
    await waitFor(() => expect(q().items).toHaveLength(1));
    // An installed row is not regressed to ready by a re-analysis.
    expect(q().items[0]).toMatchObject({ id: 'q1', status: 'done' });
  });

  it('upserts by id and hydrates only unknown items', () => {
    q().upsert(item('q1'));
    q().upsert(item('q1', { status: 'conflict' }));
    q().upsert(item('q2'));
    expect(q().items.map((i) => [i.id, i.status])).toEqual([
      ['q2', 'ready'],
      ['q1', 'conflict'],
    ]);
    q().hydrate([item('q1'), item('q3')]);
    expect(q().items.map((i) => [i.id, i.status])).toEqual([
      ['q2', 'ready'],
      ['q1', 'conflict'],
      ['q3', 'ready'],
    ]);
  });

  it('counts pending (not installed) and ready items', () => {
    useQueue.setState({ items: [item('a'), item('b', { status: 'done' }), item('c', { status: 'error' })] });
    expect(selectPendingCount(q())).toBe(2);
    expect(selectReadyCount(q())).toBe(1);
  });
});

describe('queue store — installing', () => {
  const progress = (queueId: string, step: InstallProgress['step'], pct: number, extra: Partial<InstallProgress> = {}) =>
    q().applyProgress({ installId: `i-${queueId}`, queueId, step, pct, ...extra });

  it('shows progress at once, then follows the events to Installed', async () => {
    useQueue.setState({ items: [item('q1')] });
    const started = q().install('q1');
    expect(q().items[0]!.status).toBe('installing');
    expect(q().installs.q1).toMatchObject({ step: 'extract', pct: 0 });
    expect(await started).toBe(true);
    expect(calls('install_from_archive')).toEqual([{ queueId: 'q1' }]);
    expect(q().installs.q1?.installId).toBe('i-q1');

    expect(progress('q1', 'extract', 56)).toEqual({ kind: 'progress' });
    expect(q().installs.q1).toMatchObject({ step: 'extract', pct: 56 });
    const done = progress('q1', 'done', 100, { skinId: 's9' });
    expect(done).toMatchObject({ kind: 'done', item: { id: 'q1', status: 'done' } });
    expect(q().items[0]!.status).toBe('done');
    expect(q().installs.q1).toBeUndefined();
  });

  it('finds the queue item by install id when the event carries none', async () => {
    useQueue.setState({ items: [item('q1')] });
    await q().install('q1');
    q().applyProgress({ installId: 'i-q1', step: 'verify', pct: 80 });
    expect(q().installs.q1).toMatchObject({ step: 'verify', pct: 80 });
    expect(q().applyProgress({ installId: 'nope', step: 'done', pct: 100 })).toMatchObject({ kind: 'unknown' });
  });

  it('marks a failed install as an error with the event message', async () => {
    useQueue.setState({ items: [item('q1')] });
    await q().install('q1');
    progress('q1', 'error', 40, { message: 'Disk full' });
    expect(q().items[0]).toMatchObject({ status: 'error', error: 'Disk full' });
  });

  it('turns a conflict refusal into a conflict row (and opens the dialog for single installs)', async () => {
    installReply = () => {
      throw { code: 'conflict', message: 'Same folder' };
    };
    useQueue.setState({ items: [item('q1'), item('q2')] });
    expect(await q().install('q1')).toBe(false);
    expect(q().items[0]!.status).toBe('conflict');
    expect(q().conflictDialogId).toBeNull();
    expect(await q().install('q2', { openDialogOnConflict: true })).toBe(false);
    expect(q().conflictDialogId).toBe('q2');
    expect(q().installs).toEqual({});
  });

  it('turns any other refusal into an error row', async () => {
    installReply = () => {
      throw { code: 'io', message: 'UserSkins is read-only' };
    };
    useQueue.setState({ items: [item('q1')] });
    await q().install('q1');
    expect(q().items[0]).toMatchObject({ status: 'error', error: 'UserSkins is read-only' });
  });

  it('resolves a conflict with the choice, remembering the picked vehicle', async () => {
    useQueue.setState({ items: [item('q1', { status: 'needsLook', vehicle: undefined, candidates: [TIGER, SU27] })] });
    installReply = () => {
      throw { code: 'conflict', message: 'Same folder' };
    };
    await q().pickVehicle('q1', 'su_27');
    expect(q().items[0]).toMatchObject({ status: 'conflict', vehicle: SU27 });
    expect(q().conflictDialogId).toBe('q1');

    installReply = (args) => ({ installId: `i-${String(args.queueId)}` });
    await q().resolve('q1', 'copy');
    expect(q().conflictDialogId).toBeNull();
    expect(calls('install_from_archive')).toEqual([
      { queueId: 'q1', vehicleCode: 'su_27' },
      { queueId: 'q1', vehicleCode: 'su_27', conflict: 'copy' },
    ]);
    expect(q().installs.q1).toMatchObject({ conflict: 'copy' });
  });

  it('skip leaves the queue with a toast once, whether the reply or the event comes first', async () => {
    useQueue.setState({ items: [item('q1', { status: 'conflict' }), item('q2', { status: 'conflict' })] });
    await q().resolve('q1', 'skip');
    expect(q().items.map((i) => i.id)).toEqual(['q2']);
    expect(messages()).toEqual([en.queue.toast.skipped]);

    // The backend reports the skip as done before its reply arrives.
    installReply = (args) => {
      expect(progress(String(args.queueId), 'done', 100)).toMatchObject({ kind: 'skipped' });
      return { installId: 'i-q2' };
    };
    await q().resolve('q2', 'skip');
    expect(q().items).toEqual([]);
    expect(messages()).toEqual([en.queue.toast.skipped, en.queue.toast.skipped]);
  });

  it('removes and clears installed rows here and in the backend, never an installing one', async () => {
    useQueue.setState({ items: [item('q1', { status: 'done' }), item('q2', { status: 'installing' }), item('q3', { status: 'done' })] });
    q().remove('q2');
    expect(q().items).toHaveLength(3);
    q().clearDone();
    expect(q().items.map((i) => i.id)).toEqual(['q2']);
    expect(calls('remove_queue_item')).toEqual([{ queueId: 'q1' }, { queueId: 'q3' }]);
  });

  it('installs every ready item one after the other, then toasts once', async () => {
    useQueue.setState({ items: [item('q1'), item('q2', { status: 'conflict' }), item('q3')] });
    const run = q().installReady();
    await waitFor(() => expect(calls('install_from_archive')).toEqual([{ queueId: 'q1' }]));
    expect(q().batchRunning).toBe(true);
    expect(q().installs.q1).toMatchObject({ batch: true });

    // The second install waits for the first to finish.
    await new Promise((r) => setTimeout(r, 10));
    expect(calls('install_from_archive')).toHaveLength(1);
    progress('q1', 'done', 100);
    await waitFor(() => expect(calls('install_from_archive')).toEqual([{ queueId: 'q1' }, { queueId: 'q3' }]));
    progress('q3', 'done', 100);
    await run;

    expect(q().batchRunning).toBe(false);
    expect(q().items.map((i) => i.status)).toEqual(['done', 'conflict', 'done']);
    expect(messages()).toEqual(['Installed 2 skins']);
  });

  it('keeps going after a failed item and does not count it', async () => {
    useQueue.setState({ items: [item('q1'), item('q2')] });
    const run = q().installReady();
    await waitFor(() => expect(calls('install_from_archive')).toHaveLength(1));
    progress('q1', 'error', 10, { message: 'Broken' });
    await waitFor(() => expect(calls('install_from_archive')).toHaveLength(2));
    progress('q2', 'done', 100);
    await run;
    expect(messages()).toEqual(['Installed 1 skin']);
  });
});
