// Evaluasi simulasi konfirmasi AL-MOM-01 (docs/29 §21, praregistrasi v1). Data SINTETIS seluruhnya. Membaca laporan
// simulasi coverage (scripts/research-al-mom-01-coverage.js) dan oracle (scripts/research-al-mom-01-diagnose.js
// --mode oracle), lalu menghitung kriteria yang ditetapkan SEBELUM run dijalankan. Konstanta di bawah adalah bagian dari
// praregistrasi: mengubahnya sesudah hasil ada adalah penyimpangan yang wajib dicatat.
//
// Pakai: npm run research:al-mom-01-confirm -- --coverage a.json,b.json --oracle c.json,d.json [--out reports/research]

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { proportion } from './research-al-mom-01-coverage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ── Praregistrasi (docs/29 §21) ──
export const NOMINAL = 0.025;
export const LARGE_ERROR = 0.05;
export const COVERAGE_FLOOR = 0.85;
export const MAX_INVALID_SHARE = 0.01;
/** Pasangan DGP: [nama, skenario efek 0, skenario efek ≈ margin, golongan, basis harga martingale?]. */
export const PAIRS = Object.freeze([
  ['dasar', 'dasar0', 'dasar025', 'realistis', true],
  ['korelasi', 'korelasi', 'korelasiM', 'realistis', true],
  ['takMerata', 'takMerata', 'takMerataM', 'realistis', true],
  ['sedikit', 'sedikit', 'sedikitM', 'realistis', true],
  ['ekor', 'ekor', 'ekorM', 'realistis', true],
  ['momentum', 'momentum', 'momentumM', 'realistis', false],
  ['episode', 'episode', 'episode025', 'realistis', false],
  ['serial', 'serial0', 'serialM', 'ekstrem', true],
  ['stres', 'stres0', 'stres025', 'ekstrem', true],
  ['dasar100', 'pasangan084', 'pasangan084e', 'realistis', true],
  ['takMerata100', 'takMerata100', 'takMerata100M', 'realistis', true],
  ['rezimHistoris100', 'rezimHistoris100', 'rezimHistoris100M', 'realistis', true],
  ['rezimPadat100', 'rezimPadat100', 'rezimPadat100M', 'ekstrem', true],
]);

