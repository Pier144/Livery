import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_DURATION_MS, toast, useToasts } from '@/store/toasts';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { Toaster } from './Toaster';

const region = () => screen.getByRole('region', { name: 'Notifications' });
/** The toast box that carries the pointer/focus handlers. */
const toastBox = (message: string) => within(region()).getByText(message).parentElement!;
const push = (message: string, onUndo?: () => void) => {
  let id = 0;
  act(() => {
    id = onUndo ? toast.undoable(message, onUndo) : toast(message);
  });
  return id;
};
const renderWithOutsideButton = () =>
  renderWithProviders(
    <>
      <button type="button">Before</button>
      <Toaster />
    </>,
  );

beforeEach(() => resetStores());

describe('Toaster', () => {
  it('renders an empty polite live region before the first toast', () => {
    renderWithProviders(<Toaster />);
    expect(region()).toHaveAttribute('aria-live', 'polite');
    expect(region()).toHaveAttribute('aria-atomic', 'false');
    expect(region()).toBeEmptyDOMElement();
  });

  it('shows a plain toast inside the live region, without Undo', () => {
    renderWithProviders(<Toaster />);
    push('Installed “Desert Storm Tan”');
    expect(within(region()).getByText('Installed “Desert Storm Tan”')).toBeInTheDocument();
    expect(within(region()).queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
    expect(within(region()).getByRole('button', { name: 'Dismiss' })).toHaveAccessibleDescription(
      'Installed “Desert Storm Tan”',
    );
  });

  it('Undo runs the callback once and removes the toast', async () => {
    const user = userEvent.setup();
    const restore = vi.fn();
    renderWithProviders(<Toaster />);
    const id = push('Deleted 3 skins', restore);
    const undo = within(region()).getByRole('button', { name: 'Undo' });
    expect(undo).toHaveAccessibleDescription('Deleted 3 skins');
    await user.click(undo);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(within(region()).queryByText('Deleted 3 skins')).not.toBeInTheDocument();
    // A second undo for the same toast (e.g. a racing double click) is ignored.
    await act(() => useToasts.getState().undo(id));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('× dismisses without undoing', async () => {
    const user = userEvent.setup();
    const restore = vi.fn();
    renderWithProviders(<Toaster />);
    push('Replaced “Winter Camo” · backup kept', restore);
    await user.click(within(region()).getByRole('button', { name: 'Dismiss' }));
    expect(region()).toBeEmptyDOMElement();
    expect(restore).not.toHaveBeenCalled();
  });

  it('hands keyboard focus to the next toast, then back to where it came from', async () => {
    const user = userEvent.setup();
    renderWithOutsideButton();
    push('first');
    push('second');
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    await user.keyboard('{Enter}');
    expect(within(region()).queryByText('first')).not.toBeInTheDocument();
    expect(within(toastBox('second')).getByRole('button', { name: 'Dismiss' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(region()).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('returns focus to where it came from when a focused toast is dropped on overflow', async () => {
    const user = userEvent.setup();
    renderWithOutsideButton();
    push('first');
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(within(toastBox('first')).getByRole('button', { name: 'Dismiss' })).toHaveFocus();
    for (let i = 1; i <= 4; i++) push(`t${i}`);
    expect(within(region()).queryByText('first')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('does not move focus after a mouse click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Toaster />);
    push('first');
    push('second');
    await user.click(within(toastBox('first')).getByRole('button', { name: 'Dismiss' }));
    expect(within(region()).queryByText('first')).not.toBeInTheDocument();
    // Parking focus in the other toast would hold its timer for a mouse user.
    expect(toastBox('second')).not.toContainElement(document.activeElement as HTMLElement);
  });

  it('keeps at most four toasts, dropping the oldest', () => {
    renderWithProviders(<Toaster />);
    for (let i = 1; i <= 6; i++) push(`t${i}`);
    const shown = within(region())
      .getAllByRole('button', { name: 'Dismiss' })
      .map((b) => b.parentElement!.textContent);
    expect(shown).toEqual(['t3', 't4', 't5', 't6']);
  });

  it('keeps the remaining toast nodes when another toast leaves, so they are not re-announced', () => {
    renderWithProviders(<Toaster />);
    const first = push('first');
    push('second');
    const second = toastBox('second');
    act(() => useToasts.getState().dismiss(first));
    expect(toastBox('second')).toBe(second);
  });

  it('has no serious axe violations with toasts visible', async () => {
    const { container } = renderWithProviders(<Toaster />);
    push('Deleted 3 skins', () => {});
    push('Installed “Desert Storm Tan”');
    expect(await seriousViolations(container)).toEqual([]);
  });
});

// user-event awaits a real setTimeout(0) under Vitest fake timers, so these drive DOM events directly.
describe('Toaster expiry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it(`auto-dismisses after ${TOAST_DURATION_MS} ms`, () => {
    renderWithProviders(<Toaster />);
    push('Installed “Desert Storm Tan”');
    advance(TOAST_DURATION_MS - 1);
    expect(within(region()).getByText('Installed “Desert Storm Tan”')).toBeInTheDocument();
    advance(1);
    expect(region()).toBeEmptyDOMElement();
  });

  it('pauses while hovered and resumes with the remaining time on leave', () => {
    renderWithProviders(<Toaster />);
    push('Deleted 3 skins', () => {});
    push('Installed “Desert Storm Tan”');
    advance(2000);
    fireEvent.pointerEnter(toastBox('Deleted 3 skins'));
    advance(TOAST_DURATION_MS * 5);
    expect(within(region()).getByText('Deleted 3 skins')).toBeInTheDocument();
    // Only the hovered toast is held.
    expect(within(region()).queryByText('Installed “Desert Storm Tan”')).not.toBeInTheDocument();
    fireEvent.pointerLeave(toastBox('Deleted 3 skins'));
    advance(TOAST_DURATION_MS - 2000 - 1);
    expect(within(region()).getByText('Deleted 3 skins')).toBeInTheDocument();
    advance(1);
    expect(region()).toBeEmptyDOMElement();
  });

  it('pauses while focus is inside, also when moving between its buttons, and resumes when it leaves', () => {
    renderWithOutsideButton();
    push('Deleted 3 skins', () => {});
    const before = screen.getByRole('button', { name: 'Before' });
    const box = toastBox('Deleted 3 skins');
    act(() => within(box).getByRole('button', { name: 'Undo' }).focus());
    advance(TOAST_DURATION_MS * 2);
    act(() => within(box).getByRole('button', { name: 'Dismiss' }).focus());
    advance(TOAST_DURATION_MS * 2);
    expect(within(region()).getByText('Deleted 3 skins')).toBeInTheDocument();
    act(() => before.focus());
    advance(TOAST_DURATION_MS - 1);
    expect(within(region()).getByText('Deleted 3 skins')).toBeInTheDocument();
    advance(1);
    expect(region()).toBeEmptyDOMElement();
  });

  it('stays paused while either the pointer or focus is still inside', () => {
    renderWithOutsideButton();
    push('Deleted 3 skins', () => {});
    const box = toastBox('Deleted 3 skins');
    fireEvent.pointerEnter(box);
    act(() => within(box).getByRole('button', { name: 'Undo' }).focus());
    fireEvent.pointerLeave(box);
    advance(TOAST_DURATION_MS * 2);
    expect(within(region()).getByText('Deleted 3 skins')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'Before' }).focus());
    advance(TOAST_DURATION_MS);
    expect(region()).toBeEmptyDOMElement();
  });
});
