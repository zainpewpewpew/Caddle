// Snapshot cache riset historis (docs/29 §19). Menyalin file bulan cache (`<simbol>/<tf|funding>/YYYY-MM.json`) yang
// bulannya < 2026-11 dari cache hidup ke folder baca-saja, menulis manifest SHA-256, lalu menandai semua file baca-saja.
// Snapshot hanya bertambah: file yang sudah ada tidak pernah ditimpa, dan isi yang berbeda menghentikan proses.
// Tidak membaca isi candle selain untuk hash; tidak menghitung hasil apa pun.
//
// Pakai: npm run research:snapshot [-- --from-dir data/backtest-cache --to-dir data/research-snapshot --dry-run]

import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { RESEARCH_SNAPSHOT_DIR, SNAPSHOT_FIRST_EXCLUDED_MONTH } from './research-window-guard.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MONTH_FILE = /^(\d{4}-\d{2})\.json$/;
const MANIFEST = 'MANIFEST.json';
const log = (m) => process.stderr.write(`${m}\n`);

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** File bulan yang boleh masuk snapshot (bulan < bulan awal jendela). */
export function snapshotEligible(name, firstExcluded = SNAPSHOT_FIRST_EXCLUDED_MONTH) {
  const m = MONTH_FILE.exec(name);
  return Boolean(m) && m[1] < firstExcluded;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Atur mode semua folder di bawah (dan termasuk) dir. */
async function setDirModes(dir, mode) {
  await chmod(dir, mode === 0o555 ? 0o755 : mode);
  for (const e of await readdir(dir, { withFileTypes: true })) if (e.isDirectory()) await setDirModes(join(dir, e.name), mode);
  await chmod(dir, mode);
}

/** Hash pohon snapshot: SHA-256 atas baris "path relatif + SHA-256", diurutkan menurut path (cara docs/26 §8). */
export const treeHash = (files) => sha256(files.map((f) => `${f.path} ${f.sha256}`).sort().join('\n'));

/**
 * Buat/perbarui snapshot. Mengembalikan ringkasan; melempar galat bila file yang sudah ada di snapshot berbeda isinya
 * dari sumber (snapshot tidak boleh berubah).
 */
export async function buildSnapshot({ fromDir, toDir, dryRun = false, firstExcluded = SNAPSHOT_FIRST_EXCLUDED_MONTH, now = Date.now() }) {
  const source = await walk(fromDir);
  // Bit tulis folder dibuka hanya selama proses ini menambah bulan baru.
  if (!dryRun && await exists(toDir)) await setDirModes(toDir, 0o755);
  const copied = [];
  const kept = [];
  const skipped = [];
  for (const file of source.sort()) {
    const rel = relative(fromDir, file).split(sep).join('/');
    const name = rel.split('/').at(-1);
    if (!snapshotEligible(name, firstExcluded)) {
      skipped.push(rel);
      continue;
    }
    const buf = await readFile(file);
    const hash = sha256(buf);
    const dest = join(toDir, ...rel.split('/'));
    if (await exists(dest)) {
      const old = sha256(await readFile(dest));
      if (old !== hash) throw new Error(`snapshot berubah: ${rel} di sumber berbeda dari snapshot (snapshot tidak boleh ditimpa)`);
      kept.push({ path: rel, sha256: hash, bytes: buf.length });
      continue;
    }
    if (!dryRun) {
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(file, dest);
      await chmod(dest, 0o444);
    }
    copied.push({ path: rel, sha256: hash, bytes: buf.length });
  }
  const files = [...kept, ...copied].sort((a, b) => (a.path < b.path ? -1 : 1));
  const months = files.map((f) => MONTH_FILE.exec(f.path.split('/').at(-1))[1]).sort();
  const manifest = {
    createdAt: new Date(now).toISOString(), firstExcludedMonth: firstExcluded, files: files.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0), monthFrom: months[0] ?? null, monthTo: months.at(-1) ?? null,
    treeHash: treeHash(files), list: files,
  };
  if (!dryRun) {
    await mkdir(toDir, { recursive: true });
    const mf = join(toDir, MANIFEST);
    if (await exists(mf)) await chmod(mf, 0o644);
    await writeFile(mf, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await chmod(mf, 0o444);
    await setDirModes(toDir, 0o555);
  }
  return { copied: copied.length, kept: kept.length, skipped: skipped.length, skippedSample: skipped.slice(0, 5), manifest };
}

async function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'from-dir': { type: 'string', default: 'data/backtest-cache' }, 'to-dir': { type: 'string', default: RESEARCH_SNAPSHOT_DIR },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const res = await buildSnapshot({ fromDir: resolve(ROOT, v['from-dir']), toDir: resolve(ROOT, v['to-dir']), dryRun: v['dry-run'] });
  const m = res.manifest;
  log(`${v['dry-run'] ? '(uji kering) ' : ''}snapshot: ${res.copied} file baru, ${res.kept} sudah ada, ${res.skipped} dilewati (bulan ≥ ${m.firstExcludedMonth} atau bukan file bulan)`);
  log(`isi: ${m.files} file, ${(m.bytes / 1e6).toFixed(1)} MB, bulan ${m.monthFrom} … ${m.monthTo}; hash pohon ${m.treeHash}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Snapshot gagal: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