const meanOf = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sdOf = (a) => {
  if (a.length < 2) return null;
  const m = meanOf(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Baris per simulasi dari laporan coverage: [titik, θ_d, pers lo, hi, basic lo, hi, BC lo, hi] → objek + batas atas gabungan. */
export function rowsOf(scenario) {
  return scenario.runs.map(([point, thetaD, pLo, pHi, bLo, bHi, cLo, cHi]) => ({
    point, thetaD, percentile: { lo: pLo, hi: pHi }, basic: { lo: bLo, hi: bHi }, bc: { lo: cLo, hi: cHi },
    union: { lo: pLo, hi: Math.max(pHi, bHi) },
  }));
}

/** T2 (estimand populasi overlap) dari laporan oracle: rata-rata antar-konfigurasi (unit independen) dasar + drift. */
export function populationTarget(oracle) {
  const vals = oracle.perConfig.map((c) => c.oracleAllBase + c.oracleAllDrift).filter(Number.isFinite);
  return { value: meanOf(vals), mcSe: vals.length > 1 ? sdOf(vals) / Math.sqrt(vals.length) : null, configs: vals.length, draws: oracle.draws };
}

const METHODS = ['percentile', 'basic', 'bc', 'union'];

/** Galat satu sisi & coverage terhadap target t (angka atau fungsi baris → angka). */
export function errorsAgainst(rows, t) {
  const tv = typeof t === 'function' ? t : () => t;
  const out = {};
  for (const m of METHODS) {
    const list = rows.filter((r) => Number.isFinite(r[m].lo) && Number.isFinite(r[m].hi));
    out[m] = {
      hiBelow: proportion(list.filter((r) => r[m].hi < tv(r)).length, list.length),
      loAbove: proportion(list.filter((r) => r[m].lo > tv(r)).length, list.length),
      cover: m === 'union' ? null : proportion(list.filter((r) => r[m].lo <= tv(r) && tv(r) <= r[m].hi).length, list.length),
    };
  }
  return out;
}

const passNominal = (p) => (p?.lo === null || p?.lo === undefined ? null : p.lo <= NOMINAL);

/**
 * Evaluasi satu pasangan DGP. zero/margin = skenario laporan coverage (boleh null bila belum dijalankan);
 * t2zero/t2margin = T2 dari oracle (null bila belum ada; untuk basis martingale T2 efek 0 = 0 menurut konstruksi).
 */
export function evaluatePair([name, zeroName, marginName, klass, martingale], { zero, margin, t2zero = null, t2margin = null }) {
  const res = { name, klass, zero: null, margin: null, criteria: {} };
  if (zero) {
    const rows = rowsOf(zero);
    const t4 = meanOf(rows.map((r) => r.point));
    const t2 = martingale ? { value: 0, mcSe: 0, byConstruction: true } : t2zero;
    res.zero = {
      scenario: zeroName, sims: zero.sims, failed: zero.failed, invalidReps: zero.methods?.full7?.invalidReps ?? null, ok: rows.length,
      t4: { value: t4, mcSe: sdOf(rows.map((r) => r.point)) / Math.sqrt(rows.length) }, t2,
      superiority: Object.fromEntries(METHODS.map((m) => [m, proportion(rows.filter((r) => r[m].lo > 0).length, rows.length)])),
      vsT4: errorsAgainst(rows, t4), vsT2: t2?.value === null || t2?.value === undefined ? null : errorsAgainst(rows, t2.value),
      vsRealized: errorsAgainst(rows, (r) => r.thetaD),
    };
    // K1: superioritas palsu (lo persentil > 0 pada efek 0) — klaim formal satu-satunya.
    res.criteria.K1 = { metric: res.zero.superiority.percentile, pass: passNominal(res.zero.superiority.percentile) };
  }
  if (margin) {
    const rows = rowsOf(margin);
    const t4 = meanOf(rows.map((r) => r.point));
    res.margin = {
      scenario: marginName, sims: margin.sims, failed: margin.failed, invalidReps: margin.methods?.full7?.invalidReps ?? null, ok: rows.length, delta: margin.delta,
      t4: { value: t4, mcSe: sdOf(rows.map((r) => r.point)) / Math.sqrt(rows.length) }, t3: { value: margin.thetaInfo }, t2: t2margin,
      vsT4: errorsAgainst(rows, t4), vsT3: errorsAgainst(rows, margin.thetaInfo),
      vsT2: t2margin?.value === null || t2margin?.value === undefined ? null : errorsAgainst(rows, t2margin.value),
      vsRealized: errorsAgainst(rows, (r) => r.thetaD),
    };
    if (res.margin.vsT2 && t2margin.mcSe) {
      // Kepekaan terhadap ketidakpastian MC T2: batas atas gabungan pada T2 ± 2 SE.
      res.margin.t2Sensitivity = [-2, 2].map((k) => errorsAgainst(rows, t2margin.value + k * t2margin.mcSe).union.hiBelow);
    }
    // K2: "< M" palsu lapisan produk (batas atas gabungan) terhadap target prosedural T4.
    res.criteria.K2 = { metric: res.margin.vsT4.union.hiBelow, pass: passNominal(res.margin.vsT4.union.hiBelow) };
    // K3: terhadap estimand populasi T2 — dilaporkan; > 5% menegaskan larangan klaim batas efek populasi.
    const k3 = res.margin.vsT2?.union.hiBelow ?? null;
    res.criteria.K3 = { metric: k3, large: k3?.p === null || k3 === null ? null : k3.p > LARGE_ERROR };
    // K4: coverage dua sisi CI persentil terhadap T4.
    const cov = res.margin.vsT4.percentile.cover;
    res.criteria.K4 = { metric: cov, pass: cov?.p === null || cov === null ? null : cov.p >= COVERAGE_FLOOR };
  }
  // K5: replikasi/simulasi tidak valid.
  const runsList = [res.zero, res.margin].filter(Boolean);
  if (runsList.length) {
    const failedShare = Math.max(...runsList.map((r) => (r.sims ? r.failed / r.sims : 0)));
    res.criteria.K5 = { failedShare, pass: failedShare <= MAX_INVALID_SHARE };
  }
  return res;
}

/** Konsekuensi praregistrasi dari semua pasangan. */
export function verdict(pairs) {
  const fails = (k, klass) => pairs.filter((p) => p.klass === klass && p.criteria[k]?.pass === false).map((p) => p.name);
  const missing = pairs.filter((p) => !p.zero || !p.margin || (p.margin && !p.margin.t2) || (p.zero && !p.zero.t2)).map((p) => p.name);
  const out = {
    complete: missing.length === 0, missing,
    designReview: [...fails('K1', 'realistis'), ...fails('K4', 'realistis'), ...fails('K5', 'realistis')],
    restrictClaims: [...fails('K1', 'ekstrem'), ...fails('K4', 'ekstrem')],
    productLayerUnusable: fails('K2', 'realistis'),
    productLayerRestricted: fails('K2', 'ekstrem'),
    populationBoundLarge: pairs.filter((p) => p.criteria.K3?.large).map((p) => p.name),
  };
  out.summary = !out.complete ? 'BELUM LENGKAP'
    : out.designReview.length ? 'TINJAU DESAIN (tidak dibekukan)'
      : out.restrictClaims.length || out.productLayerUnusable.length ? 'LULUS DENGAN PEMBATASAN KLAIM' : 'LULUS';
  return out;
}

const pct = (p) => (p?.p === null || p?.p === undefined ? '—' : `${(p.p * 100).toFixed(1).replace('.', ',')}% [${(p.lo * 100).toFixed(1).replace('.', ',')}–${(p.hi * 100).toFixed(1).replace('.', ',')}]`);
const num = (x) => (Number.isFinite(x) ? x.toFixed(3).replace('.', ',') : '—');
const ok = (b) => (b === null || b === undefined ? '—' : b ? 'lulus' : 'GAGAL');

export function renderMarkdown(r) {
  const md = [
    '# Simulasi konfirmasi AL-MOM-01 (data sintetis) — AlphaLens', '',
    `Dibuat ${r.generatedAt}. Praregistrasi docs/29 §21 (v1). Kurung siku = Wilson 95%. Nominal satu sisi ${NOMINAL * 100}%.`, '',
    `**Vonis praregistrasi: ${r.verdict.summary}.**`, '',
    '| DGP | Golongan | K1 superioritas palsu (persentil) | K2 "< M" palsu gabungan vs T4 | K3 gabungan vs T2 | K4 coverage persentil vs T4 | K5 gagal |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.pairs.map((p) => `| ${p.name} | ${p.klass} | ${pct(p.criteria.K1?.metric)} ${ok(p.criteria.K1?.pass)} | ${pct(p.criteria.K2?.metric)} ${ok(p.criteria.K2?.pass)} | `
      + `${pct(p.criteria.K3?.metric)}${p.criteria.K3?.large ? ' > 5%' : ''} | ${pct(p.criteria.K4?.metric)} ${ok(p.criteria.K4?.pass)} | ${ok(p.criteria.K5?.pass)} |`),
    '', '## Target per DGP (efek ≈ margin)', '',
    '| DGP | δ | T4 prosedural ± SE MC | T3 θ_info | T2 populasi ± SE MC | Persentil: hi < T4 · T2 | Basic: hi < T4 · T2 | Gabungan: hi < T4 · T2 | Kepekaan T2 ± 2 SE |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...r.pairs.filter((p) => p.margin).map((p) => {
      const m = p.margin;
      const t2 = m.vsT2;
      return `| ${p.name} | ${num(m.delta)} | ${num(m.t4.value)} ± ${num(m.t4.mcSe)} | ${num(m.t3.value)} | ${m.t2 ? `${num(m.t2.value)} ± ${num(m.t2.mcSe)}` : '—'} | `
        + `${pct(m.vsT4.percentile.hiBelow)} · ${pct(t2?.percentile.hiBelow)} | ${pct(m.vsT4.basic.hiBelow)} · ${pct(t2?.basic.hiBelow)} | `
        + `${pct(m.vsT4.union.hiBelow)} · ${pct(t2?.union.hiBelow)} | ${m.t2Sensitivity ? m.t2Sensitivity.map(pct).join(' … ') : '—'} |`;
    }),
    '', '## Efek 0: superioritas palsu per metode dan target', '',
    '| DGP | T4 ± SE MC | T2 | Persentil | Basic | BC | Persentil vs θ_d terealisasi (lo > θ_d) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.pairs.filter((p) => p.zero).map((p) => `| ${p.name} | ${num(p.zero.t4.value)} ± ${num(p.zero.t4.mcSe)} | ${p.zero.t2 ? (p.zero.t2.byConstruction ? '0 (konstruksi)' : num(p.zero.t2.value)) : '—'} | `
      + `${pct(p.zero.superiority.percentile)} | ${pct(p.zero.superiority.basic)} | ${pct(p.zero.superiority.bc)} | ${pct(p.zero.vsRealized.percentile.loAbove)} |`),
    '', '## Konsekuensi', '',
    `- Tinjau desain (golongan realistis gagal K1/K4/K5): ${r.verdict.designReview.join(', ') || 'tidak ada'}`,
    `- Pembatasan klaim (golongan ekstrem gagal K1/K4): ${r.verdict.restrictClaims.join(', ') || 'tidak ada'}`,
    `- Lapisan produk "< M" tidak dipakai (realistis gagal K2): ${r.verdict.productLayerUnusable.join(', ') || 'tidak ada'}`,
    `- Lapisan produk "< M" dibatasi (ekstrem gagal K2): ${r.verdict.productLayerRestricted.join(', ') || 'tidak ada'}`,
    `- Galat terhadap estimand populasi > 5% (larangan klaim batas efek populasi ditegaskan): ${r.verdict.populationBoundLarge.join(', ') || 'tidak ada'}`,
    `- Belum lengkap: ${r.verdict.missing.join(', ') || 'tidak ada'}`, '',
  ];
  return md.join('\n');
}

