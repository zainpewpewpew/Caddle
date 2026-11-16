import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSnapshot, snapshotEligible } from '../../../scripts/research-snapshot.js';
import { RESEARCH_SNAPSHOT_DIR, SNAPSHOT_FIRST_EXCLUDED_MONTH } from '../../../scripts/research-window-guard.js';

async function writable(dir) {
  await chmod(dir, 0o755);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await writable(p);
    else await chmod(p, 0o644);
  }
}

async function put(root, rel, body) {
  const p = join(root, ...rel.split('/'));
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, body, 'utf8');
}

describe('snapshot cache riset historis (docs/29 §19)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'snap-')); });
  afterEach(async () => {
    await writable(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it('UNIT-SNAP-001 hanya bulan < 2026-11; folder & file baca-saja; hanya bertambah; isi berubah ditolak', async () => {
    expect(RESEARCH_SNAPSHOT_DIR).toBe('data/research-snapshot');
    expect(SNAPSHOT_FIRST_EXCLUDED_MONTH).toBe('2026-11');
    expect(snapshotEligible('2026-10.json')).toBe(true);
    expect(snapshotEligible('2026-11.json')).toBe(false);
    expect(snapshotEligible('2027-01.json')).toBe(false);
    expect(snapshotEligible('catatan.json')).toBe(false);

    const src = join(dir, 'src');
    const dst = join(dir, 'snap');
    await put(src, 'AUSDT/1h/2026-09.json', '{"a":1}');
    await put(src, 'AUSDT/1h/2026-11.json', '{"jendela":1}');
    await put(src, 'AUSDT/funding/2026-10.json', '{"f":1}');
    const r1 = await buildSnapshot({ fromDir: src, toDir: dst, now: 0 });
    expect(r1).toMatchObject({ copied: 2, kept: 0, skipped: 1 });
    expect(r1.manifest).toMatchObject({ files: 2, monthFrom: '2026-09', monthTo: '2026-10', firstExcludedMonth: '2026-11' });
    await expect(stat(join(dst, 'AUSDT', '1h', '2026-11.json'))).rejects.toThrow();
    expect((await stat(join(dst, 'AUSDT', '1h', '2026-09.json'))).mode & 0o222).toBe(0);
    expect((await stat(join(dst, 'AUSDT', '1h'))).mode & 0o222).toBe(0);
    expect(JSON.parse(await readFile(join(dst, 'MANIFEST.json'), 'utf8')).treeHash).toBe(r1.manifest.treeHash);

    // Jalankan ulang + simbol baru: folder baca-saja dibuka sementara, file lama tidak disentuh.
    await put(src, 'BUSDT/1h/2026-08.json', '{"b":1}');
    const r2 = await buildSnapshot({ fromDir: src, toDir: dst, now: 1 });
    expect(r2).toMatchObject({ copied: 1, kept: 2 });
    expect(r2.manifest.treeHash).not.toBe(r1.manifest.treeHash);

    // Sumber berubah untuk bulan yang sudah di-snapshot → galat, snapshot tidak ditimpa.
    await put(src, 'AUSDT/1h/2026-09.json', '{"a":2}');
    await expect(buildSnapshot({ fromDir: src, toDir: dst, now: 2 })).rejects.toThrow(/snapshot berubah/);
    expect(await readFile(join(dst, 'AUSDT', '1h', '2026-09.json'), 'utf8')).toBe('{"a":1}');

    // Uji kering tidak menulis apa pun.
    const dry = await buildSnapshot({ fromDir: src, toDir: join(dir, 'kering'), dryRun: true, now: 3 });
    expect(dry.copied).toBe(3);
    await expect(stat(join(dir, 'kering'))).rejects.toThrow();
  });
});
