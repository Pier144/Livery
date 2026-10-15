import { create } from 'zustand';

/** What a confirmation asks: the question, what happens, and the label of the destructive button. */
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
}

interface ConfirmState {
  request: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null;
  /** Settles the open request (the dialog's buttons, Escape, a click outside). */
  settle: (ok: boolean) => void;
}

export const useConfirm = create<ConfirmState>()((set, get) => ({
  request: null,
  settle: (ok) => {
    const { request } = get();
    if (!request) return;
    set({ request: null });
    request.resolve(ok);
  },
}));

/**
 * Asks before a destructive action (ConfirmDialog, mounted once in App). Resolves to true when the
 * user confirms, false when they cancel. A new request cancels the one still open.
 */
export function confirm(request: ConfirmRequest): Promise<boolean> {
  useConfirm.getState().settle(false);
  return new Promise((resolve) => useConfirm.setState({ request: { ...request, resolve } }));
}
