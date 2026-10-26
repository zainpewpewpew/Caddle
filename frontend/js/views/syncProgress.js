// Proses sync scanner yang terlihat langsung: stepper Sinkron jam → Discovery simbol → Backfill candle (REST) →
// Stream live (WebSocket) → Analisis pola, dari progres sync di heartbeat worker (status().sync di worker/scanner.js,
// disaring backend/system/workerStatus.js). Data dari GET /api/system/sync sebagai polling LATAR (tidak memperpanjang
// idle timeout sesi): tiap 2 detik selama worker memulai/sinkron jam/discovery/backfill, tiap 10 detik saat live atau
// tidak berjalan. Satu poller dipakai bersama semua tampilan di halaman dan berhenti sendiri setelah elemennya dilepas.
// Tidak ada angka rekaan: nilai yang tidak diketahui tampil '—'; teks dari server selalu lewat textContent (h()).
// Kontrak, cadence, dan cara menyematkan varian ringkas: docs/09-proses-sync.md.
import { api } from '../lib/api.js';
import { emptyState, panel, statusPill } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { EMPTY, formatInteger, formatRelative, formatTime } from '../lib/format.js';
import { binancePill } from './workerFormat.js';

const SYNC_URL = '/api/system/sync';
const FAST_MS = 2_000;
const SLOW_MS = 10_000;
/** Jendela pemantauan cepat setelah tombol scanner ditekan (requestSyncRefresh). */
const BURST_MS = 20_000;
/** Worker yang baru dijalankan tetapi belum menulis heartbeat dipantau cepat selama jendela ini. */
const STARTUP_MS = 30_000;
/** Elemen yang tidak pernah terpasang di halaman selama ini dianggap dibuang (view basi): berhenti dipantau. */
const MOUNT_GRACE_MS = 5_000;
const ERRORS_SHOWN = 3;

const STEPS = Object.freeze([
  { key: 'clock', label: 'Sinkron jam' },
  { key: 'discovery', label: 'Discovery simbol' },
  { key: 'bootstrap', label: 'Backfill candle (REST)' },
  { key: 'stream', label: 'Stream live (WebSocket)' },
  { key: 'analysis', label: 'Analisis pola' },
]);
const LABEL = Object.fromEntries(STEPS.map((s) => [s.key, s.label]));
/** Langkah siklus (sebelum live), urut. */
const CYCLE_STEPS = Object.freeze(['clock', 'discovery', 'bootstrap']);
/** Status ringkasan yang berarti heartbeat masih segar (lihat summarizeWorker). */
const LIVE_STATUSES = new Set(['ok', 'starting', 'degraded', 'stopping', 'unknown']);
const STATE_TEXT = { done: 'Selesai', active: 'Berjalan', live: 'Aktif', pending: 'Menunggu' };
const WS_TEXT = { connecting: 'Menghubungkan WebSocket…', reconnecting: 'Menyambung ulang WebSocket…' };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- data ----------

/**
 * Menyeragamkan payload GET /api/system/sync dan GET /api/system/status (workerControl, ingestion.recentErrors),
 * sehingga `initial` boleh berasal dari salah satunya. Tanpa `scanner` → null (dimuat dari server).
 */
function normalize(data) {
  if (!data || typeof data !== 'object' || !data.scanner) return null;
  const errors = Array.isArray(data.recentErrors) ? data.recentErrors : data.ingestion?.recentErrors;
  return {
    serverTime: isNum(data.serverTime) ? data.serverTime : null,
    worker: data.worker ?? data.workerControl ?? null,
    scanner: data.scanner,
    binance: data.binance ?? null,
    recentErrors: Array.isArray(errors) ? errors : [],
    // Waktu request dikirim (Date.now() klien); diisi poll(), null untuk data awal. Pelanggan onData memakainya untuk
    // mengabaikan respons yang diminta sebelum state yang sudah dipegangnya (urutan respons tidak dijamin).
    requestedAt: null,
  };
}

