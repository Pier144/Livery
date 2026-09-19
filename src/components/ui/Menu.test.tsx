import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { Menu, type MenuItem, type MenuProps } from './Menu';

const ITEMS: MenuItem[] = [
  { value: 'ger', label: 'Germany' },
  { value: 'usa', label: 'USA' },
  { value: 'ussr', label: 'USSR' },
  { value: 'jpn', label: 'Japan' },
];

type HarnessProps = Partial<Omit<MenuProps, 'renderTrigger'>>;

function Harness(props: HarnessProps) {
  return (
    <div>
      <button type="button">Before</button>
      <Menu
        items={ITEMS}
        onSelect={() => {}}
        {...props}
        renderTrigger={(p) => <button {...p}>Nation</button>}
      />
      <button type="button">After</button>
    </div>
  );
}

const trigger = () => screen.getByRole('button', { name: 'Nation' });
const menu = () => screen.getByRole('menu');
const queryMenu = () => screen.queryByRole('menu');

describe('Menu', () => {
  beforeEach(() => resetStores());

  it('exposes the menu-button ARIA and opens on click with focus on the first item', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).not.toHaveAttribute('aria-controls');
    expect(queryMenu()).not.toBeInTheDocument();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', menu().id);
    expect(menu()).toHaveAccessibleName('Nation');
    const items = within(menu()).getAllByRole('menuitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveFocus();
    items.forEach((item) => expect(item).toHaveAttribute('tabindex', '-1'));
  });

  it('styles the popover as an elevation-1 menu under the trigger by default', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(trigger());
    expect(menu()).toHaveClass('absolute', 'z-20', 'min-w-[160px]', 'bg-bg-3', 'border-line-3', 'rounded-ctl', 'p-1', 'shadow-menu');
    expect(menu()).toHaveClass('top-[32px]', 'left-0');
    expect(within(menu()).getAllByRole('menuitem')[0]).toHaveClass('px-2.5', 'py-[7px]', 'rounded-menu', 'text-meta', 'text-ink-1', 'hover:bg-bg-4');
  });

  it('placement top / align end / custom width', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness placement="top" align="end" menuWidthClass="min-w-[180px]" />);
    await user.click(trigger());
    expect(menu()).toHaveClass('bottom-[34px]', 'right-0', 'min-w-[180px]');
    expect(menu()).not.toHaveClass('top-[32px]');
    expect(menu()).not.toHaveClass('min-w-[160px]');
  });

  it('ArrowDown / Enter / Space on the trigger open on the first item; ArrowUp on the last', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    const items = () => within(menu()).getAllByRole('menuitem');

    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(items()[0]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(queryMenu()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(items()[0]).toHaveFocus();
    await user.keyboard('{Escape}');

    await user.keyboard(' ');
    expect(items()[0]).toHaveFocus();
    await user.keyboard('{Escape}');

    await user.keyboard('{ArrowUp}');
    expect(items()[3]).toHaveFocus();
  });

  it('ArrowUp/ArrowDown wrap, Home/End jump, type-ahead matches the first letter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(trigger());
    const items = within(menu()).getAllByRole('menuitem');
    await user.keyboard('{ArrowUp}');
    expect(items[3]).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('{End}');
    expect(items[3]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(items[0]).toHaveFocus();
    await user.keyboard('u');
    expect(items[1]).toHaveFocus();
    await user.keyboard('u');
    expect(items[2]).toHaveFocus();
    await user.keyboard('j');
    expect(items[3]).toHaveFocus();
  });

  it('Enter and Space activate, close the menu and return focus to the trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<Harness onSelect={onSelect} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('usa');
    expect(queryMenu()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard('{ArrowDown}{End} ');
    expect(onSelect).toHaveBeenLastCalledWith('jpn');
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(queryMenu()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('a click on an item selects it', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<Harness onSelect={onSelect} />);
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'USSR' }));
    expect(onSelect).toHaveBeenCalledWith('ussr');
    expect(queryMenu()).not.toBeInTheDocument();
  });

  it('radio menus use menuitemradio + aria-checked, draw the check and open on the checked item', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness kind="radio" value="ussr" />);
    await user.click(trigger());
    const radios = within(menu()).getAllByRole('menuitemradio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true', 'false']);
    expect(radios[2]).toHaveFocus();
    expect(radios[2]?.querySelector('svg.text-amber')).not.toBeNull();
    expect(radios[0]?.querySelector('svg')).toBeNull();
  });

  it('disabled items are focusable but not activatable', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(<Harness onSelect={onSelect} items={[...ITEMS.slice(0, 1), { value: 'x', label: 'Nope', disabled: true }]} />);
    await user.click(trigger());
    const disabled = screen.getByRole('menuitem', { name: 'Nope' });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{ArrowDown}');
    expect(disabled).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.click(disabled);
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu()).toBeInTheDocument();
  });

  it('Escape closes only the menu: window-level handlers never see it', async () => {
    const user = userEvent.setup();
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      renderWithProviders(<Harness />);
      await user.click(trigger());
      await user.keyboard('{Escape}');
      expect(queryMenu()).not.toBeInTheDocument();
      expect(trigger()).toHaveFocus();
      expect(onWindowKey).not.toHaveBeenCalled();

      // Closed: Escape is not the menu's and bubbles as usual.
      await user.keyboard('{Escape}');
      expect(onWindowKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('Escape inside a menu does not reach a parent layer handler', async () => {
    const user = userEvent.setup();
    const onParentKey = vi.fn();
    renderWithProviders(
      <div role="dialog" aria-label="Parent" onKeyDown={(e) => e.key === 'Escape' && onParentKey()}>
        <Harness />
      </div>,
    );
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(onParentKey).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onParentKey).toHaveBeenCalledTimes(1);
  });

  it('clicks and owned keys never reach a clickable parent card', async () => {
    const user = userEvent.setup();
    const onCardClick = vi.fn();
    const onCardKey = vi.fn();
    const onSelect = vi.fn();
    renderWithProviders(
      <div role="button" tabIndex={0} aria-label="Open skin" onClick={onCardClick} onKeyDown={onCardKey} onKeyUp={onCardKey}>
        <Harness onSelect={onSelect} />
      </div>,
    );
    await user.click(trigger());
    await user.click(screen.getByRole('menuitem', { name: 'USA' }));
    trigger().focus();
    await user.keyboard('{Enter}{ArrowDown}u{Enter}');
    await user.keyboard(' ');
    await user.keyboard(' ');
    expect(onSelect.mock.calls).toEqual([['usa'], ['ussr'], ['ger']]);
    expect(onCardClick).not.toHaveBeenCalled();
    expect(onCardKey).not.toHaveBeenCalled();
  });

  it('Tab closes the menu and moves on from the trigger', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(trigger());
    await user.tab();
    expect(queryMenu()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('an outside mousedown closes; a click on the trigger toggles', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);
    await user.click(trigger());
    await user.click(document.body);
    expect(queryMenu()).not.toBeInTheDocument();

    await user.click(trigger());
    expect(menu()).toBeInTheDocument();
    await user.click(trigger());
    expect(queryMenu()).not.toBeInTheDocument();

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'Before' }));
    expect(queryMenu()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus();
  });

  it('works controlled through open / onOpenChange', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <Harness
          open={open}
          onOpenChange={(next) => {
            onOpenChange(next);
            setOpen(next);
          }}
        />
      );
    }
    renderWithProviders(<Controlled />);
    await user.click(trigger());
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(menu()).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(queryMenu()).not.toBeInTheDocument();
  });

  it('stays closed when the controlled parent says so', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithProviders(<Harness open={false} onOpenChange={onOpenChange} />);
    await user.click(trigger());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(queryMenu()).not.toBeInTheDocument();
  });

  it('has no serious axe violations, closed and open (action and radio)', async () => {
    const user = userEvent.setup();
    const { container, unmount } = renderWithProviders(<Harness />);
    expect(await seriousViolations(container)).toEqual([]);
    await user.click(trigger());
    expect(await seriousViolations(container)).toEqual([]);
    unmount();

    const radio = renderWithProviders(<Harness kind="radio" value="ger" label="Nation filter" />);
    await user.click(trigger());
    expect(menu()).toHaveAccessibleName('Nation filter');
    expect(await seriousViolations(radio.container)).toEqual([]);
  });
});
