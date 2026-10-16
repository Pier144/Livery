import { afterEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  tauri: false,
  invoke: vi.fn<(cmd: string, args?: unknown, options?: unknown) => Promise<unknown>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => core.tauri,
  invoke: (cmd: string, args?: unknown, options?: unknown) => core.invoke(cmd, args, options),
}));

const mock = vi.hoisted(() => ({ mockCall: vi.fn<(cmd: string, args: Record<string, unknown>) => Promise<unknown>>() }));
vi.mock('@/dev/mockBackend', () => ({ mockCall: mock.mockCall }));

import { callRaw } from './tauri';

afterEach(() => {
  core.tauri = false;
  core.invoke.mockReset();
  mock.mockCall.mockReset();
  vi.unstubAllEnvs();
});

describe('callRaw', () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const headers = { 'x-apply-id': 'a-1', 'x-slot': 'tank_body_c' };

  it('sends the bytes as the raw request body and the headers as invoke options in Tauri', async () => {
    core.tauri = true;
    core.invoke.mockResolvedValue(null);
    await expect(callRaw('atelier_apply_texture', body, headers)).resolves.toBeNull();
    expect(core.invoke).toHaveBeenCalledWith('atelier_apply_texture', body, { headers });
  });

  it('normalizes a rejection into an AppError', async () => {
    core.tauri = true;
    core.invoke.mockRejectedValue('boom');
    await expect(callRaw('atelier_apply_texture', body, headers)).rejects.toEqual({ code: 'internal', message: 'boom' });
  });

  it('forwards body and headers to the mock backend under dev:mock', async () => {
    vi.stubEnv('VITE_MOCK_BACKEND', '1');
    mock.mockCall.mockResolvedValue(null);
    await callRaw('atelier_project_thumb', body, { 'x-project-id': 'p-1' });
    expect(mock.mockCall).toHaveBeenCalledWith('atelier_project_thumb', { __body: body, __headers: { 'x-project-id': 'p-1' } });
    expect(core.invoke).not.toHaveBeenCalled();
  });

  it('rejects noBackend in a plain browser', async () => {
    vi.stubEnv('VITE_MOCK_BACKEND', '');
    await expect(callRaw('atelier_project_thumb', body, {})).rejects.toMatchObject({ code: 'noBackend' });
  });
});
