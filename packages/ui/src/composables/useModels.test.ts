import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ list: vi.fn(), done: undefined as undefined | (() => void) }));
vi.mock('../bridge', () => ({ bridge: () => ({ listModels: state.list }) }));
vi.mock('./useModelDownloads', () => ({ onDownloadDone: (cb: () => void) => { state.done = cb; } }));
beforeEach(() => { vi.resetModules(); state.list.mockReset(); state.done = undefined; });

it('shares one metadata request across pickers and reuses its snapshot', async () => {
  let resolve!: (list: unknown[]) => void;
  state.list.mockReturnValue(new Promise((done) => { resolve = done; }));
  const { useModels, refreshModels } = await import('./useModels');
  const first = useModels(); const second = useModels();
  expect(state.list).toHaveBeenCalledOnce();
  resolve([{ id: 'sense-voice', downloaded: true }]);
  await refreshModels();
  expect(first.models).toBe(second.models);
  expect(first.models.value).toHaveLength(1);
  useModels();
  expect(state.list).toHaveBeenCalledOnce();
});

it('reports initial and completion failures without unhandled rejection, then permits explicit retry', async () => {
  state.list.mockRejectedValue(new Error('offline'));
  const { useModels, refreshModels } = await import('./useModels');
  const picker = useModels();
  await vi.waitFor(() => expect(picker.error.value).toBe('unavailable'));
  state.list.mockResolvedValue([]);
  await refreshModels();
  expect(picker.error.value).toBe('');
  state.list.mockRejectedValue(new Error('offline again'));
  state.done!();
  await vi.waitFor(() => expect(picker.error.value).toBe('unavailable'));
  state.list.mockResolvedValue([]);
  await refreshModels();
  expect(picker.error.value).toBe('');
});
