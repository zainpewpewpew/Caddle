// Strip status scanner di app shell (semua halaman): model tampilan MURNI dari GET /api/system/sync (+ kabar muat ulang
// tabel halaman) — nada, label, segmen teks, dan log aktivitas — tanpa DOM agar dapat diuji unit. Jam tampil WIB.
// Tidak ada angka rekaan: nilai yang tidak dilaporkan worker tidak ditampilkan (segmennya dilewati).
// Sumber data: scanner.scan (scan berkala tiap menit), scanner.activity (worker/activity.js, disaring server),
// worker (supervisor: state, via, restartAt), scanner.sync (langkah siklus) — lihat backend/system/workerStatus.js.
import { DISPLAY_TZ_OFFSET_MS, formatInteger, formatRelative } from '../lib/format.js';
import { stageLabel, statusLabel } from './reversalFormat.js';
import { syncHeadline, syncMode } from './syncProgress.js';
import { workerControlLabel } from './workerFormat.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pad2 = (n) => String(n).padStart(2, '0');
const TF_MS = Object.freeze({ '5m': 300_000, '15m': 900_000, '1h': 3_600_000 });
/** Timeframe yang ditampilkan "candle berikutnya tutup": SHORT Scanner 15m, LONG Scanner & Reversal Radar 1h. */
export const STRIP_TIMEFRAMES = Object.freeze(['15m', '1h']);

