import { QueryClient } from '@tanstack/react-query';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Local backend calls are cheap and deterministic; WT Live queries override these in M5.
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  });
}
