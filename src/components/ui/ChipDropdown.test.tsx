import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { ChipDropdown, type ChipDropdownProps } from './ChipDropdown';

type Nation = 'GER' | 'USA' | 'USSR';
const OPTIONS = [
  { value: 'GER', label: 'Germany' },
  { value: 'USA', label: 'USA' },
  { value: 'USSR', label: 'USSR' },
] as const;

function Harness({ initial = null, onChange, ...props }: { initial?: Nation | null } & Partial<ChipDropdownProps<Nation>>) {
  const [value, setValue] = useState<Nation | null>(initial);
  return (
    <ChipDropdown<Nation>
      label="Nation"
      options={OPTIONS}
      {...props}
      value={value}
      onChange={(v) => {
        onChange?.(v);
        setValue(v);
      }}
    />
  );
}

const chip = () => screen.getByRole('button', { name: /nation/i });
const radios = () => within(screen.getByRole('menu')).getAllByRole('menuitemradio');

describe('ChipDropdown', () => {
  beforeEach(() => resetStores());

  it('labelValue: shows "Nation Any" unset, with the chip styles and a chevron', () => {
    renderWithProviders(<Harness />);
    expect(chip()).toHaveAccessibleName('Nation Any');
    expect(chip()).toHaveAttribute('aria-haspopup', 'menu');
    expect(chip()).toHaveClass('h-ctl', 'bg-bg-chip', 'border', 'border-line-3', 'hover:border-line-4', 'rounded-ctl', 'px-2.5', 'gap-2', 'text-meta');
    expect(screen.getByText('Any')).toHaveClass('text-ink-3');
    expect(chip().querySelector('svg.text-ink-5')).not.toBeNull();
  });

  it('opens a radio menu with "Any" first and checked, and picking an option sets it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    await user.click(chip());
    expect(screen.getByRole('menu')).toHaveAccessibleName('Nation');
    expect(radios().map((r) => r.textContent)).toEqual(['Any', 'Germany', 'USA', 'USSR']);
    expect(radios()[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios()[0]).toHaveFocus();

    await user.click(screen.getByRole('menuitemradio', { name: 'Germany' }));
    expect(onChange).toHaveBeenLastCalledWith('GER');
    expect(chip()).toHaveAccessibleName('Nation Germany');
    expect(chip()).toHaveClass('border-amber-60');
    expect(chip()).not.toHaveClass('border-line-3');
    expect(screen.getByText('Germany')).toHaveClass('text-amber');
    expect(chip()).toHaveFocus();
  });

  it('opens on the checked option and the "Any" option clears to null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness initial="USA" onChange={onChange} />);
    chip().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'USA' })).toHaveFocus();
    expect(screen.getByRole('menuitemradio', { name: 'USA' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(chip()).toHaveAccessibleName('Nation Any');
    expect(chip()).toHaveClass('border-line-3');
  });

  it('label variant: the label turns into the amber choice, still named for screen readers', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness variant="label" anyLabel="All" />);
    expect(chip()).toHaveAccessibleName('Nation');
    expect(screen.getByText('Nation')).toHaveClass('text-ink-3');

    await user.click(chip());
    expect(radios()[0]).toHaveTextContent('All');
    await user.click(screen.getByRole('menuitemradio', { name: 'USSR' }));
    expect(chip()).toHaveAccessibleName('Nation: USSR');
    expect(screen.getByText('USSR')).toHaveClass('text-amber');
    expect(screen.getByText('Nation:')).toHaveClass('sr-only');
    expect(chip()).toHaveClass('border-amber-60');
  });

  it('a value missing from the options reads as unset', () => {
    renderWithProviders(<ChipDropdown<string> label="Nation" value="ITA" options={OPTIONS} onChange={() => {}} />);
    expect(chip()).toHaveAccessibleName('Nation Any');
  });

  it('uses common.any in Italian', async () => {
    await act(() => i18n.changeLanguage('it'));
    try {
      renderWithProviders(<Harness />);
      expect(chip()).toHaveAccessibleName('Nation Qualsiasi');
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('Escape closes only the menu', async () => {
    const user = userEvent.setup();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      renderWithProviders(<Harness />);
      await user.click(chip());
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(chip()).toHaveFocus();
      expect(onWindowKey).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('has no serious axe violations, closed and open, in both variants', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <div>
        <Harness />
        <Harness variant="label" initial="GER" label="Origin" />
      </div>,
    );
    expect(await seriousViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Nation Any' }));
    expect(await seriousViolations(container)).toEqual([]);
  });
});
