import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { closeFeedback, openFeedback, useFeedback } from '@/store/feedback';
import { useToasts } from '@/store/toasts';
import { seriousViolations } from '@/test/axe';
import { renderWithProviders, resetStores } from '@/test/render';
import type { FeedbackDiagnostics } from '@/types';
import { FeedbackDialog } from './FeedbackDialog';

const backend = vi.hoisted(() => ({
  call: vi.fn<(cmd: string) => Promise<unknown>>(),
  openUrl: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  isTauri: () => true,
  hasBackend: () => true,
  call: (cmd: string) => backend.call(cmd),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => backend.openUrl(url) }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: () => Promise.resolve('0.3.2') }));

const DIAG: FeedbackDiagnostics = {
  appVersion: '0.3.2',
  os: 'Windows 11 24H2 (build 26100.1)',
  logTail: ['10:00 INFO livery: Livery started', '10:01 WARN livery::archive: refused path=%USERPROFILE%\\Downloads\\x.rar'],
};

beforeEach(() => {
  resetStores();
  closeFeedback();
  backend.call.mockReset().mockImplementation(async (cmd) => {
    if (cmd === 'feedback_diagnostics') return DIAG;
    throw { code: 'internal', message: `unexpected ${cmd}` };
  });
  backend.openUrl.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

async function launch() {
  const user = userEvent.setup();
  const opener = document.createElement('button');
  opener.textContent = 'opener';
  document.body.append(opener);
  opener.focus();
  const view = renderWithProviders(<FeedbackDialog />);
  openFeedback();
  const dialog = await screen.findByRole('dialog');
  return { user, view, dialog, opener };
}

const preview = () => screen.getByLabelText('What GitHub will receive', { selector: 'pre' });

describe('FeedbackDialog', () => {
  it('starts in the message, shows exactly what GitHub gets, and opens the pre-filled issue', async () => {
    const { user, dialog, view } = await launch();
    const message = within(dialog).getByRole('textbox', { name: 'Message' });
    expect(message).toHaveFocus();
    expect(within(dialog).getByRole('radio', { name: 'Bug' })).toBeChecked();
    const send = within(dialog).getByRole('button', { name: 'Continue on GitHub' });
    expect(send).toBeDisabled();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Write a message first.');

    await user.type(message, 'Install fails with a RAR pack');
    // The anonymised log, the version and Windows are in the preview because "attach" is on.
    await waitFor(() => expect(preview()).toHaveTextContent('Windows 11 24H2 (build 26100.1)'));
    expect(preview()).toHaveTextContent('[Bug] Install fails with a RAR pack');
    expect(preview()).toHaveTextContent('refused path=%USERPROFILE%\\Downloads\\x.rar');
    expect(backend.call).toHaveBeenCalledWith('feedback_diagnostics');
    expect(await seriousViolations(view.container)).toEqual([]);

    await user.click(send);
    await waitFor(() => expect(backend.openUrl).toHaveBeenCalledTimes(1));
    const url = new URL(backend.openUrl.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe('https://github.com/Pier144/Livery/issues/new');
    expect(url.searchParams.get('labels')).toBe('bug');
    expect(url.searchParams.get('title')).toBe('[Bug] Install fails with a RAR pack');
    expect(url.searchParams.get('body')).toContain('x.rar');
    await waitFor(() => expect(useFeedback.getState().open).toBe(false));
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('Submit the page on GitHub to send it.');
  });

  it('sends nothing technical when "attach" is off, and an idea goes to Discussions', async () => {
    const { user, dialog } = await launch();
    await user.click(within(dialog).getByRole('radio', { name: 'Idea' }));
    expect(dialog).toHaveTextContent('It becomes a discussion in Livery’s GitHub Ideas.');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Attach technical details' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Message' }), 'Dark map previews');
    expect(preview()).not.toHaveTextContent('Windows');
    expect(preview()).not.toHaveTextContent('Livery started');
    await user.click(within(dialog).getByRole('button', { name: 'Continue on GitHub' }));
    await waitFor(() => expect(backend.openUrl).toHaveBeenCalledTimes(1));
    const url = new URL(backend.openUrl.mock.calls[0]![0]);
    expect(url.pathname).toBe('/Pier144/Livery/discussions/new');
    expect(url.searchParams.get('category')).toBe('ideas');
    expect(url.searchParams.get('body')).not.toContain('Windows');
  });

  it('closes on Escape and Cancel without sending, and focus goes back', async () => {
    const { user, dialog, opener } = await launch();
    await user.type(within(dialog).getByRole('textbox', { name: 'Message' }), 'x');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    openFeedback();
    const again = await screen.findByRole('dialog', { name: 'Send feedback' });
    await user.click(within(again).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backend.openUrl).not.toHaveBeenCalled();
    opener.remove();
  });

  it('keeps Tab inside the dialog', async () => {
    const { user, dialog } = await launch();
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it('speaks the UI language', async () => {
    await i18n.changeLanguage('it');
    const { dialog } = await launch();
    expect(dialog).toHaveAccessibleName('Invia un feedback');
    expect(within(dialog).getByRole('button', { name: 'Continua su GitHub' })).toBeDisabled();
  });
});
