import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Search } from 'lucide-react';
import { createRef, useState, type Ref } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { TextInput, type TextInputProps } from './TextInput';

interface HarnessProps extends Partial<TextInputProps> {
  initial?: string;
  onValue?: (v: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}

function Harness({ initial = '', onValue, inputRef, ...props }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <TextInput
      ref={inputRef}
      aria-label="Search hangar"
      placeholder="Search your skins…"
      className="w-[260px]"
      {...props}
      value={value}
      onValueChange={(v) => {
        onValue?.(v);
        setValue(v);
      }}
    />
  );
}

const box = () => screen.getByRole('searchbox', { name: 'Search hangar' });
const clearBtn = () => screen.queryByRole('button', { name: 'Clear' });

describe('TextInput', () => {
  beforeEach(() => resetStores());

  it('is a 28px search field with the token styles and the width on the wrapper', () => {
    renderWithProviders(<Harness />);
    expect(box()).toHaveAttribute('type', 'search');
    expect(box()).toHaveAttribute('placeholder', 'Search your skins…');
    expect(box()).toHaveClass('h-ctl', 'bg-bg-input', 'border', 'border-line-3', 'rounded-ctl', 'pl-2.5', 'text-meta', 'text-ink-1', 'placeholder:text-ink-4', 'w-full');
    expect(box().parentElement).toHaveClass('w-[260px]');
    expect(clearBtn()).not.toBeInTheDocument();
  });

  it('typing reports every value; the clear button appears only while non-empty', async () => {
    const user = userEvent.setup();
    const onValue = vi.fn();
    renderWithProviders(<Harness onValue={onValue} />);
    await user.type(box(), 'tig');
    expect(onValue).toHaveBeenLastCalledWith('tig');
    expect(box()).toHaveValue('tig');
    expect(clearBtn()).toBeInTheDocument();
    expect(box()).toHaveClass('pr-7');

    await user.click(clearBtn() as HTMLElement);
    expect(onValue).toHaveBeenLastCalledWith('');
    expect(box()).toHaveValue('');
    expect(box()).toHaveFocus();
    expect(clearBtn()).not.toBeInTheDocument();
  });

  it('the clear button is reachable with Tab and names itself via common.clear', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    renderWithProviders(<Harness initial="leo" onClear={onClear} />);
    box().focus();
    await user.tab();
    expect(clearBtn()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(box()).toHaveValue('');
    expect(box()).toHaveFocus();
  });

  it('Escape in a non-empty field clears it and goes no further; when empty it bubbles', async () => {
    const user = userEvent.setup();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      renderWithProviders(<Harness initial="leo" />);
      box().focus();
      await user.keyboard('{Escape}');
      expect(box()).toHaveValue('');
      expect(onWindowKey).not.toHaveBeenCalled();
      await user.keyboard('{Escape}');
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it("a caller's onKeyDown that handles Escape wins (e.g. closing an autocomplete)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness initial="leo" onKeyDown={(e) => e.key === 'Escape' && e.preventDefault()} />);
    box().focus();
    await user.keyboard('{Escape}');
    expect(box()).toHaveValue('leo');
  });

  it('a leading icon pads the text', () => {
    const { container } = renderWithProviders(<Harness icon={Search} />);
    expect(box()).toHaveClass('pl-[30px]');
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveClass('text-ink-5');
  });

  it('type=text has no clear button unless asked; forwards its ref', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLInputElement>();
    renderWithProviders(<Harness type="text" aria-label="Name" inputRef={ref} initial="Tank night" />);
    const input = screen.getByRole('textbox', { name: 'Name' });
    expect(ref.current).toBe(input);
    expect(clearBtn()).not.toBeInTheDocument();
    input.focus();
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('Tank night');
  });

  it('disabled fields hide the clear button', () => {
    renderWithProviders(<Harness initial="leo" disabled />);
    expect(box()).toBeDisabled();
    expect(clearBtn()).not.toBeInTheDocument();
  });

  it('the clear label is translated', async () => {
    await act(() => i18n.changeLanguage('it'));
    try {
      renderWithProviders(<Harness initial="leo" />);
      expect(screen.getByRole('button', { name: 'Cancella' })).toBeInTheDocument();
    } finally {
      await act(() => i18n.changeLanguage('en'));
    }
  });

  it('has no serious axe violations (empty and with a value)', async () => {
    const { container } = renderWithProviders(
      <div>
        <Harness icon={Search} />
        <Harness initial="leo" aria-label="Vehicle" />
      </div>,
    );
    expect(await seriousViolations(container)).toEqual([]);
  });
});
