// WCAG 2.x 对比度守护：设计 token 与组件里残留的硬编码文字颜色都要达到正文 4.5:1。
// 颜色换算与 /tmp/contrast.mjs（设计侧实测脚本）一致：Tailwind v4 的 oklch 经 OKLab → 线性 sRGB → gamma，
// 超色域按通道裁剪；color-mix(in srgb) 与透明度在 gamma 编码的 sRGB 里线性插值（浏览器合成方式）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const AA = 4.5;

type Rgb = [number, number, number];
interface Color { rgb: Rgb; a: number }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklch(str: string): Color {
  const [l, c, h] = str.match(/oklch\(([^)]+)\)/)![1].trim().split(/\s+/)
    .map((v, i) => (i === 0 && v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v)));
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];
  return { rgb: lin.map((v) => clamp01(toGam(clamp01(v)))) as Rgb, a: 1 };
}

function parse(str: string): Color {
  str = str.trim();
  if (str.startsWith('#')) {
    let h = str.slice(1);
    if (h.length === 3) h = [...h].map((x) => x + x).join('');
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb, a: 1 };
  }
  if (str.startsWith('oklch')) return oklch(str);
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`cannot parse color ${str}`);
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  return { rgb: parts.slice(0, 3).map((v) => parseFloat(v) / 255) as Rgb, a };
}

const over = (fg: Color, bg: Color): Color => ({ rgb: fg.rgb.map((c, i) => c * fg.a + bg.rgb[i] * (1 - fg.a)) as Rgb, a: 1 });
const mix = (c1: Color, p: number, c2: Color): Color => ({ rgb: c1.rgb.map((c, i) => c * p + c2.rgb[i] * (1 - p)) as Rgb, a: 1 });
const lum = (c: Color) => {
  const [r, g, b] = c.rgb.map(toLin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function contrast(fg: Color, bg: Color): number {
  const [x, y] = [lum(fg.a < 1 ? over(fg, bg) : fg), lum(bg)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}

// ---- 设计 token ----
const css = fs.readFileSync(path.join(here, 'styles.css'), 'utf8');
function block(selector: string): Record<string, string> {
  const i = css.indexOf(`${selector} {`);
  if (i < 0) throw new Error(`selector not found: ${selector}`);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--rt-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const light = block(':root');
const themes = { light, dark: { ...light, ...block('html.dark') } };
const token = (theme: Record<string, string>, name: string) => parse(theme[name]);

const TEXT_TOKENS = ['ink', 'ink-2', 'ink-3', 'accent', 'accent-ink', 'live', 'ok'];

describe.each(Object.entries(themes))('%s theme tokens', (_, theme) => {
  const bg = token(theme, 'bg');
  it.each(TEXT_TOKENS)('--rt-%s reads on bg and surface', (name) => {
    expect(contrast(token(theme, name), bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(token(theme, name), token(theme, 'surface'))).toBeGreaterThanOrEqual(AA);
  });
  it('white on --rt-live-solid (recording button)', () => {
    expect(contrast(parse('#ffffff'), token(theme, 'live-solid'))).toBeGreaterThanOrEqual(AA);
  });
  it('streaming and past translations (TranscriptList .is-partial / .is-past)', () => {
    const accentInk = token(theme, 'accent-ink');
    expect(contrast(mix(accentInk, 0.85, bg), bg)).toBeGreaterThanOrEqual(AA);
    expect(contrast(mix(accentInk, 0.82, bg), bg)).toBeGreaterThanOrEqual(AA);
  });
});

// ---- 组件里的硬编码颜色 ----
const require = createRequire(import.meta.url);
const twTheme = fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
const palette = Object.fromEntries([...twTheme.matchAll(/--color-([\w-]+):\s*(oklch\([^)]+\));/g)].map((m) => [m[1], m[2]]));

function vueFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? vueFiles(p) : e.name.endsWith('.vue') ? [p] : [];
  });
}

const TEXT_CLASS = /(?<![\w-])(dark:)?text-(?:\[(#[0-9a-fA-F]{3,6})\]|([a-z]+-\d{2,3})(?:\/(\d{1,3}))?)(?![\w-])/g;

/** 扫一行里的文字颜色类：无前缀的类在没有 dark: 覆盖时两套主题都会生效 */
function lineFailures(line: string): string[] {
  const failures: string[] = [];
  const found = [...line.matchAll(TEXT_CLASS)].map((m) => ({
    cls: m[0], dark: !!m[1], hex: m[2], name: m[3], alpha: m[4] ? Number(m[4]) / 100 : 1,
  })).filter((c) => c.hex || palette[c.name!]);
  const hasDark = found.some((c) => c.dark);
  for (const c of found) {
    const color = c.hex ? parse(c.hex) : { ...parse(palette[c.name!]), a: c.alpha };
    const modes = c.dark ? ['dark'] : hasDark ? ['light'] : ['light', 'dark'];
    for (const mode of modes) {
      const ratio = contrast(color, token(themes[mode as 'light' | 'dark'], 'bg'));
      if (ratio < AA) failures.push(`${c.cls} on ${mode} bg = ${ratio}`);
    }
  }
  return failures;
}

/** <style> 里写死的文字颜色：对同一规则的 var(--rt-*) 背景计算，没有背景则对 bg */
function styleFailures(source: string): string[] {
  const style = source.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const failures: string[] = [];
  for (const [, selector, body] of style.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const color = body.match(/(?:^|;)\s*color:\s*(#[0-9a-fA-F]{3,6}|rgba?\([^)]+\))/)?.[1];
    if (!color) continue;
    const bgToken = body.match(/background(?:-color)?:\s*var\(--rt-([\w-]+)\)/)?.[1] ?? 'bg';
    for (const [mode, theme] of Object.entries(themes)) {
      const ratio = contrast(parse(color), token(theme, bgToken));
      if (ratio < AA) failures.push(`${selector.trim()} color ${color} on ${mode} ${bgToken} = ${ratio}`);
    }
  }
  return failures;
}

it('the contrast math matches the design audit', () => {
  // 设计侧实测：neutral-400 对白 2.59，#d13438 白字 4.93
  expect(contrast(parse(palette['neutral-400']), parse('#ffffff'))).toBeCloseTo(2.59, 1);
  expect(contrast(parse('#ffffff'), parse('#d13438'))).toBeCloseTo(4.93, 1);
  // 改前的写法应当被拦下：亮色 neutral-400 / 暗色 neutral-500 / 半透明 red-500
  expect(lineFailures(`class="text-neutral-400"`)).toEqual(['text-neutral-400 on light bg = 2.59']);
  expect(lineFailures(`class="text-neutral-400 dark:text-neutral-500"`)).toHaveLength(2);
  expect(lineFailures(`'border-red-400/70 text-red-500/80'`)).not.toEqual([]);
  expect(lineFailures(`class="text-neutral-600 dark:text-neutral-300"`)).toEqual([]);
  expect(styleFailures(`<style>.a { color: #5276b0; }</style>`)).toHaveLength(1);
  expect(styleFailures(`<style>.b { color: #fff; background: var(--rt-live-solid); }</style>`)).toEqual([]);
});

it.each(vueFiles(here).map((f) => [path.relative(here, f), f]))('%s has no low-contrast hard-coded text colors', (_, file) => {
  const source = fs.readFileSync(file, 'utf8');
  const failures = [
    ...source.split('\n').flatMap((line, i) => lineFailures(line).map((f) => `:${i + 1} ${f}`)),
    ...styleFailures(source),
  ];
  expect(failures).toEqual([]);
});
