import { beforeEach, expect, it, vi } from 'vitest';
import type { AppBridge, ShortcutAction } from '@rt/core';
import { setBridge } from '../bridge';
import { onShortcutAction } from './useShortcuts';

let emit: ((action: ShortcutAction) => void) | null;
const unsubscribe = vi.fn();

beforeEach(() => {
  emit = null;
  unsubscribe.mockClear();
});

it('runs only for the requested action and unsubscribes', () => {
  setBridge({ onShortcut: (cb: (action: ShortcutAction) => void) => { emit = cb; return unsubscribe; } } as unknown as AppBridge);
  const run = vi.fn();
  const off = onShortcutAction('toggleRecording', run);
  emit!('toggleOverlay');
  expect(run).not.toHaveBeenCalled();
  emit!('toggleRecording');
  expect(run).toHaveBeenCalledOnce();
  off();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('is a no-op on hosts without global shortcuts', () => {
  setBridge({} as AppBridge);
  expect(() => onShortcutAction('toggleRecording', vi.fn())()).not.toThrow();
});
