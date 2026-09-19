import { isTauri, MOCK_BACKEND } from '@/lib/tauri';

/**
 * Subscribes to a backend event (`install://progress`, `queue://added`, `hangar://changed`…).
 * Inside Tauri it uses the event bus; under `pnpm dev:mock` the in-browser mock backend emits
 * them; otherwise nothing ever fires. Resolves to an unsubscribe function.
 */
export async function listenEvent<T>(name: string, handler: (payload: T) => void): Promise<() => void> {
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    return listen<T>(name, (e) => handler(e.payload));
  }
  if (MOCK_BACKEND) {
    const { mockListen } = await import('@/dev/mockBackend');
    return mockListen<T>(name, handler);
  }
  return () => {};
}
