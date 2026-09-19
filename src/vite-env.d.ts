/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" under `pnpm dev:mock`: commands go to the in-browser mock backend. */
  readonly VITE_MOCK_BACKEND?: string;
}
