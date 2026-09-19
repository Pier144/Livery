import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LayoutGrid, List } from 'lucide-react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { SegmentedControl, type Segment } from './SegmentedControl';

type VType = 'all' | 'ground' | 'air' | 'heli' | 'naval';
const TYPES: Segment<VType>[] = [
  { value: 'all', label: 'All types' },
  { value: 'ground', label: 'Ground' },
  { value: 'air', label: 'Air' },
  { value: 'heli', label: 'Helicopters' },
  { value: 'naval', label: 'Naval' },
];

function Harness({ options = TYPES, onChange }: { options?: Segment<VType>[]; onChange?: (v: VType) => void }) {
  const [value, setValue] = useState<VType>('all');
  return (
    <div>
      <button type="button">Before</button>
      <SegmentedControl<VType>
        label="Vehicle type"
        value={value}
        options={options}
        onChange={(v) => {
          onChange?.(v);
          setValue(v);
        }}
      />
      <button type="button">After</button>
    </div>
  );
}

const group = () => screen.getByRole('radiogroup', { name: 'Vehicle type' });
const radio = (name: string) => within(group()).getByRole('radio', { name });

describe('SegmentedControl', () => {
  beforeEach(() => resetStores());

  it('renders a named radiogroup with the checked segment highlighted', () => {
    renderWithProviders(<Harness />);
    expect(group()).toHaveClass('h-ctl', 'bg-bg-chip', 'border', 'border-line-3', 'rounded-ctl', 'overflow-hidden');
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(radios[0]).toHaveClass('bg-bg-5', 'text-ink-1', 'px-2.5', 'text-meta');
    expect(radios[0]).not.toHaveClass('border-l');
    expect(radios[1]).toHaveClass('text-ink-3', 'border-l', 'border-line-3');
  });

  it('is a single tab stop on the checked segment (roving tabindex)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    screen.getByRole('button', { name: 'Before' }).focus();
    await user.tab();
    expect(radio('All types')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('arrows move and select with wrap-around; Home/End jump', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    radio('All types').focus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Ground')).toHaveFocus();
    expect(radio('Ground')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Ground')).toHaveAttribute('tabindex', '0');
    expect(onChange).toHaveBeenLastCalledWith('ground');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(radio('Naval')).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith('naval');
    await user.keyboard('{ArrowRight}');
    expect(radio('All types')).toHaveFocus();
    await user.keyboard('{End}');
    expect(radio('Naval')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Home}');
    expect(radio('All types')).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}');
    expect(radio('Ground')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(radio('All types')).toHaveFocus();
  });

  it('a click selects; re-clicking the checked segment does not fire onChange', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    await user.click(radio('Air'));
    expect(onChange).toHaveBeenCalledWith('air');
    expect(radio('Air')).toHaveAttribute('aria-checked', 'true');
    await user.click(radio('Air'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('skips disabled segments', async () => {
    const user = userEvent.setup();
    const options = TYPES.map((o) => (o.value === 'ground' ? { ...o, disabled: true } : o));
    renderWithProviders(<Harness options={options} />);
    radio('All types').focus();
    await user.keyboard('{ArrowRight}');
    expect(radio('Air')).toHaveFocus();
    expect(radio('Ground')).toBeDisabled();
  });

  it('icon-only segments are 34px wide and named by their label', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <SegmentedControl
        label="View"
        value="grid"
        onChange={onChange}
        options={[
          { value: 'grid', label: 'Grid view', icon: LayoutGrid },
          { value: 'list', label: 'List view', icon: List },
        ]}
      />,
    );
    const grid = screen.getByRole('radio', { name: 'Grid view' });
    const list = screen.getByRole('radio', { name: 'List view' });
    expect(grid).toHaveClass('w-[34px]');
    expect(grid).toHaveAttribute('title', 'Grid view');
    expect(grid.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(list).toHaveClass('border-l');
    await user.click(list);
    expect(onChange).toHaveBeenCalledWith('list');
  });

  it('describes the group with aria-describedby when given', () => {
    renderWithProviders(
      <>
        <p id="motion-help">Follows your Windows setting by default.</p>
        <SegmentedControl
          label="Reduce motion"
          value="system"
          onChange={() => {}}
          options={[{ value: 'system', label: 'System' }]}
          aria-describedby="motion-help"
        />
      </>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Reduce motion' })).toHaveAccessibleDescription('Follows your Windows setting by default.');
  });

  it('has no description by default', () => {
    renderWithProviders(<Harness />);
    expect(group()).not.toHaveAttribute('aria-describedby');
  });

  it('has no serious axe violations', async () => {
    const { container } = renderWithProviders(<Harness />);
    expect(await seriousViolations(container)).toEqual([]);
  });
});
