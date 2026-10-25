// Menyusun laporan tes Markdown dari file hasil eksekusi NYATA Vitest & Playwright.
// Laporan tidak pernah ditulis tangan: bila file hasil tidak ada, skrip gagal.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const VITEST = 'reports/vitest-results.json';
const E2E = 'reports/e2e-results.json';
const OUT = 'docs/laporan/hasil-tes-otomatis.md';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const idOf = (title) => (/^([A-Z0-9]+-[A-Z0-9]+-\d{3})/.exec(title) ?? [])[1] ?? '—';
const esc = (s) => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
const STATUS = { passed: 'LULUS', failed: 'GAGAL', skipped: 'DILEWATI', pending: 'DILEWATI', todo: 'DILEWATI' };

const vitest = readJson(VITEST);
const vitestRows = vitest.testResults.flatMap((file) => file.assertionResults.map((t) => ({
  id: idOf(t.title),
  file: file.name.replace(`${process.cwd()}/`, ''),
  suite: t.ancestorTitles.join(' › '),
  title: t.title,
  status: STATUS[t.status] ?? t.status,
  ms: Math.round(t.duration ?? 0),
})));

const e2e = readJson(E2E);
const e2eRows = [];
const walk = (suite, file) => {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests) {
      const result = test.results.at(-1);
      e2eRows.push({
        id: idOf(spec.title), file, project: test.projectName, title: spec.title,
        status: STATUS[result?.status] ?? result?.status ?? 'tidak dijalankan', ms: result?.duration ?? 0,
      });
    }
  }
  for (const child of suite.suites ?? []) walk(child, child.file ?? file);
};
for (const s of e2e.suites) walk(s, s.file);

const count = (rows, status) => rows.filter((r) => r.status === status).length;
const commit = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim(); } catch { return 'tidak diketahui'; } })();
const categoryOf = (id) => id.split('-')[0];
const byCategory = {};
for (const r of [...vitestRows, ...e2eRows]) {
  const c = categoryOf(r.id);
  byCategory[c] ??= { total: 0, pass: 0 };
  byCategory[c].total += 1;
  if (r.status === 'LULUS') byCategory[c].pass += 1;
}

const lines = [
  '# Hasil Tes Otomatis',
  '',
  '> Dokumen ini **dihasilkan otomatis** oleh `npm run report:tests` dari file hasil eksekusi Vitest dan Playwright.',
  '> Jangan diedit manual.',
  '',
  `- Waktu eksekusi Vitest: ${new Date(vitest.startTime).toISOString()}`,
  `- Commit basis: \`${commit}\` (perubahan yang belum di-commit dapat ikut teruji)`,
  `- Node.js: ${process.version}`,
  '',
  '## Ringkasan',
  '',
  '| Suite | Total | Lulus | Gagal | Dilewati |',
  '|---|---|---|---|---|',
  `| Vitest (unit, positif, negatif, edge, keamanan) | ${vitestRows.length} | ${count(vitestRows, 'LULUS')} | ${count(vitestRows, 'GAGAL')} | ${count(vitestRows, 'DILEWATI')} |`,
  `| Playwright E2E (desktop + mobile) | ${e2eRows.length} | ${count(e2eRows, 'LULUS')} | ${count(e2eRows, 'GAGAL')} | ${count(e2eRows, 'DILEWATI')} |`,
  '',
  '### Per kategori ID',
  '',
  '| Prefiks | Arti | Total | Lulus |',
  '|---|---|---|---|',
  ...Object.entries(byCategory).sort().map(([c, v]) => `| ${c} | ${{ UNIT: 'Unit', POS: 'Positif', NEG: 'Negatif', EDGE: 'Kasus tepi', SEC: 'Keamanan', E2E: 'End-to-end' }[c] ?? c} | ${v.total} | ${v.pass} |`),
  '',
  '## Detail Vitest',
  '',
  '| ID | Tes | File | Status | ms |',
  '|---|---|---|---|---|',
  ...vitestRows.map((r) => `| ${r.id} | ${esc(r.title)} | ${r.file} | ${r.status} | ${r.ms} |`),
  '',
  '## Detail Playwright',
  '',
  '| ID | Tes | Proyek | Status | ms |',
  '|---|---|---|---|---|',
  ...e2eRows.map((r) => `| ${r.id} | ${esc(r.title)} | ${r.project} | ${r.status} | ${r.ms} |`),
  '',
];

mkdirSync('docs/laporan', { recursive: true });
writeFileSync(OUT, lines.join('\n'));
console.log(`Laporan ditulis ke ${OUT}: Vitest ${count(vitestRows, 'LULUS')}/${vitestRows.length}, E2E ${count(e2eRows, 'LULUS')}/${e2eRows.length}`);
