import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { Switch } from './Switch';

function Harness({ onToggle }: { onToggle?: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="Watch Downloads folder"
      checked={on}
      onChange={(next) => {
        onToggle?.(next);
        setOn(next);
      }}
    />
  );
}

const sw = () => screen.getByRole('switch', { name: 'Watch Downloads folder' });
const knob = () => sw().firstElementChild as HTMLElement;

describe('Switch', () => {
  beforeEach(() => resetStores());

  it('is a 34×18 pill, line-3 when off with the knob on the left', () => {
    renderWithProviders(<Harness />);
    expect(sw()).toHaveAttribute('aria-checked', 'false');
    expect(sw()).toHaveClass('h-4.5', 'w-[34px]', 'rounded-pill', 'bg-line-3', 'ring-1', 'ring-inset', 'ring-ink-5');
    expect(knob()).toHaveAttribute('aria-hidden', 'true');
    expect(knob()).toHaveClass('left-0.5', 'top-0.5', 'h-3.5', 'w-3.5', 'bg-onAmber', 'motion-safe:transition-transform', 'motion-safe:duration-150');
    expect(knob()).not.toHaveClass('translate-x-4');
  });

  it('a click turns it on: amber track, knob moved right', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(<Harness onToggle={onToggle} />);
    await user.click(sw());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(sw()).toHaveAttribute('aria-checked', 'true');
    expect(sw()).toHaveClass('bg-amber');
    expect(knob()).toHaveClass('translate-x-4');
  });

  it('Space and Enter toggle from the keyboard', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    sw().focus();
    await user.keyboard(' ');
    expect(sw()).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Enter}');
    expect(sw()).toHaveAttribute('aria-checked', 'false');
  });

  it('disabled does not toggle and is skipped by Tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <div>
        <Switch label="Autostart" checked disabled onChange={onChange} />
        <button type="button">Next</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toBeDisabled();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus();
  });

  it('can be labelled by visible text and described by a helper', () => {
    renderWithProviders(
      <div>
        <span id="l">Install updates automatically</span>
        <span id="h">Checks once a day.</span>
        <Switch aria-labelledby="l" aria-describedby="h" checked={false} onChange={() => {}} />
      </div>,
    );
    expect(screen.getByRole('switch', { name: 'Install updates automatically' })).toHaveAccessibleDescription('Checks once a day.');
  });

  it('has no serious axe violations', async () => {
    const { container } = renderWithProviders(
      <div>
        <Switch label="Off" checked={false} onChange={() => {}} />
        <Switch label="On" checked onChange={() => {}} />
      </div>,
    );
    expect(await seriousViolations(container)).toEqual([]);
  });
});
