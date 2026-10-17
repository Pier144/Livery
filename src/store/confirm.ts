import { create } from 'zustand';

/** What a confirmation asks: the question, what happens, and the label of the destructive button. */
export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel: string;
  /** Label of an extra checkbox under the body (unchecked when the dialog opens), e.g. "Also uninstall its skin". */
  option?: string;
}

/** How a confirmation was answered: confirmed or not, and the extra checkbox (false without one). */
export interface ConfirmAnswer {
  ok: boolean;
  checked: boolean;
}

interface ConfirmState {
  request: (ConfirmRequest & { resolve: (answer: ConfirmAnswer) => void }) | null;
  /** Settles the open request (the dialog's buttons, Escape, a click outside). */
  settle: (ok: boolean, checked?: boolean) => void;
}

export const useConfirm = create<ConfirmState>()((set, get) => ({
  request: null,
  settle: (ok, checked = false) => {
    const { request } = get();
    if (!request) return;
    set({ request: null });
    request.resolve({ ok, checked: ok && request.option !== undefined && checked });
  },
}));

/**
 * Asks before a destructive action (ConfirmDialog, mounted once in App), with the request's extra
 * checkbox when it has an `option`. Resolves when answered; a new request cancels the one still open.
 */
export function confirmWithOption(request: ConfirmRequest): Promise<ConfirmAnswer> {
  useConfirm.getState().settle(false);
  return new Promise((resolve) => useConfirm.setState({ request: { ...request, resolve } }));
}

/** `confirmWithOption` without the checkbox: resolves to true when the user confirms, false when they cancel. */
export function confirm(request: Omit<ConfirmRequest, 'option'>): Promise<boolean> {
  return confirmWithOption(request).then((answer) => answer.ok);
}
