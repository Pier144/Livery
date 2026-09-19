import { act, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import en from '@/i18n/en.json';
import { useUi } from '@/store/ui';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import { DropOverlay } from './DropOverlay';

describe('DropOverlay', () => {
  beforeEach(() => resetStores());

  it('is hidden by default', () => {
    renderWithProviders(<DropOverlay />);
    expect(screen.queryByText(en.common.drop.title)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('shows the drop copy in a polite live region while files are dragged', () => {
    renderWithProviders(<DropOverlay />);
    act(() => useUi.getState().setDragActive(true));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(en.common.drop.title);
    expect(status).toHaveTextContent(en.common.drop.formats);
    act(() => useUi.getState().setDragActive(false));
    expect(screen.queryByText(en.common.drop.title)).not.toBeInTheDocument();
  });

  it('is a non-interactive frame inset from the window edges (spec: 8px, 2px dashed amber, scrim)', () => {
    renderWithProviders(<DropOverlay />);
    act(() => useUi.getState().setDragActive(true));
    const frame = screen.getByText(en.common.drop.title).parentElement?.parentElement;
    expect(frame).toHaveClass(
      'pointer-events-none',
      'fixed',
      'inset-2',
      'border-2',
      'border-dashed',
      'border-amber',
      'rounded-dialog',
      'bg-bg-scrim',
    );
    expect(screen.getByText(en.common.drop.title)).toHaveClass('text-title');
    expect(screen.getByText(en.common.drop.formats)).toHaveClass('font-mono', 'text-mono-sm', 'text-ink-3');
  });

  it('has no serious accessibility violations', async () => {
    const { container } = renderWithProviders(<DropOverlay />);
    act(() => useUi.getState().setDragActive(true));
    expect(await seriousViolations(container)).toEqual([]);
  });
});
