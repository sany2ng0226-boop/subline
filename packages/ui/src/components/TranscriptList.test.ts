import { afterEach, expect, it, vi } from 'vitest';
import * as Vue from 'vue';
import { readFileSync } from 'node:fs';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import { createRenderer, nextTick, reactive, ssrContextKey } from 'vue';
import TranscriptList from './TranscriptList.vue';
import type { TranscriptLine } from '../composables/useTranscription';
import { i18n } from '../i18n';

type Node = {
  type: string; children: Node[]; parent: Node | null; props: Record<string, any>;
  text: string; scrollTop: number; scrollHeight: number; clientHeight: number;
  scrollTo: ReturnType<typeof vi.fn>;
};
const apps: Array<{ unmount(): void }> = [];
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount());
  vi.unstubAllGlobals();
});
function line(id: number): TranscriptLine {
  return { displayId: id, id, time: '', text: 'Subtitle', translation: '', translating: false, failed: false };
}
async function mount() {
  const listeners = new Map<string, (event: any) => void>();
  const removeEventListener = vi.fn((key: string) => listeners.delete(key));
  vi.stubGlobal('window', {
    addEventListener: (key: string, listener: (event: any) => void) => listeners.set(key, listener),
    removeEventListener,
  });
  const doc = { activeElement: null as null | { closest: (selector: string) => unknown; isContentEditable: boolean } };
  vi.stubGlobal('document', doc);
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  function node(type: string, text = ''): Node {
    return { type, text, children: [], parent: null, props: {}, scrollTop: 0, scrollHeight: 1000, clientHeight: 200, scrollTo: vi.fn() };
  }
  const renderer = createRenderer<Node, Node>({
    createElement: tag => node(tag), createText: text => node('#text', text),
    createComment: text => node('#comment', text),
    patchProp: (el, key, _prev, value) => { el.props[key] = value; },
    insert(el, parent, anchor) {
      if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
      el.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(el); else parent.children.splice(index, 0, el);
    },
    remove(el) { el.parent?.children.splice(el.parent.children.indexOf(el), 1); },
    setText: (el, text) => { el.text = text; },
    setElementText: (el, text) => { el.text = text; el.children = []; },
    parentNode: el => el.parent,
    nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  });
  const props = reactive({ lines: [line(1)], draft: null as TranscriptLine | null, partial: '', emptyHint: '' });
  // Vitest uses SSR transforms; compile the same template for the custom client renderer.
  const source = readFileSync(new URL('./TranscriptList.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const result = compileTemplate({ source: descriptor.template!.content, filename: 'TranscriptList.vue', id: 'test', compilerOptions: { bindingMetadata: compileScript(descriptor, { id: 'test' }).bindings } });
  const code = result.code.replace(/import \{([^}]+)\} from "vue"/g, (_, bindings: string) =>
    'const {' + bindings.replace(/ as /g, ': ') + '} = Vue;')
    .replace('export function render', 'function render');
  const render = new Function('Vue', code + '; return render;')( {
    ...Vue,
    Transition: { setup: (_: unknown, { slots }: any) => () => slots.default?.() },
    TransitionGroup: { setup: (_: unknown, { slots }: any) => () => slots.default?.() },
  });
  const app = renderer.createApp({ ...TranscriptList, render }, props);
  app.provide(ssrContextKey, { modules: new Set() });
  const root = node('root');
  i18n.global.locale.value = 'en';
  apps.push(app);
  app.use(i18n).mount(root);
  await nextTick();
  function find(predicate: (n: Node) => boolean, n = root): Node | undefined {
    if (predicate(n)) return n;
    for (const child of n.children) { const found = find(predicate, child); if (found) return found; }
  }
  const scroller = find(n => !!n.props.onScroll)!;
  const text = (n: Node = root): string => n.text + n.children.map(child => text(child)).join('');
  const pause = async () => {
    scroller.scrollTop = 800; scroller.props.onScroll();
    scroller.scrollTop = 400; scroller.props.onScroll();
    await nextTick();
  };
  const key = (extra = {}) => {
    const event = { key: 'Enter', preventDefault: vi.fn(), ...extra };
    listeners.get('keydown')?.(event);
    return event;
  };
  return { app, props, scroller, pause, key, doc, text, find, listeners, removeEventListener, disconnect };
}

it('preserves the paused scroll position and counts only appended finalized lines', async () => {
  const h = await mount();
  await h.pause();
  expect(h.text()).toContain('Following paused');
  expect(h.text()).toContain('Jump to latest');
  h.props.draft = line(2);
  await nextTick();
  expect(h.text()).toContain('Jump to latest');
  h.props.lines.push(line(2), line(3), line(4));
  await nextTick(); await nextTick();
  expect(h.scroller.scrollTop).toBe(400);
  expect(h.text()).toContain('3 new subtitles');
  h.props.lines[0].translation = 'Updated';
  await nextTick();
  expect(h.text()).toContain('3 new subtitles');
  h.scroller.scrollTop = 800; h.scroller.props.onScroll();
  await nextTick();
  await h.pause();
  expect(h.text()).toContain('Jump to latest');
});

it.each(['click', 'Enter'])('%s jumps smoothly and clears the count', async method => {
  const h = await mount();
  await h.pause();
  h.props.lines.push(line(2));
  await nextTick();
  expect(h.text()).toContain('1 new subtitle');
  if (method === 'click') h.find(n => n.type === 'button')!.props.onClick();
  else expect(h.key().preventDefault).toHaveBeenCalledOnce();
  expect(h.scroller.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'smooth' });
  await nextTick();
  await h.pause();
  expect(h.text()).toContain('Jump to latest');
});

it('ignores Enter in controls/editable content, with modifiers, during composition, or when following', async () => {
  const h = await mount();
  h.key();
  expect(h.scroller.scrollTo).not.toHaveBeenCalled();
  await h.pause();
  for (const tag of ['input', 'textarea', 'select', 'button']) {
    h.doc.activeElement = { closest: selector => selector.includes(tag) ? {} : null, isContentEditable: false };
    h.key();
  }
  h.doc.activeElement = { closest: () => null, isContentEditable: true };
  h.key();
  h.doc.activeElement = null;
  for (const flag of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing']) h.key({ [flag]: true });
  h.key({ key: 'Escape' });
  expect(h.scroller.scrollTo).not.toHaveBeenCalled();
  h.app.unmount();
  apps.splice(apps.indexOf(h.app), 1);
  expect(h.listeners.has('keydown')).toBe(false);
  expect(h.disconnect).toHaveBeenCalledOnce();
});
