import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders as render } from '@/test/render';
import type { Vehicle } from '@/types';
import { VehiclePicker, type VehiclePickerProps } from './VehiclePicker';

const LIST: Vehicle[] = [
  { code: 'germ_leopard_2a6', name: 'Leopard 2A6', nation: 'GER', type: 'ground', class: 'MBT' },
  { code: 'germ_leopard_1', name: 'Leopard 1', nation: 'GER', type: 'ground', class: 'MBT' },
  { code: 'germ_leopard_plane', name: 'Leopard Flyer', nation: 'GER', type: 'air', class: 'Fighter' },
  { code: 'us_m4a3e2_sherman_jumbo', name: 'M4A3E2', nation: 'USA', type: 'ground', class: 'Medium' },
];

/** A controlled picker; `onChange` sees every change. */
function Harness({ initial = null, onChange, ...props }: Partial<VehiclePickerProps> & { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <VehiclePicker
      label="Vehicle"
      list={LIST}
      {...props}
      value={value}
      onChange={(code) => {
        setValue(code);
        onChange?.(code);
      }}
    />
  );
}

const input = () => screen.getByRole('combobox', { name: 'Vehicle' });
const options = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('VehiclePicker', () => {
  it('suggests by name or code and picks with the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'leop');
    expect(options()).toEqual(['Leopard 2A6germ_leopard_2a6', 'Leopard 1germ_leopard_1', 'Leopard Flyergerm_leopard_plane']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('germ_leopard_1');
    expect(input()).toHaveValue('Leopard 1');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
  });

  it('`types` leaves other vehicle types out', async () => {
    const user = userEvent.setup();
    render(<Harness types={['ground']} />);
    await user.type(input(), 'leop');
    expect(options()).toEqual(['Leopard 2A6germ_leopard_2a6', 'Leopard 1germ_leopard_1']);
  });

  it('with free text, Enter on an unknown code keeps it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness allowFreeText onChange={onChange} />);
    await user.type(input(), 'xx_secret_tank');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('xx_secret_tank');
  });

  it('without free text, Enter accepts only a highlighted listed vehicle', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'xx_secret_tank');
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await user.tab();
    // Leaving the field puts back the chosen vehicle (none).
    expect(input()).toHaveValue('');

    await user.type(input(), 'jumbo');
    await user.keyboard('{Escape}{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('us_m4a3e2_sherman_jumbo');
  });

  it('shows the chosen vehicle, Escape closes the menu first and then clears', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="germ_leopard_2a6" onChange={onChange} />);
    expect(input()).toHaveValue('Leopard 2A6');
    await user.clear(input());
    await user.type(input(), 'leo');
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Escape}');
    expect(input()).toHaveValue('');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('clicking a suggestion picks it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'sherman');
    await user.click(screen.getByRole('option', { name: /M4A3E2/ }));
    expect(onChange).toHaveBeenLastCalledWith('us_m4a3e2_sherman_jumbo');
  });

  it('takes its name from aria-labelledby and its id for a label', () => {
    render(
      <>
        <span id="lbl">Tank</span>
        <VehiclePicker id="vp" aria-labelledby="lbl" value={null} onChange={() => {}} list={LIST} />
      </>,
    );
    const box = screen.getByRole('combobox', { name: 'Tank' });
    expect(box).toHaveAttribute('id', 'vp');
  });
});