/** Jam WIB HH:MM:SS. */
export function clockHms(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms + DISPLAY_TZ_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** Jam WIB HH:MM. */
export function clockHm(ms) {
  return isNum(ms) ? clockHms(ms).slice(0, 5) : '—';
}

/** Hitung mundur m:ss (atau j:mm:ss); nilai lewat → 0:00. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil((isNum(ms) ? ms : 0) / 1000));
  const hrs = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return hrs > 0 ? `${hrs}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** Awal candle berikutnya (= saat candle berjalan tutup) untuk timeframe pada waktu `now`. */
export function nextCandleClose(now, timeframe) {
  const ms = TF_MS[timeframe];
  return Math.floor(now / ms) * ms + ms;
}

const STATE_TEXT = Object.freeze({
  QUIET: 'Quiet', EARLY_BULLISH: 'Early bullish', MOMENTUM_BUILDING: 'Momentum building', BREAKOUT: 'Breakout',
  EARLY_BEARISH: 'Early bearish', BREAKDOWN: 'Breakdown', NO_PATTERN: 'Tanpa pola', INVALIDATED: 'Batal', EXPIRED: 'Kedaluwarsa',
});
const codeText = (code) => (typeof code === 'string' ? code.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '—');
const num = (v) => formatInteger(v);
const SOURCE_TEXT = Object.freeze({
  backfill: 'backfill REST', bootstrap: 'histori candle', analysis: 'analisis', ws: 'WebSocket', discovery: 'discovery koin',
  clock: 'sinkron jam', scan: 'scan', validation: 'validasi candle', provisional: 'candle berjalan', 'gap-repair': 'tambal gap',
  monitoring: 'penutupan sinyal', settings: 'pengaturan', scanner: 'scanner',
});

/** Ringkasan sinyal terbuka hasil scan: "sinyal LONG 4 · SHORT 2 · radar 38" ('' bila tidak dilaporkan). */
function openText(open) {
  if (!open || typeof open !== 'object') return '';
  const parts = [['LONG', open.long], ['SHORT', open.short], ['radar', open.radar]].filter(([, v]) => isNum(v));
  return parts.length ? `sinyal terbuka ${parts.map(([k, v]) => `${k} ${num(v)}`).join(' · ')}` : '';
}

/**
 * Teks satu entri log aktivitas (worker/activity.js + entri supervisor sintetis 'worker' / 'worker-crash').
 * @param {object} e
 */
export function activityText(e) {
  switch (e?.kind) {
    case 'start': return 'Worker scanner mulai: sinkron jam & discovery koin';
    case 'stopping': return 'Scanner dihentikan';
    case 'discovery':
      if (e.failed) return 'Discovery koin gagal — memakai daftar terakhir, dicoba ulang otomatis';
      return e.cycle === 'rediscovery' ? `Rediscovery berkala: ${num(e.symbols)} koin dipantau` : `Discovery: ${num(e.symbols)} koin dipilih untuk dipindai`;
    case 'bootstrap':
      return `Histori candle disinkron: ${num(e.series)} seri · ${num(e.candles)} candle${e.failed > 0 ? ` · ${num(e.failed)} seri gagal (dicoba ulang)` : ''}`;
    case 'ws':
      if (e.state === 'open') return e.reconnects > 0 ? `Stream live Binance tersambung ulang (ke-${num(e.reconnects)})` : 'Stream live Binance tersambung — harga mengalir';
      return 'Stream live Binance terputus — menyambung ulang…';
    case 'scan': {
      const parts = [`Scan #${num(e.seq)}: ${num(e.fresh)}/${num(e.series)} seri mutakhir`];
      if (isNum(e.priced)) parts.push(`harga live ${num(e.priced)} seri`);
      if (e.repaired > 0) parts.push(`${num(e.repaired)} seri ditambal`);
      if (e.stale > 0) parts.push(`${num(e.stale)} seri tertinggal`);
      const open = openText(e.open);
      if (open) parts.push(open);
      return parts.join(' · ');
    }
    case 'candles': return `Candle ${e.timeframe} ${clockHm(e.closeTime + 1)} tutup · ${num(e.count)} koin dianalisis`;
    case 'signal': {
      const state = STATE_TEXT[e.state] ?? codeText(e.state);
      return `Sinyal ${e.direction === 'SHORT' ? 'SHORT' : 'LONG'} ${e.symbol ?? '—'} ${e.timeframe ?? ''} → ${state}${e.tier ? ` (tier ${e.tier})` : ''}`;
    }
    case 'reversal':
      return `Reversal Radar ${e.symbol ?? '—'} ${e.timeframe ?? ''} → ${e.stage ? stageLabel(e.stage) : statusLabel(e.status)}`;
    case 'error': {
      const where = e.symbol ? ` ${e.symbol}${e.timeframe ? ` ${e.timeframe}` : ''}` : '';
      return `Galat ${SOURCE_TEXT[e.source] ?? e.source ?? 'scanner'}${where}: ${e.message || 'tanpa pesan'}`;
    }
    case 'worker':
      return e.via === 'autostart' ? 'Scanner dijalankan otomatis saat server start (npm start)'
        : e.via === 'auto-restart' ? 'Scanner dijalankan ulang otomatis setelah berhenti tak terduga'
          : 'Scanner dijalankan dari website';
    case 'worker-crash':
      return `Scanner berhenti tak terduga — ${workerControlLabel({ state: 'crashed', exitCode: e.exitCode, signal: e.signal }).text}`
        + (isNum(e.restartAt) ? `; dijalankan ulang otomatis ${clockHms(e.restartAt)}` : '');
    default: return codeText(e?.kind);
  }
}

/** Nada penanda entri (warna hanya untuk keadaan): galat merah, peringatan kuning, sinyal mengikuti arah. */
export function activityTone(e) {
  switch (e?.kind) {
    case 'error':
    case 'worker-crash': return 'error';
    case 'ws': return e.state === 'open' ? 'ok' : 'warn';
    case 'discovery': return e.failed ? 'warn' : 'idle';
    case 'scan': return e.stale > 0 ? 'warn' : 'ok';
    case 'signal': return e.direction === 'SHORT' ? 'bear' : 'bull';
    case 'reversal': return 'bull';
    case 'worker': return 'ok';
    default: return 'idle';
  }
}

/**
 * Log aktivitas untuk panel "Aktivitas": entri worker (heartbeat) + entri supervisor sintetis (dijalankan / crash),
 * terbaru lebih dulu, maks `limit`.
 * @param {object|null} d data sync ternormalisasi (syncProgress.js)
 */
export function activityEntries(d, limit = 30) {
  if (!d) return [];
  const list = Array.isArray(d.scanner?.activity) ? d.scanner.activity.map((e) => ({ ...e, key: `w${e.id}` })) : [];
  const w = d.worker;
  if (isNum(w?.startedAt)) list.push({ key: `sup-start-${w.startedAt}`, kind: 'worker', at: w.startedAt, via: w.via });
  if (w?.state === 'crashed' && isNum(w.stoppedAt)) {
    list.push({ key: `sup-crash-${w.stoppedAt}`, kind: 'worker-crash', at: w.stoppedAt, exitCode: w.exitCode, signal: w.signal, restartAt: w.restartAt });
  }
  // Terbaru dulu; pada stempel yang sama, entri yang ditambahkan belakangan (id lebih besar) di atas.
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (b.e.at - a.e.at) || (b.i - a.i))
    .slice(0, limit)
    .map(({ e }) => ({ ...e, text: activityText(e), tone: activityTone(e), time: clockHms(e.at) }));
}

