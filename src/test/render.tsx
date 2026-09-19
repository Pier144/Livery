import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createQueryClient } from '@/queries/client';
import { useQueue } from '@/store/queue';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';

/** Resets all Zustand stores to their initial state. Call in `beforeEach`. */
export function resetStores() {
  useUi.setState({
    screen: 'explore',
    sidebarOpen: true,
    palette: { open: false, query: '', index: 0 },
    online: true,
    dragActive: false,
  });
  useToasts.getState().clear();
  useQueue.setState({ items: [], conflictDialogId: null });
}

/** Renders with the providers the app uses (TanStack Query; i18n is initialised in setup). */
export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  const client = createQueryClient();
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>, options);
}
