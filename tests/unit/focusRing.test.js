import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = (name) => readFileSync(new URL(`../../frontend/css/${name}`, import.meta.url), 'utf8');

/** Custom property pada blok :root pertama tokens.css (tanpa media query). */
function rootTokens() {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(css('tokens.css').replace(/\/\*[\s\S]*?\*\//g, ''))[1];
  return Object.fromEntries([...block.matchAll(/(--lr-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function resolveVar(value, tokens) {
  return value.replace(/var\((--lr-[\w-]+)\)/g, (_m, name) => resolveVar(tokens[name], tokens));
}

/** '#rrggbb' atau 'rgb(r g b / a)' → { rgb: [r, g, b], alpha }. */
function parseColor(text) {
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) return { rgb: [0, 2, 4].map((i) => Number.parseInt(hex[1].slice(i, i + 2), 16)), alpha: 1 };
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+))?\s*\)$/.exec(text);
  if (rgb) return { rgb: rgb.slice(1, 4).map(Number), alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) };
  throw new Error(`warna tidak dikenali: ${text}`);
}

const blend = (fg, bg) => fg.rgb.map((c, i) => c * fg.alpha + bg[i] * (1 - fg.alpha));

function luminance(rgb) {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('indikator fokus', () => {
  const tokens = rootTokens();
  // Bayangan terakhir pada --lr-focus-ring adalah cincin berwarna; yang pertama celah --lr-bg.
  const ring = resolveVar(tokens['--lr-focus-ring'], tokens);
  const ringColor = parseColor(/(#[0-9a-f]{6}|rgb\([^)]*\))\s*$/i.exec(ring)[1]);

  it.each(['--lr-bg', '--lr-surface', '--lr-surface-2'])('UNIT-A11Y-001 cincin fokus ≥ 3:1 terhadap %s', (bgToken) => {
    const bg = parseColor(tokens[bgToken]).rgb;
    expect(contrast(blend(ringColor, bg), bg)).toBeGreaterThanOrEqual(3);
  });

  it('UNIT-A11Y-002 mode warna paksa memakai outline untuk :focus-visible', () => {
    const forced = /@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/.exec(css('base.css'));
    expect(forced, 'blok @media (forced-colors: active) di base.css').not.toBeNull();
    expect(forced[1]).toMatch(/:focus-visible\s*\{[^}]*outline:\s*\d+px\s+solid\s+\w+/);
  });
});
