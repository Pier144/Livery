import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createQueryClient } from '@/queries/client';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '@/queries/settings';
import { resetCollectionsUi } from '@/store/collections';
import { hangarDefaults, useHangarStore } from '@/store/hangar';
import { useQueue } from '@/store/queue';
import { useToasts } from '@/store/toasts';
import { useUi } from '@/store/ui';
import type { Settings } from '@/types';

/** Resets all Zustand stores to their initial state. Call in `beforeEach`. */
export function resetStores() {
  useUi.setState({
    screen: 'explore',
    sidebarOpen: true,
    palette: { open: false, query: '', index: 0 },
    online: true,
    dragActive: false,
    folderDrop: null,
  });
  useToasts.getState().clear();
  useQueue.setState({ items: [], conflictDialogId: null, installs: {}, picked: {}, batchRunning: false });
  useHangarStore.setState(hangarDefaults());
  resetCollectionsUi();
}

interface ProviderOptions extends RenderOptions {
  /** Seeds the settings query (merged over DEFAULT_SETTINGS) so components don't wait for it. */
  settings?: Partial<Settings>;
  /** Bring your own client, e.g. to seed other queries before rendering. */
  client?: QueryClient;
}

/** Renders with the providers the app uses (TanStack Query; i18n is initialised in setup). */
export function renderWithProviders(ui: ReactElement, { settings, client, ...options }: ProviderOptions = {}) {
  const qc = client ?? createQueryClient();
  if (settings) qc.setQueryData(SETTINGS_KEY, { ...DEFAULT_SETTINGS, ...settings });
  return { client: qc, ...render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>, options) };
}
