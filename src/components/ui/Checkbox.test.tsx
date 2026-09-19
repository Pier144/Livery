import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { Checkbox } from './Checkbox';

function Harness({ stopPropagation, onToggle }: { stopPropagation?: boolean; onToggle?: (v: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <Checkbox
      label="Select Tiger camo"
      checked={checked}
      stopPropagation={stopPropagation}
      onChange={(next) => {
        onToggle?.(next);
        setChecked(next);
      }}
    />
  );
}

const box = () => screen.getByRole('checkbox', { name: 'Select Tiger camo' });

describe('Checkbox', () => {
  beforeEach(() => resetStores());

  it('is an 18px unchecked box named by its label', () => {
    renderWithProviders(<Harness />);
    expect(box()).toHaveAttribute('aria-checked', 'false');
    expect(box()).toHaveClass('h-4.5', 'w-4.5', 'rounded-menu', 'border', 'border-ink-5', 'bg-transparent');
    expect(box().querySelector('svg')).toBeNull();
  });

  it('a click checks: amber fill with an on-amber check, and unchecks again', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithProviders(<Harness onToggle={onToggle} />);
    await user.click(box());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(box()).toHaveAttribute('aria-checked', 'true');
    expect(box()).toHaveClass('bg-amber', 'border-amber', 'text-onAmber');
    expect(box().querySelector('svg')).not.toBeNull();
    await user.click(box());
    expect(onToggle).toHaveBeenLastCalledWith(false);
    expect(box()).toHaveAttribute('aria-checked', 'false');
  });

  it('Space toggles, Enter does not', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    box().focus();
    await user.keyboard(' ');
    expect(box()).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Enter}');
    expect(box()).toHaveAttribute('aria-checked', 'true');
    await user.keyboard(' ');
    expect(box()).toHaveAttribute('aria-checked', 'false');
  });

  it('passes the click event (Shift for range selection)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Checkbox label="Row" checked={false} onChange={onChange} />);
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('checkbox'));
    await user.keyboard('{/Shift}');
    expect(onChange).toHaveBeenCalledWith(true, expect.objectContaining({ shiftKey: true }));
  });

  it('indeterminate reads as mixed, shows a dash and checks on click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Checkbox label="Select all" checked={false} indeterminate onChange={onChange} />);
    const el = screen.getByRole('checkbox', { name: 'Select all' });
    expect(el).toHaveAttribute('aria-checked', 'mixed');
    expect(el).toHaveClass('bg-amber');
    await user.click(el);
    expect(onChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it('stopPropagation keeps clicks and keys away from a clickable card', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    const onCardKey = vi.fn();
    renderWithProviders(
      <div role="button" tabIndex={0} aria-label="Open skin" onClick={onCardClick} onKeyDown={onCardKey} onKeyUp={onCardKey}>
        <Harness stopPropagation />
      </div>,
    );
    await user.click(box());
    box().focus();
    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    expect(onCardClick).not.toHaveBeenCalled();
    expect(onCardKey).not.toHaveBeenCalled();
    expect(box()).toHaveAttribute('aria-checked', 'false');
  });

  it('without stopPropagation the click bubbles', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    renderWithProviders(
      <div onClick={onCardClick}>
        <Harness />
      </div>,
    );
    await user.click(box());
    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  it('disabled does not toggle', () => {
    const onChange = vi.fn();
    renderWithProviders(<Checkbox label="Locked" checked={false} disabled onChange={onChange} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  it('accepts aria-labelledby instead of a label and forwards its ref', () => {
    const ref = { current: null as HTMLButtonElement | null };
    renderWithProviders(
      <div>
        <span id="lbl">Keep backups</span>
        <Checkbox ref={ref} aria-labelledby="lbl" checked onChange={() => {}} />
      </div>,
    );
    expect(screen.getByRole('checkbox', { name: 'Keep backups' })).toBe(ref.current);
  });

  it('has no serious axe violations (unchecked, checked, mixed)', async () => {
    const { container } = renderWithProviders(
      <div>
        <Checkbox label="A" checked={false} onChange={() => {}} />
        <Checkbox label="B" checked onChange={() => {}} />
        <Checkbox label="C" checked={false} indeterminate onChange={() => {}} />
      </div>,
    );
    expect(await seriousViolations(container)).toEqual([]);
  });
});