const nowOf = (d) => (isNum(d?.serverTime) ? d.serverTime : Date.now());

/**
 * Mode tampilan: loading | off | waiting | stopping | stale | legacy | sync. Supervisor (worker) didahulukan:
 * child yang sudah keluar berarti heartbeat yang masih tampak segar bukan worker yang berjalan.
 */
function modeOf(d) {
  if (!d) return 'loading';
  const sc = d.scanner;
  const state = d.worker?.state;
  if (state === 'stopped' || state === 'crashed') return 'off';
  if (state === 'stopping' || sc.status === 'stopping') return 'stopping';
  const beatLive = LIVE_STATUSES.has(sc.status);
  // Heartbeat yang ditulis sebelum child ini dijalankan berasal dari run sebelumnya.
  const previousRun = state === 'running' && isNum(d.worker.startedAt) && isNum(sc.heartbeatAt) && sc.heartbeatAt < d.worker.startedAt;
  // Heartbeat run ini pernah ditulis lalu basi: child hidup tetapi berhenti melapor — bukan "menunggu heartbeat pertama".
  if (state === 'running' && sc.status === 'stale' && !previousRun) return 'stale';
  if (state === 'starting' || (state === 'running' && (!beatLive || previousRun))) return 'waiting';
  if (sc.status === 'stale') return 'stale';
  if (!beatLive) return 'off';
  return sc.sync ? 'sync' : 'legacy';
}

const syncOf = (d) => d.scanner.sync;
const inCycle = (sync) => CYCLE_STEPS.includes(sync.step);
/** Worker menunggu siklus pertama (fase starting, langkah idle sebelum siklus apa pun). */
const preparing = (sync) => sync.step === 'idle' && sync.cycle === null;

/** Jeda polling berikutnya (lihat docs/09-proses-sync.md §Cadence). */
function cadence(d, burstUntil) {
  if (Date.now() < burstUntil) return FAST_MS;
  switch (modeOf(d)) {
    case 'loading':
    case 'stopping':
      return FAST_MS;
    case 'waiting': {
      const since = d.worker?.startedAt;
      return d.worker?.state === 'starting' || !isNum(since) || nowOf(d) - since < STARTUP_MS ? FAST_MS : SLOW_MS;
    }
    case 'sync':
      return inCycle(syncOf(d)) || preparing(syncOf(d)) ? FAST_MS : SLOW_MS;
    default:
      return SLOW_MS;
  }
}

/** closeTime candle = waktu server Binance; dikoreksi offset jam agar sebanding dengan jam host (serverTime). */
function candleAgo(d) {
  const at = d.scanner.sync?.lastCandleAt;
  if (!isNum(at)) return EMPTY;
  const offset = isNum(d.scanner.clockOffsetMs) ? d.scanner.clockOffsetMs : 0;
  return formatRelative(at - offset, nowOf(d));
}

const ago = (d, at) => (isNum(at) ? formatRelative(at, nowOf(d)) : EMPTY);

/** Ringkasan satu baris: { tone, text, live } — badge panel, varian ringkas, dan teks pengumuman aria-live. */
function headline(d) {
  switch (modeOf(d)) {
    case 'loading': return { tone: 'idle', text: 'Memuat…', live: false };
    case 'off': return { tone: 'idle', text: 'Tidak berjalan', live: false };
    case 'waiting': return { tone: 'warn', text: 'Memulai worker…', live: false };
    case 'stopping': return { tone: 'warn', text: 'Menghentikan…', live: false };
    case 'stale': return { tone: 'error', text: 'Heartbeat basi', live: false };
    case 'legacy': return { tone: 'warn', text: 'Progres tidak dilaporkan', live: false };
    default: break;
  }
  const sync = syncOf(d);
  if (inCycle(sync)) return { tone: 'warn', text: LABEL[sync.step], live: false };
  if (sync.step === 'live') {
    return d.binance?.ws === 'open'
      ? { tone: 'ok', text: 'Live', live: true }
      : { tone: 'warn', text: 'Menyambung WebSocket', live: false };
  }
  if (preparing(sync)) return { tone: 'warn', text: 'Menyiapkan siklus', live: false };
  if (sync.step === 'idle') return { tone: 'warn', text: 'Tanpa stream aktif', live: false };
  return { tone: 'idle', text: 'Langkah tidak dikenal', live: false };
}