/** Selisih jam server − jam klien dari data sync (0 bila tidak diketahui), untuk hitung mundur yang tetap tepat. */
export function serverSkewMs(d) {
  return isNum(d?.serverTime) && isNum(d?.requestedAt) ? d.serverTime - d.requestedAt : 0;
}

const seg = (key, text, title, extra = {}) => ({ key, text, title: title ?? null, ...extra });

/**
 * Model strip status.
 * @param {object|null} d data sync ternormalisasi (null = memuat)
 * @param {{ now?: number, page?: { source: string, at: number, nextAt: number|null }|null }} [options]
 *   now: jam server perkiraan (Date.now() + serverSkewMs); page: kabar muat ulang tabel halaman aktif (liveData.js)
 * @returns {{ mode: string, tone: string, live: boolean, label: string, detail: string|null,
 *   segments: Array<{ key: string, text: string, title: string|null }>, progress: null|{ ratio: number, label: string }, busy: boolean }}
 */
export function stripModel(d, { now = Date.now(), page = null } = {}) {
  const mode = syncMode(d);
  const base = { mode, tone: 'idle', live: false, label: '', detail: null, segments: [], progress: null, busy: false };
  const w = d?.worker ?? null;
  switch (mode) {
    case 'loading': return { ...base, label: 'Memuat status scanner…', busy: true };
    case 'off': {
      if (w?.state === 'crashed') {
        const label = workerControlLabel(w).text;
        if (isNum(w.restartAt)) {
          return { ...base, tone: 'error', label: 'Scanner berhenti tak terduga',
            detail: `${label} — dijalankan ulang otomatis ${clockHms(w.restartAt)} (dalam ${formatCountdown(w.restartAt - now)})` };
        }
        return { ...base, tone: 'error', label: 'Scanner berhenti tak terduga', detail: `${label} — data tidak diperbarui. Jalankan lagi lewat tombol "Jalankan scanner".` };
      }
      if (w && w.enabled === false) {
        return { ...base, label: 'Scanner tidak berjalan', detail: 'Kontrol dari website nonaktif — jalankan npm run worker di terminal lain.' };
      }
      return { ...base, label: 'Scanner berhenti', detail: 'Data & harga tidak diperbarui. Tekan "Jalankan scanner" di LONG/SHORT Scanner atau System Health.' };
    }
    case 'waiting': return { ...base, tone: 'warn', label: 'Memulai scanner…', detail: 'Proses worker dijalankan — membuka database & menyiapkan koneksi Binance.', busy: true };
    case 'stopping': return { ...base, tone: 'warn', label: 'Menghentikan scanner…', busy: true };
    case 'stale': {
      const at = d.scanner?.heartbeatAt;
      return { ...base, tone: 'error', label: 'Scanner tidak melapor',
        detail: `Heartbeat worker terakhir ${isNum(at) ? formatRelative(at, now) : '—'} — periksa terminal npm start.` };
    }
    case 'legacy': return { ...base, tone: 'warn', label: 'Scanner berjalan', detail: 'Worker versi lama tidak melaporkan progres — jalankan ulang scanner.' };
    default: break;
  }

  const sc = d.scanner;
  const sync = sc.sync ?? {};
  const head = syncHeadline(d);
  if (['clock', 'discovery', 'bootstrap'].includes(sync.step) || (sync.step === 'idle' && sync.cycle === null)) {
    const rediscovery = sync.cycle === 'rediscovery';
    let detail = 'Menyiapkan siklus pertama…';
    let progress = null;
    if (sync.step === 'clock') detail = 'Menyamakan jam dengan server Binance…';
    else if (sync.step === 'discovery') detail = 'Memilih koin yang dipindai (exchangeInfo, ticker 24 jam, spread)…';
    else if (sync.step === 'bootstrap') {
      if (isNum(sync.progress)) {
        detail = `Mengunduh histori candle ${num(sync.streamsDone)}/${num(sync.streamsTotal)} seri (${Math.floor(sync.progress * 100)}%)`;
        progress = { ratio: sync.progress, label: `Histori candle ${num(sync.streamsDone)} dari ${num(sync.streamsTotal)} seri` };
      } else detail = 'Mengunduh histori candle…';
    }
    // Rediscovery berkala berjalan di samping stream live: tetap "live", dengan keterangan siklus.
    if (!rediscovery || !(sc.streams > 0)) {
      return { ...base, tone: 'warn', label: 'Sinkron data', detail, progress, busy: progress === null };
    }
  }
  if (sync.step === 'idle') {
    return { ...base, tone: 'warn', label: 'Tanpa stream aktif', detail: 'Siklus selesai tanpa koin dipantau — dicoba lagi otomatis (lihat Aktivitas).' };
  }

  // Live (atau rediscovery di samping stream live).
  const wsOpen = d.binance?.ws === 'open';
  const segments = [];
  const scan = sc.scan ?? null;
  const nextScanAt = isNum(sc.nextScanAt) ? sc.nextScanAt : null;
  if (scan) {
    const next = nextScanAt !== null ? ` · berikutnya ${formatCountdown(nextScanAt - now)}` : '';
    segments.push(seg('scan', `Scan #${num(scan.seq)} ${clockHms(scan.at)}${next}`,
      'Scan berkala tiap menit: semua seri diperiksa, candle yang tertinggal diambil ulang dari Binance.'));
  } else if (nextScanAt !== null) {
    segments.push(seg('scan', `Scan pertama ${clockHms(nextScanAt)} (${formatCountdown(nextScanAt - now)})`, 'Scan berkala tiap menit dimulai setelah histori candle selesai.'));
  }
  const series = scan?.series ?? sc.streams;
  const fresh = scan?.fresh ?? (isNum(sc.streams) && isNum(sc.staleStreams) ? sc.streams - sc.staleStreams : null);
  const symbols = scan?.symbols ?? sc.symbols;
  if (isNum(symbols) || isNum(series)) {
    const parts = [];
    if (isNum(symbols)) parts.push(`${num(symbols)} koin`);
    if (isNum(series)) parts.push(isNum(fresh) ? `${num(fresh)}/${num(series)} seri mutakhir` : `${num(series)} seri`);
    segments.push(seg('coverage', parts.join(' · '), 'Seri = koin × timeframe (5m grafik, 15m SHORT, 1h LONG & Reversal Radar).',
      { tone: isNum(fresh) && isNum(series) && fresh < series ? 'warn' : undefined }));
  }
  // Jumlah seri yang menerima harga candle berjalan (dihitung saat scan) — bukan "x detik lalu": harga mengalir tiap
  // detik, sedangkan stempel scan hanya diperbarui tiap menit sehingga umurnya akan menyesatkan.
  if (isNum(scan?.priced) && isNum(scan?.series)) {
    segments.push(seg('price', `Harga live ${num(scan.priced)}/${num(scan.series)} seri`,
      'Seri yang menerima harga candle berjalan dari WebSocket Binance dalam 2 menit terakhir (dihitung saat scan). Kolom Harga tabel memakai harga ini.',
      { tone: scan.priced < scan.series ? 'warn' : undefined }));
  }
  const closes = STRIP_TIMEFRAMES.map((tf) => ({ tf, at: nextCandleClose(now, tf) }));
  segments.push(seg('candle', `Candle ${closes.map((c) => `${c.tf} tutup ${clockHm(c.at)}`).join(' · ')} (${formatCountdown(closes[0].at - now)})`,
    'Sinyal baru dikonfirmasi saat candle tertutup: SHORT 15m, LONG & Reversal Radar 1h.'));
  if (page && isNum(page.at)) {
    const next = isNum(page.nextAt) ? ` · berikutnya ${formatCountdown(page.nextAt - now)}` : '';
    segments.push(seg('page', `Tabel diperbarui ${clockHms(page.at)}${next}`, `${page.source}: dimuat ulang otomatis tiap menit selama scanner berjalan.`));
  }
  const rediscovering = sync.cycle === 'rediscovery' && ['clock', 'discovery', 'bootstrap'].includes(sync.step);
  return {
    ...base,
    tone: wsOpen ? 'ok' : 'warn',
    live: wsOpen && head.live,
    label: wsOpen ? 'Live' : 'Menyambung ulang',
    detail: rediscovering ? 'Rediscovery berkala berjalan — stream live tetap aktif.' : null,
    segments,
  };
}
