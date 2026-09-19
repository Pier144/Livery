import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStores } from '@/test/render';
import { TOAST_DURATION_MS, toast, useToasts } from './toasts';

const ids = () => useToasts.getState().toasts.map((t) => t.id);

beforeEach(() => {
  vi.useFakeTimers();
  resetStores();
});
afterEach(() => vi.useRealTimers());

describe('toast pause/resume', () => {
  it('freezes the countdown while paused and resumes with the time left', () => {
    const { pause, resume } = useToasts.getState();
    const id = toast('Installed “Desert Storm Tan”');
    vi.advanceTimersByTime(2000);
    pause(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 10);
    expect(ids()).toEqual([id]);
    resume(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS - 2000 - 1);
    expect(ids()).toEqual([id]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('accumulates elapsed time across several pause/resume cycles', () => {
    const { pause, resume } = useToasts.getState();
    const id = toast('a');
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      pause(id);
      vi.advanceTimersByTime(30_000);
      resume(id);
    }
    vi.advanceTimersByTime(TOAST_DURATION_MS - 5000 - 1);
    expect(ids()).toEqual([id]);
    vi.advanceTimersByTime(1);
    expect(ids()).toEqual([]);
  });

  it('is idempotent: double pause keeps the remaining time, double resume starts one timer', () => {
    const { pause, resume } = useToasts.getState();
    const id = toast('a');
    vi.advanceTimersByTime(1000);
    pause(id);
    vi.advanceTimersByTime(1000);
    pause(id);
    resume(id);
    resume(id);
    // A duplicated timer would still fire after this second pause.
    vi.advanceTimersByTime(1000);
    pause(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    expect(ids()).toEqual([id]);
    resume(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS - 2000);
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only affects the given toast', () => {
    const a = toast('a');
    toast('b');
    useToasts.getState().pause(a);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(ids()).toEqual([a]);
  });

  it('ignores unknown, dismissed and expired ids', () => {
    const { pause, resume } = useToasts.getState();
    const gone = toast('expires');
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    pause(gone);
    resume(gone);
    pause(999);
    resume(999);
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dismissing, overflowing or clearing a paused toast leaves no timer behind', () => {
    const { pause, dismiss, clear } = useToasts.getState();
    const first = toast('first');
    pause(first);
    for (let i = 0; i < 4; i++) toast(`t${i}`);
    expect(ids()).not.toContain(first);
    const last = ids().at(-1)!;
    pause(last);
    dismiss(last);
    useToasts.getState().resume(last);
    expect(ids()).toHaveLength(3);
    pause(ids()[0]!);
    clear();
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('toast undo guards', () => {
  it('runs the callback once even when undo is triggered twice without awaiting', async () => {
    const restore = vi.fn();
    const id = toast.undoable('Deleted 3 skins', restore);
    const { undo } = useToasts.getState();
    await Promise.all([undo(id), undo(id)]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual([]);
  });

  it('does nothing after the toast expired', async () => {
    const restore = vi.fn();
    const id = toast.undoable('Deleted 3 skins', restore);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    await useToasts.getState().undo(id);
    expect(restore).not.toHaveBeenCalled();
  });

  it('does nothing after the toast was dismissed or dropped from the stack', async () => {
    const restore = vi.fn();
    const dismissed = toast.undoable('Replaced “Winter Camo” · backup kept', restore);
    toast.dismiss(dismissed);
    await useToasts.getState().undo(dismissed);
    const dropped = toast.undoable('Deleted 2 skins', restore);
    for (let i = 0; i < 4; i++) toast(`t${i}`);
    await useToasts.getState().undo(dropped);
    expect(restore).not.toHaveBeenCalled();
  });

  it('still works while the toast is paused', async () => {
    const restore = vi.fn();
    const id = toast.undoable('Deleted 3 skins', restore);
    useToasts.getState().pause(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 3);
    await useToasts.getState().undo(id);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('toast onExpire (deferred commit)', () => {
  const setup = () => {
    const undo = vi.fn();
    const commit = vi.fn();
    const id = toast.undoable('Cleared 3 backups', undo, commit);
    return { undo, commit, id };
  };

  it('runs once when the toast times out', () => {
    const { commit, undo } = setup();
    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 3);
    useToasts.getState().clear();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  it('runs once when the toast is dismissed, even if dismissed again', () => {
    const { commit, id } = setup();
    toast.dismiss(id);
    toast.dismiss(id);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('runs once when the toast is pushed out of the full stack', () => {
    const { commit } = setup();
    for (let i = 0; i < 3; i++) toast(`t${i}`);
    expect(commit).not.toHaveBeenCalled();
    toast('the fifth');
    expect(commit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('runs once on clear(), paused or not', () => {
    const { commit, id } = setup();
    useToasts.getState().pause(id);
    useToasts.getState().clear();
    useToasts.getState().clear();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never runs after Undo (button or Ctrl+Z), whatever happens next', async () => {
    const first = setup();
    await useToasts.getState().undo(first.id);
    const second = setup();
    expect(useToasts.getState().undoLatest()).toBe(true);
    await Promise.resolve();
    toast.dismiss(first.id);
    toast.dismiss(second.id);
    vi.advanceTimersByTime(TOAST_DURATION_MS * 2);
    useToasts.getState().clear();
    expect(first.undo).toHaveBeenCalledTimes(1);
    expect(second.undo).toHaveBeenCalledTimes(1);
    expect(first.commit).not.toHaveBeenCalled();
    expect(second.commit).not.toHaveBeenCalled();
  });

  it('keeps the stack working when the callback throws or rejects', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = toast.undoable('a', vi.fn(), () => {
      throw new Error('boom');
    });
    const b = toast.undoable('b', vi.fn(), () => Promise.reject(new Error('later')));
    toast.dismiss(a);
    toast.dismiss(b);
    expect(ids()).toEqual([]);
    await Promise.resolve();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('lets the callback push a toast while the stack changes', () => {
    toast.undoable('Cleared 3 backups', vi.fn(), () => {
      toast('Could not clear the backups');
    });
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Could not clear the backups']);
  });
});
