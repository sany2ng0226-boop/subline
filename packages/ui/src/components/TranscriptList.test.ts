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
  getBoundingClientRect(): { top: number; bottom: number };
  querySelectorAll(selector: string): Node[];
  closest(selector: string): Node | null;
  dataset: { captionId?: string };
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
  let resize = () => {};
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect = disconnect; });
  const positions = new Map<number, number>();
  let scroller: Node;
  function node(type: string, text = ''): Node {
    const el = { type, text, children: [], parent: null, props: {}, scrollTop: 0, scrollHeight: 1000, clientHeight: 200, scrollTo: vi.fn(),
      get dataset() { return { captionId: el.props['data-caption-id']?.toString() }; },
      closest() { let current: Node | null = el; while (current && current.props['data-caption-id'] === undefined) current = current.parent; return current; },
      querySelectorAll() { const result: Node[] = []; const visit = (n: Node) => { if (n.props.class === 'caption-source') result.push(n); n.children.forEach(visit); }; visit(el); return result; },
      getBoundingClientRect() { if (el === scroller) return { top: 0, bottom: 200 }; const id = Number(el.closest('')?.dataset.captionId); const top = (positions.get(id) ?? (id - 1) * 200) - (scroller?.scrollTop ?? 0); return { top, bottom: top + 100 }; },
    } as Node;
    return el;
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
  const props = reactive({ lines: [line(1), line(2), line(3), line(4), line(5)], draft: null as TranscriptLine | null, partial: '', emptyHint: '', recording: true });
  // Vitest uses SSR transforms; compile the same template for the custom client renderer.
  const source = readFileSync(new URL('./TranscriptList.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const result = compileTemplate({ source: descriptor.template!.content, filename: 'TranscriptList.vue', id: 'test', compilerOptions: { bindingMetadata: compileScript(descriptor, { id: 'test' }).bindings } });
  const code = result.code.replace(/import \{([^}]+)\} from "vue"/g, (_, bindings: string) =>
    'const {' + bindings.replace(/ as /g, ': ') + '} = Vue;')
    .replace('export function render', 'function render');
  const render = new Function('Vue', code + '; return render;')( {
    ...Vue,
    Transition: { inheritAttrs: false, setup: (_: unknown, { slots }: any) => () => slots.default?.() },
    TransitionGroup: { inheritAttrs: false, setup: (_: unknown, { slots }: any) => () => slots.default?.() },
  });
  const component = { ...TranscriptList, render };
  const app = renderer.createApp({ setup: () => () => Vue.h(component, props) });
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
  scroller = find(n => !!n.props.onScroll)!;
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
  return { app, props, scroller, pause, key, doc, text, find, listeners, removeEventListener, disconnect, positions, resize: () => resize() };
}

it('holds the reading source when translation above it expands, including delayed resize', async () => {
  const h = await mount();
  await h.pause();
  h.positions.set(3, 480);
  h.props.lines[0].translation = 'A translation that grows above the source being read';
  await nextTick(); await nextTick();
  expect(h.scroller.scrollTop).toBe(480);
  h.positions.set(3, 520);
  h.resize();
  expect(h.scroller.scrollTop).toBe(520);
});

it('does not follow appended lines or draft corrections and exposes the newest source', async () => {
  const h = await mount();
  await h.pause();
  h.props.lines.push(line(6), line(7));
  h.props.draft = { ...line(8), text: 'Newest original text' };
  h.props.partial = 'Newest original text';
  await nextTick(); await nextTick();
  expect(h.scroller.scrollTop).toBe(400);
  expect(h.text()).toContain('Newest original text');
  expect(h.text()).toContain('2 new subtitles');
  h.props.draft.text = 'Corrected original text';
  h.props.partial = 'Corrected original text';
  await nextTick(); await nextTick();
  expect(h.scroller.scrollTop).toBe(400);
  expect(h.text()).toContain('Corrected original text');
  expect(h.props.lines).toHaveLength(7);
});

it.each(['click', 'Enter'])('%s jumps once, resets count, then holds that reading position', async method => {
  const h = await mount();
  await h.pause();
  h.props.lines.push(line(6));
  await nextTick();
  if (method === 'click') h.find(n => n.type === 'button')!.props.onClick();
  else expect(h.key().preventDefault).toHaveBeenCalledOnce();
  expect(h.scroller.scrollTop).toBe(1000);
  await nextTick();
  expect(h.text()).not.toContain('1 new subtitle');
  h.props.lines.push(line(7));
  await nextTick(); await nextTick();
  expect(h.scroller.scrollTop).toBe(1000);
  expect(h.text()).toContain('1 new subtitle');
});

it('ignores Enter inside controls, with modifiers, or during composition and cleans listeners', async () => {
  const h = await mount();
  await h.pause();
  for (const tag of ['input', 'textarea', 'select', 'button']) {
    h.doc.activeElement = { closest: selector => selector.includes(tag) ? {} : null, isContentEditable: false };
    expect(h.key().preventDefault).not.toHaveBeenCalled();
  }
  h.doc.activeElement = { closest: () => null, isContentEditable: true };
  expect(h.key().preventDefault).not.toHaveBeenCalled();
  h.doc.activeElement = null;
  for (const flag of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'isComposing']) expect(h.key({ [flag]: true }).preventDefault).not.toHaveBeenCalled();
  h.app.unmount();
  apps.splice(apps.indexOf(h.app), 1);
  expect(h.listeners.has('keydown')).toBe(false);
  expect(h.disconnect).toHaveBeenCalledOnce();
});

