import { act, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import { renderWithProviders as render, resetStores } from '@/test/render';
import { useZoom } from './useZoom';

function Harness() {
  useZoom();
  return <div data-testid="box" />;
}

const wheel = (deltaY: number, init: WheelEventInit = {}) => fireEvent.wheel(window, { deltaY, ctrlKey: true, ...init });

describe('useZoom', () => {
  beforeEach(() => resetStores());
  afterEach(() => {
    document.documentElement.style.zoom = '';
  });

  it('applies the stored size and follows changes', () => {
    useUi.setState({ zoom: 1.25 });
    render(<Harness />);
    expect(document.documentElement.style.zoom).toBe('1.25');
    act(() => useUi.getState().setZoom(1));
    expect(document.documentElement.style.zoom).toBe('');
  });

  it('Ctrl+wheel steps once per notch (up = larger) and says the new size', () => {
    render(<Harness />);
    wheel(-100);
    expect(useUi.getState().zoom).toBe(1.1);
    wheel(100);
    expect(useUi.getState().zoom).toBe(1);
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['Interface size 100%']);
    // Without Ctrl the wheel scrolls as usual.
    fireEvent.wheel(window, { deltaY: -100 });
    expect(useUi.getState().zoom).toBe(1);
  });

  it('leaves a Ctrl+wheel a screen already handled (Refine edge, the Atelier view)', () => {
    const { getByTestId } = render(<Harness />);
    const box = getByTestId('box');
    box.addEventListener('wheel', (e) => e.preventDefault());
    fireEvent.wheel(box, { deltaY: -100, ctrlKey: true });
    expect(useUi.getState().zoom).toBe(1);
  });
});