// ---------- poller bersama ----------

const hub = { subs: new Set(), data: null, timer: null, due: Infinity, inflight: false, again: false, burstUntil: 0 };

/** Menjadwalkan polling; jadwal yang sudah lebih awal dipertahankan. */
function plan(ms) {
  const at = Date.now() + ms;
  if (hub.timer !== null && hub.due <= at) return;
  clearTimeout(hub.timer);
  hub.due = at;
  hub.timer = setTimeout(poll, ms);
}

/** Membuang pelanggan yang elemennya sudah dilepas (atau tidak pernah terpasang); false bila tidak ada lagi. */
function prune() {
  const now = Date.now();
  for (const sub of hub.subs) {
    if (sub.el.isConnected) sub.mounted = true;
    else if (sub.mounted || now - sub.createdAt > MOUNT_GRACE_MS) hub.subs.delete(sub);
  }
  return hub.subs.size > 0;
}

async function poll() {
  hub.timer = null;
  hub.due = Infinity;
  if (!prune()) return;
  if (hub.inflight) {
    hub.again = true;
    return;
  }
  hub.inflight = true;
  const requestedAt = Date.now();
  let next = null;
  try {
    // Polling otomatis bukan aktivitas pengguna: tidak memperpanjang idle timeout sesi.
    next = normalize(await api(SYNC_URL, { background: true }));
  } catch {
    // Error ditampilkan oleh indikator koneksi di topbar; state terakhir tetap tampil.
  } finally {
    hub.inflight = false;
  }
  if (!prune()) return;
  if (next) {
    next.requestedAt = requestedAt;
    hub.data = next;
    for (const sub of hub.subs) sub.render(next);
  }
  const again = hub.again;
  hub.again = false;
  plan(again ? 0 : cadence(hub.data, hub.burstUntil));
}

function subscribe(el, initial, render) {
  const seed = normalize(initial);
  if (seed && (!hub.data || nowOf(seed) >= nowOf(hub.data))) hub.data = seed;
  hub.subs.add({ el, render, mounted: false, createdAt: Date.now() });
  render(seed);
  // Tanpa data awal: muat segera.
  plan(seed ? cadence(seed, hub.burstUntil) : 0);
}

/**
 * Meminta semua tampilan proses sync di halaman memuat ulang segera lalu memantau tiap 2 detik selama 20 detik.
 * Dipanggil setelah tombol Jalankan/Hentikan scanner ditekan agar langkah pertama langsung terlihat.
 */
export function requestSyncRefresh() {
  if (hub.subs.size === 0) return;
  hub.burstUntil = Date.now() + BURST_MS;
  plan(1_000);
}

// ---------- elemen ----------

function busyBar(label, extraClass) {
  return h('div', {
    class: extraClass ? `progress-indeterminate ${extraClass}` : 'progress-indeterminate',
    role: 'progressbar', 'aria-label': label, dataset: { kind: 'busy' },
  });
}

function ratioBar(extraClass) {
  return h('div', {
    class: extraClass ? `sync-bar ${extraClass}` : 'sync-bar',
    role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, dataset: { kind: 'ratio' },
  }, h('span', { class: 'sync-bar__fill' }));
}

function updateRatio(bar, ratio, label) {
  const pct = Math.floor(Math.min(1, Math.max(0, ratio)) * 100);
  bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuenow', String(pct));
  bar.setAttribute('aria-valuetext', `${pct}%`);
  bar.firstElementChild.style.setProperty('--lr-sync-pct', String(pct));
}