/** Gabungkan laporan coverage & oracle menjadi evaluasi. */
export function evaluate({ coverage, oracle }) {
  const scen = new Map();
  for (const rep of coverage) for (const s of rep.scenarios) scen.set(s.name, s);
  const orc = new Map();
  for (const rep of oracle) orc.set(rep.scenario, rep);
  const warnings = [];
  const t2For = (name, s) => {
    const rep = orc.get(name);
    if (!rep || !s) return null;
    const d = rep.set?.delta ?? rep.sc?.delta;
    if (Math.abs((d ?? 0) - (s.delta ?? 0)) > 1e-9) {
      warnings.push(`${name}: δ oracle ${d} ≠ δ coverage ${s.delta}`);
      return null;
    }
    return populationTarget(rep);
  };
  const pairs = PAIRS.map((p) => {
    const zero = scen.get(p[1]) ?? null;
    const margin = scen.get(p[2]) ?? null;
    return evaluatePair(p, { zero, margin, t2zero: t2For(p[1], zero), t2margin: t2For(p[2], margin) });
  });
  return { pairs, verdict: verdict(pairs), warnings };
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: { coverage: { type: 'string' }, oracle: { type: 'string' }, out: { type: 'string', default: join(ROOT, 'reports', 'research') } },
    strict: true,
  });
  const read = async (list) => Promise.all((list ? list.split(',') : []).map(async (f) => JSON.parse(await readFile(resolve(f), 'utf8'))));
  const started = Date.now();
  const result = { generatedAt: new Date(started).toISOString(), ...evaluate({ coverage: await read(v.coverage), oracle: await read(v.oracle) }) };
  const out = resolve(v.out);
  await mkdir(out, { recursive: true });
  const slug = result.generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  await writeFile(join(out, `al-mom-01-confirm-${slug}.json`), JSON.stringify(result, null, 2), 'utf8');
  await writeFile(join(out, `al-mom-01-confirm-${slug}.md`), renderMarkdown(result), 'utf8');
  for (const w of result.warnings) process.stderr.write(`peringatan: ${w}\n`);
  process.stderr.write(`Vonis praregistrasi: ${result.verdict.summary} → ${join(out, `al-mom-01-confirm-${slug}.md`)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`Evaluasi gagal: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