it.each([
  ['zh', '最新', '回到最新', '6 条新字幕'],
  ['ja', '最新', '最新へ移動', '新しい字幕 6 件'],
  ['en', 'Latest', 'Jump to latest', '6 new subtitles'],
  ['ko', '최신', '최신으로 이동', '새 자막 6개'],
] as const)('localizes the latest preview and action in %s', async (locale, latest, action, count) => {
  const h = await mount();
  i18n.global.locale.value = locale;
  await nextTick();
  expect(h.text()).toContain(latest);
  expect(h.text()).toContain(action);
  h.props.lines.push(...Array.from({ length: 6 }, (_, i) => line(i + 6)));
  await nextTick();
  expect(h.text()).toContain(count);
});

it('previews only the latest Unicode tail without mutating the source text', async () => {
  const h = await mount();
  const original = 'Earlier text' + '語😀'.repeat(50) + 'latest end';
  h.props.draft = { ...line(6), text: original };
  h.props.partial = original;
  await nextTick();
  const preview = h.find(n => n.props.class === 'latest-tail')!;
  expect(h.text(preview)).toBe('…' + Array.from(original).slice(-80).join(''));
  expect(h.props.draft.text).toBe(original);
  expect(h.props.partial).toBe(original);
});

it('removes stale preview and count when the transcript becomes empty', async () => {
  const h = await mount();
  h.props.lines.push(line(6));
  await nextTick();
  expect(h.text()).toContain('1 new subtitle');
  h.props.lines.splice(0);
  await nextTick(); await nextTick();
  expect(h.find(n => n.type === 'button')).toBeUndefined();
  h.props.lines.push(line(9));
  await nextTick();
  expect(h.text()).not.toContain('2 new subtitles');
});

it('does not count a restored transcript as new live subtitles', async () => {
  const h = await mount();
  h.props.recording = false;
  h.props.lines.push(...Array.from({ length: 37 }, (_, i) => line(i + 6)));
  await nextTick();
  expect(h.text()).not.toContain('37 new subtitles');
  expect(h.text()).toContain('Jump to latest');
  h.props.recording = true;
  h.props.lines.push(line(43));
  await nextTick();
  expect(h.text()).toContain('1 new subtitle');
});