/**
 * Mengisi slot bar: null | { kind: 'busy', label } | { kind: 'ratio', ratio, label }. Elemen dibuat ulang hanya
 * bila jenisnya berubah, sehingga animasi & transisi lebar tidak terulang setiap polling.
 */
function setBar(slot, spec, extraClass) {
  const current = slot.firstElementChild;
  if (!spec) {
    if (current) slot.replaceChildren();
    return;
  }
  if (spec.kind === 'busy') {
    if (current?.dataset.kind !== 'busy') slot.replaceChildren(busyBar(spec.label, extraClass));
    else if (current.getAttribute('aria-label') !== spec.label) current.setAttribute('aria-label', spec.label);
    return;
  }
  let bar = current?.dataset.kind === 'ratio' ? current : null;
  if (!bar) {
    bar = ratioBar(extraClass);
    slot.replaceChildren(bar);
  }
  updateRatio(bar, spec.ratio, spec.label);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** Badge status: diganti hanya bila label/tone berubah (titik "live" tidak berkedip tiap polling). */
function setPill(host, { tone, text, live }) {
  const key = `${tone}|${text}|${live}`;
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren(statusPill(tone, text, { live }));
}

// ---------- stepper ----------

const STREAM_BUSY = { kind: 'busy', label: 'Menghubungkan WebSocket Binance' };

/** Spesifikasi tiap langkah dari progres sync: { state, detail, tone?, bar?, current? }. */
function stepSpecs(d) {
  const sc = d.scanner;
  const sync = syncOf(d);
  const at = CYCLE_STEPS.indexOf(sync.step);
  const live = sync.step === 'live';
  // Siklus rediscovery berjalan di samping stream yang sudah live.
  const streaming = live || (at >= 0 && sync.cycle === 'rediscovery' && sc.streams > 0);
  const wsOpen = d.binance?.ws === 'open';
  const cycleState = (i) => (live || at > i ? 'done' : at === i ? 'active' : 'pending');
  const specs = {};

  const clock = { state: cycleState(0) };
  if (clock.state === 'active') {
    clock.detail = 'Mengukur selisih jam host dengan server Binance…';
    clock.bar = { kind: 'busy', label: 'Sinkronisasi jam berjalan' };
  } else if (clock.state === 'done' && sc.clockFault === 'OFFSET_OUT_OF_RANGE') {
    clock.detail = 'Jam host menyimpang > 10 menit dari Binance — periksa NTP';
    clock.tone = 'warn';
  } else if (clock.state === 'done' && sync.clockSynced === false) {
    // Belum ada sync jam yang berhasil: offset masih nilai awal serverClock, bukan hasil pengukuran → tanpa angka.
    clock.detail = 'Sinkron jam gagal — offset belum terukur, dicoba lagi di siklus berikutnya';
    clock.tone = 'warn';
  } else if (clock.state === 'done' && isNum(sc.clockOffsetMs)) {
    clock.detail = `Offset ${formatInteger(sc.clockOffsetMs)} ms terhadap server Binance`;
  }
  specs.clock = clock;

  const discovery = { state: cycleState(1) };
  if (discovery.state === 'active') {
    discovery.detail = 'Mengambil exchangeInfo, ticker 24 jam, dan book ticker…';
    discovery.bar = { kind: 'busy', label: 'Discovery simbol berjalan' };
  } else if (discovery.state === 'done') {
    if (isNum(sync.symbolsDiscovered)) {
      discovery.detail = `${formatInteger(sync.symbolsDiscovered)} simbol terpilih`;
    } else {
      discovery.detail = 'Discovery gagal — memakai daftar simbol terakhir, dicoba ulang otomatis';
      discovery.tone = 'warn';
    }
  }
  specs.discovery = discovery;

  const bootstrap = { state: cycleState(2) };
  const total = sync.streamsTotal;
  const done = sync.streamsDone;
  const failed = isNum(sync.streamsFailed) && sync.streamsFailed > 0 ? ` · ${formatInteger(sync.streamsFailed)} gagal` : '';
  if (bootstrap.state === 'active') {
    if (isNum(sync.progress)) {
      const pct = Math.floor(sync.progress * 100);
      bootstrap.detail = `${formatInteger(done)} / ${formatInteger(total)} seri · ${formatInteger(sync.candlesStored)} candle · ${pct}%${failed}`;
      bootstrap.bar = { kind: 'ratio', ratio: sync.progress, label: `Backfill ${formatInteger(done)} dari ${formatInteger(total)} seri` };
    } else if (total === 0) {
      bootstrap.detail = 'Tidak ada seri baru';
    } else {
      bootstrap.detail = 'Menyiapkan daftar seri…';
      bootstrap.bar = { kind: 'busy', label: 'Backfill candle berjalan' };
    }
  } else if (bootstrap.state === 'done') {
    bootstrap.detail = total === 0 ? 'Tidak ada seri baru di siklus ini'
      : isNum(total) ? `${formatInteger(done)} / ${formatInteger(total)} seri${failed}` : '';
    if (failed) bootstrap.tone = 'warn';
  }
  specs.bootstrap = bootstrap;

  // WebSocket dibuka saat set stream berubah (sebelum backfill selesai): status nyata ditampilkan apa adanya.
  if (wsOpen) {
    specs.stream = {
      state: 'live',
      detail: streaming ? `Terhubung · ${formatInteger(sc.streams)} stream` : 'Terhubung — candle baru diantrekan sampai backfill seri selesai',
    };
  } else if (streaming) {
    specs.stream = { state: 'active', detail: WS_TEXT[d.binance?.ws] ?? 'WebSocket belum terhubung', bar: STREAM_BUSY };
  } else {
    specs.stream = { state: 'pending' };
  }

  specs.analysis = streaming
    ? { state: 'live', detail: isNum(sync.lastAnalysisAt) ? `Terakhir ${ago(d, sync.lastAnalysisAt)}` : 'Menunggu candle tertutup berikutnya (histori backfill tidak dianalisis)' }
    : { state: 'pending', detail: 'Mulai setelah backfill selesai' };

  if (at >= 0) specs[sync.step].current = true;
  return specs;
}

const PENDING_SPECS = Object.fromEntries(STEPS.map((s) => [s.key, { state: 'pending' }]));

function createStepper() {
  const items = STEPS.map(({ key, label }) => {
    const state = h('span', { class: 'sr-only' });
    const detail = h('span', { class: 'sync-step__detail', hidden: true });
    const bar = h('div', { class: 'sync-step__bar' });
    const li = h('li', { class: 'sync-step', 'data-step': key, 'data-state': 'pending' },
      h('span', { class: 'sync-step__marker', 'aria-hidden': 'true' }),
      h('div', { class: 'sync-step__body' }, h('span', { class: 'sync-step__label' }, state, label), detail, bar));
    return { key, li, state, detail, bar };
  });
  const el = h('ol', { class: 'sync-steps', 'aria-label': 'Langkah proses sync', 'data-testid': 'sync-steps' }, items.map((i) => i.li));
  return {
    el,
    update(specs) {
      for (const item of items) {
        const spec = specs[item.key];
        item.li.dataset.state = spec.state;
        if (spec.current) item.li.setAttribute('aria-current', 'step');
        else item.li.removeAttribute('aria-current');
        setText(item.state, `${STATE_TEXT[spec.state]}: `);
        setText(item.detail, spec.detail ?? '');
        item.detail.hidden = !spec.detail;
        if (spec.tone) item.detail.dataset.tone = spec.tone;
        else delete item.detail.dataset.tone;
        setBar(item.bar, spec.bar ?? null);
      }
    },
  };
}

// ---------- fakta ----------

/** [kunci, label, angka (mono)] */
const FACTS = Object.freeze([
  ['cycle', 'Siklus', false],
  ['symbols', 'Simbol dipantau', true],
  ['streams', 'Stream', true],
  ['candles', 'Candle tersimpan siklus ini', true],
  ['lastCandle', 'Candle terakhir', false],
  ['lastAnalysis', 'Analisis terakhir', false],
  ['ws', 'WebSocket', false],
  ['errors', 'Error tercatat', true],
  ['heartbeat', 'Heartbeat worker', false],
]);

function createFacts() {
  const cells = {};
  const el = h('dl', { class: 'kv sync-facts' }, FACTS.flatMap(([key, label, numeric]) => {
    cells[key] = h('dd', { class: numeric ? 'mono' : undefined, 'data-testid': `sync-fact-${key}` });
    return [h('dt', null, label), cells[key]];
  }));
  return {
    el,
    update(d) {
      const sc = d.scanner;
      const sync = sc.sync ?? {};
      const cycle = sync.cycle === 'initial' ? 'Awal' : sync.cycle === 'rediscovery' ? 'Rediscovery berkala' : null;
      setText(cells.cycle, cycle ? `${cycle} · mulai ${ago(d, sync.cycleStartedAt)}` : EMPTY);
      setText(cells.symbols, formatInteger(sc.symbols));
      setText(cells.streams, isNum(sc.streams) ? `${formatInteger(sc.streams)} (basi ${formatInteger(sc.staleStreams)})` : EMPTY);
      setText(cells.candles, formatInteger(sync.candlesStored));
      setText(cells.lastCandle, isNum(sync.lastCandleAt) ? `${candleAgo(d)} · ${formatTime(sync.lastCandleAt)}` : EMPTY);
      setText(cells.lastAnalysis, ago(d, sync.lastAnalysisAt));
      const ws = d.binance?.status ?? 'unknown';
      if (cells.ws.dataset.key !== ws) {
        cells.ws.dataset.key = ws;
        cells.ws.replaceChildren(binancePill(d.binance));
      }
      setText(cells.errors, formatInteger(sc.errors));
      setText(cells.heartbeat, ago(d, sc.heartbeatAt));
    },
  };
}

function errorList(d) {
  const list = d.recentErrors.slice(0, ERRORS_SHOWN);
  if (list.length === 0) return [h('p', { class: 'subtle' }, 'Tidak ada error ingesti tercatat.')];
  return [
    h('h3', { class: 'sync-progress__subtitle' }, 'Error ingesti terakhir'),
    h('ul', { class: 'sync-errors' }, list.map((e) => h('li', null,
      h('span', { class: 'sync-errors__meta mono' }, `${ago(d, e?.at)} · ${typeof e?.source === 'string' ? e.source : EMPTY}`),
      h('span', { class: 'sync-errors__msg' }, typeof e?.message === 'string' ? e.message : EMPTY)))),
  ];
}

// ---------- pesan per mode ----------

/** Pesan di atas stepper: { key, nodes } — diganti hanya bila `key` berubah. */
function messageOf(d, mode) {
  switch (mode) {
    case 'loading':
      return { key: 'loading', nodes: [h('p', null, 'Memuat status proses sync…'), busyBar('Memuat status proses sync')] };
    case 'off': {
      // Kontrol dari website nonaktif (WORKER_CONTROL=false): tidak ada tombol "Jalankan scanner" yang dapat ditekan.
      const manual = d.worker?.enabled === false;
      return {
        key: `off|${d.worker?.state}|${manual}`,
        nodes: [emptyState({
          iconName: 'radar',
          title: manual ? 'Scanner tidak berjalan' : 'Scanner tidak berjalan — tekan Jalankan scanner',
          text: manual
            ? 'Jalankan worker dengan npm run worker di terminal terpisah; langkah sync tampil di sini begitu heartbeat pertama ditulis.'
            : d.worker?.state === 'crashed'
              ? 'Worker terakhir berhenti tak terduga (lihat Kontrol scanner di atas). Langkah sync tampil di sini begitu scanner dijalankan lagi.'
              : 'Langkah sync tampil di sini secara langsung begitu scanner dijalankan: sinkron jam, discovery simbol, backfill candle, stream live, lalu analisis pola.',
        })],
      };
    }
    case 'waiting': {
      const since = d.worker?.startedAt;
      if (d.worker?.state === 'running' && isNum(since) && nowOf(d) - since >= STARTUP_MS) {
        const text = `Belum ada heartbeat dari worker sejak dijalankan ${ago(d, since)}. Periksa log worker di terminal npm start.`;
        return { key: `waiting|${text}`, nodes: [h('div', { class: 'callout callout--warn', role: 'note' }, text)] };
      }
      return { key: 'waiting', nodes: [h('p', null, 'Proses worker dijalankan — menunggu heartbeat pertama (membuka database & migrasi)…'), busyBar('Menunggu worker')] };
    }
    case 'stopping':
      return { key: 'stopping', nodes: [h('p', null, 'Scanner sedang dihentikan — menunggu tugas aktif selesai dan heartbeat akhir.'), busyBar('Menghentikan scanner')] };
    case 'stale': {
      const text = `Heartbeat worker basi (terakhir ${ago(d, d.scanner.heartbeatAt)}) — proses sync tidak dapat dipantau. Candle terakhir tersimpan: ${candleAgo(d)}.`;
      return { key: `stale|${text}`, nodes: [h('div', { class: 'callout callout--bear', role: 'note' }, text)] };
    }
    case 'legacy':
      return {
        key: 'legacy',
        nodes: [h('div', { class: 'callout callout--warn', role: 'note' },
          'Worker yang berjalan tidak melaporkan progres sync (versi lama). Hentikan lalu jalankan ulang scanner untuk melihat langkah prosesnya.')],
      };
    default: {
      const sync = syncOf(d);
      if (preparing(sync)) return { key: 'preparing', nodes: [h('p', null, 'Worker berjalan — menyiapkan siklus pertama…')] };
      if (sync.step === 'idle') {
        return {
          key: 'idle',
          nodes: [h('div', { class: 'callout callout--warn', role: 'note' },
            'Siklus selesai tanpa stream aktif (pengaturan, discovery, atau daftar simbol kosong). Siklus berikutnya mencoba lagi otomatis — lihat error di bawah.')],
        };
      }
      if (sync.cycle === 'rediscovery' && inCycle(sync)) {
        return { key: 'rediscovery', nodes: [h('p', { class: 'subtle' }, 'Siklus rediscovery berkala berjalan — stream live tetap aktif selama discovery & backfill seri baru.')] };
      }
      return { key: 'none', nodes: [] };
    }
  }
}

// ---------- tampilan ----------

/**
 * Panel lengkap "Proses sync scanner" (System Health, di bawah kartu Kontrol scanner).
 * @param {{ initial?: object|null }} [options] initial: payload GET /api/system/sync atau GET /api/system/status
 *   (opsional; tanpa itu status dimuat segera)
 * @returns {HTMLElement}
 */
export function syncProgressPanel({ initial } = {}) {
  const pill = h('span', { 'data-testid': 'sync-progress-state' });
  // Pengumuman pembaca layar hanya saat langkah/mode berubah (bukan tiap polling). Di luar wilayah aria-busy agar
  // tidak ditahan pembaca layar selama proses berjalan.
  const announcer = h('p', { class: 'sr-only', 'aria-live': 'polite', 'data-testid': 'sync-progress-announce' });
  const message = h('div', { class: 'sync-progress__message' });
  const stepper = createStepper();
  const facts = createFacts();
  const grid = h('div', { class: 'grid grid--2 sync-progress__grid' }, stepper.el, facts.el);
  const errors = h('div', { class: 'sync-progress__errors' });
  const body = h('div', { class: 'sync-progress', 'data-testid': 'sync-progress' }, message, grid, errors);
  const el = panel({ title: 'Proses sync scanner', id: 'sync-progress', actions: pill }, announcer, body);
  let announced = null;

  function render(d) {
    const mode = modeOf(d);
    const head = headline(d);
    setPill(pill, head);
    body.dataset.mode = mode;
    body.setAttribute('aria-busy', String(mode === 'loading' || mode === 'waiting' || mode === 'stopping'
      || (mode === 'sync' && (inCycle(syncOf(d)) || preparing(syncOf(d))))));
    // Keadaan pertama setelah halaman dimuat tidak diumumkan; sesudahnya hanya perubahan langkah/mode.
    if (mode !== 'loading') {
      const text = `Proses sync scanner: ${head.text}`;
      if (announced !== null && announced !== text) setText(announcer, text);
      announced = text;
    }

    const msg = messageOf(d, mode);
    if (message.dataset.key !== msg.key) {
      message.dataset.key = msg.key;
      message.replaceChildren(...msg.nodes);
    }
    const showSteps = mode === 'sync' || mode === 'waiting';
    const showFacts = mode === 'sync' || mode === 'legacy';
    grid.hidden = !(showSteps || showFacts);
    stepper.el.hidden = !showSteps;
    facts.el.hidden = !showFacts;
    // Satu kolom bila hanya salah satu yang tampil.
    grid.classList.toggle('grid--2', showSteps && showFacts);
    if (showSteps) stepper.update(mode === 'sync' ? stepSpecs(d) : PENDING_SPECS);
    if (showFacts) facts.update(d);
    const showErrors = mode === 'sync' || mode === 'legacy' || mode === 'stale';
    errors.hidden = !showErrors;
    if (showErrors) errors.replaceChildren(...errorList(d));
  }

  subscribe(el, initial, render);
  return el;
}

/**
 * Varian ringkas satu baris untuk disematkan di samping tombol Jalankan/Hentikan scanner: label langkah + bar kecil +
 * 'x/y seri', atau 'Live · candle terakhir … lalu'. Tanpa wilayah aria-live (pengumuman milik panel lengkap).
 * @param {{ initial?: object|null, onData?: (d: object) => void }} [options] initial: sama dengan syncProgressPanel;
 *   onData: dipanggil setelah setiap render dengan data ternormalisasi — d.worker = snapshot supervisor (bentuk
 *   GET /api/system/worker), d.requestedAt = waktu request dikirim — agar pemakainya (kontrol scanner persisten) dapat
 *   mengadopsi state supervisor yang lebih segar daripada polling-nya sendiri. Tidak dipanggil untuk data null (memuat).
 * @returns {HTMLElement}
 */
export function syncProgressInline({ initial, onData } = {}) {
  const pill = h('span', { class: 'sync-inline__state' });
  const bar = h('div', { class: 'sync-inline__bar' });
  const text = h('span', { class: 'sync-inline__text num', hidden: true });
  const el = h('div', { class: 'sync-inline', 'data-testid': 'sync-inline' }, pill, bar, text);

  function render(d) {
    const mode = modeOf(d);
    setPill(pill, headline(d));
    el.dataset.mode = mode;
    let barSpec = null;
    let line = '';
    if (mode === 'sync') {
      const sync = syncOf(d);
      if (sync.step === 'bootstrap' && isNum(sync.progress)) {
        barSpec = { kind: 'ratio', ratio: sync.progress, label: `Backfill ${formatInteger(sync.streamsDone)} dari ${formatInteger(sync.streamsTotal)} seri` };
        line = `${formatInteger(sync.streamsDone)}/${formatInteger(sync.streamsTotal)} seri`;
      } else if (inCycle(sync) || preparing(sync)) {
        barSpec = { kind: 'busy', label: 'Proses sync berjalan' };
      } else if (sync.step === 'live') {
        line = `· candle terakhir ${candleAgo(d)}`;
      }
    } else if (mode === 'loading' || mode === 'waiting' || mode === 'stopping') {
      barSpec = { kind: 'busy', label: 'Proses scanner berjalan' };
    }
    setBar(bar, barSpec, 'sync-inline__progress');
    setText(text, line);
    text.hidden = !line;
    if (d && onData) onData(d);
  }

  subscribe(el, initial, render);
  return el;
}
