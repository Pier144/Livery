import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fadeOutSkins, markArriving, useHangarMotion } from '@/store/hangarMotion';
import { motionAllowed, play, useJustEntered, useLeaving, useLeavingList } from './motion';

const root = document.documentElement;

/** Motion allowed by Settings → Reduce motion: Off (jsdom has no matchMedia). */
const allowMotion = () => {
  root.dataset.reduceMotion = 'false';
};

afterEach(() => {
  delete root.dataset.reduceMotion;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useHangarMotion.setState({ leaving: new Set(), arriving: new Set() });
});

describe('motionAllowed', () => {
  it('follows Settings first, then the OS preference; never without matchMedia', () => {
    expect(motionAllowed()).toBe(false);
    root.dataset.reduceMotion = 'false';
    expect(motionAllowed()).toBe(true);
    root.dataset.reduceMotion = 'true';
    expect(motionAllowed()).toBe(false);
    delete root.dataset.reduceMotion;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(motionAllowed()).toBe(true);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(motionAllowed()).toBe(false);
  });
});

describe('play', () => {
  it('animates only when motion is allowed and the API exists', () => {
    const el = document.createElement('div');
    const animate = vi.fn();
    Object.assign(el, { animate });
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
    expect(animate).not.toHaveBeenCalled();
    allowMotion();
    play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
    expect(animate).toHaveBeenCalledOnce();
    expect(() => play(document.createElement('span'), [], {})).not.toThrow();
    expect(() => play(null, [], {})).not.toThrow();
  });
});

describe('useLeaving', () => {
  it('drops the value at once with motion reduced', () => {
    const { result, rerender } = renderHook(({ v }) => useLeaving(v, 120), { initialProps: { v: 'a' as string | null } });
    expect(result.current).toEqual({ value: 'a', leaving: false });
    rerender({ v: null });
    expect(result.current).toEqual({ value: null, leaving: false });
  });

  it('keeps the last value for the exit, and a new value replaces it', () => {
    vi.useFakeTimers();
    allowMotion();
    const { result, rerender } = renderHook(({ v }) => useLeaving(v, 120), { initialProps: { v: 'a' as string | null } });
    rerender({ v: null });
    expect(result.current).toEqual({ value: 'a', leaving: true });
    act(() => vi.advanceTimersByTime(119));
    expect(result.current.leaving).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ value: null, leaving: false });
    rerender({ v: 'b' });
    rerender({ v: null });
    rerender({ v: 'c' });
    expect(result.current).toEqual({ value: 'c', leaving: false });
  });
});

describe('useLeavingList', () => {
  const list = (...ids: number[]) => ids.map((id) => ({ id }));

  it('keeps removed items in their place while they leave', () => {
    vi.useFakeTimers();
    allowMotion();
    const { result, rerender } = renderHook(({ items }) => useLeavingList(items, 160), { initialProps: { items: list(1, 2, 3) } });
    rerender({ items: list(1, 3, 4) });
    expect(result.current.map((x) => [x.item.id, x.leaving])).toEqual([
      [1, false],
      [2, true],
      [3, false],
      [4, false],
    ]);
    act(() => vi.advanceTimersByTime(160));
    expect(result.current.map((x) => x.item.id)).toEqual([1, 3, 4]);
  });

  it('drops removed items at once with motion reduced', () => {
    const { result, rerender } = renderHook(({ items }) => useLeavingList(items, 160), { initialProps: { items: list(1, 2) } });
    rerender({ items: list(2) });
    expect(result.current).toEqual([{ item: { id: 2 }, leaving: false }]);
  });
});

describe('useJustEntered', () => {
  it('is true only when the state is reached after mount', () => {
    const { result, rerender } = renderHook(({ on }) => useJustEntered(on), { initialProps: { on: true } });
    expect(result.current).toBe(false);
    rerender({ on: false });
    expect(result.current).toBe(false);
    rerender({ on: true });
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});

describe('hangar card motion', () => {
  it('fades out only when motion is allowed, and an Undo brings the card back in', async () => {
    await fadeOutSkins(['h1']);
    expect(useHangarMotion.getState().leaving.size).toBe(0);
    vi.useFakeTimers();
    allowMotion();
    const done = fadeOutSkins(['h1']);
    expect(useHangarMotion.getState().leaving.has('h1')).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(160);
      await done;
    });
    markArriving(['h1']);
    expect(useHangarMotion.getState()).toMatchObject({ leaving: new Set(), arriving: new Set(['h1']) });
    act(() => vi.advanceTimersByTime(600));
    expect(useHangarMotion.getState().arriving.size).toBe(0);
  });
});
