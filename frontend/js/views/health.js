import { api } from '../lib/api.js';
import { dataTable, page, panel, stat, statusPill } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { EMPTY, formatBytes, formatDuration, formatInteger, formatRelative, formatUtc } from '../lib/format.js';
import { requestSyncRefresh, syncProgressPanel } from './syncProgress.js';
import { workerControlCard } from './workerControl.js';
import { binancePill, scannerPill } from './workerFormat.js';

const REFRESH_MS = 10_000;

const seconds = (ms) => (typeof ms === 'number' ? ms / 1000 : null);

function render(data) {
  const db = data.database;
  const sc = data.scanner;
  const running = sc.status !== 'not_running';
  return [
    h('div', { class: 'grid grid--kpi' },
      stat({ label: 'Uptime server', value: formatDuration(data.uptimeSec), hint: data.nodeVersion }),
      stat({ label: 'Memori (RSS)', value: formatBytes(data.memory.rssBytes), hint: `Heap ${formatBytes(data.memory.heapUsedBytes)} / ${formatBytes(data.memory.heapTotalBytes)}` }),
      stat({ label: 'Latensi DB', value: db.latencyMs === null ? EMPTY : `${db.latencyMs} ms`, hint: `Skema v${db.schemaVersion ?? EMPTY}` }),
      stat({ label: 'Durasi scan', value: formatDuration(seconds(sc.scanDurationMs)), muted: typeof sc.scanDurationMs !== 'number', hint: 'Siklus discovery + backfill terakhir', testId: 'kpi-scan' }),
      stat({ label: 'Antrian', value: formatInteger(sc.queue), muted: typeof sc.queue !== 'number', hint: 'Tugas worker tertunda' })),
    h('div', { class: 'grid grid--2' },
      panel({ title: 'Komponen' },
        h('dl', { class: 'kv' },
          h('dt', null, 'API server'), h('dd', null, statusPill('ok', 'Berjalan', { live: true })),
          h('dt', null, 'Database'), h('dd', null, db.status === 'ok' ? statusPill('ok', 'OK') : statusPill('error', 'Gagal')),
          h('dt', null, 'Worker scanner'), h('dd', { 'data-testid': 'health-scanner' }, scannerPill(sc)),
          h('dt', null, 'WebSocket Binance'), h('dd', { 'data-testid': 'health-binance' }, binancePill(data.binance)),
          h('dt', null, 'Heartbeat worker'), h('dd', null, running ? `${formatRelative(sc.heartbeatAt, data.serverTime)} · ${formatUtc(sc.heartbeatAt)}` : 'Worker belum pernah berjalan (tombol "Jalankan scanner" atau npm run worker)'))),
      panel({ title: 'Ingesti data' },
        h('dl', { class: 'kv' },
          h('dt', null, 'Ingesti terakhir'), h('dd', null, sc.lastIngestionAt ? `${formatRelative(sc.lastIngestionAt, data.serverTime)} · ${formatUtc(sc.lastIngestionAt)}` : EMPTY),
          h('dt', null, 'Lag candle'), h('dd', null, formatDuration(seconds(sc.candleLagMs))),
          h('dt', null, 'Simbol / stream'), h('dd', { class: 'mono' }, running ? `${formatInteger(sc.symbols)} / ${formatInteger(sc.streams)} (basi ${formatInteger(sc.staleStreams)})` : EMPTY),
          h('dt', null, 'Reconnect / gap / duplikat'), h('dd', { class: 'mono' }, running ? `${formatInteger(sc.reconnects)} / ${formatInteger(sc.gaps)} / ${formatInteger(sc.duplicates)}` : EMPTY),
          h('dt', null, 'Error tercatat'), h('dd', null, formatInteger(sc.errors)),
          // clockSynced false: belum ada sync jam yang berhasil — offset masih nilai awal, bukan pengukuran → '—'.
          h('dt', null, 'Offset jam Binance'), h('dd', { class: 'mono', 'data-testid': 'health-clock' },
            sc.clockFault === 'OFFSET_OUT_OF_RANGE'
              ? 'Jam host menyimpang > 10 menit dari Binance — periksa NTP'
              : (running && typeof sc.clockOffsetMs === 'number' && sc.sync?.clockSynced !== false ? `${formatInteger(sc.clockOffsetMs)} ms` : EMPTY)),
          h('dt', null, 'Waktu server'), h('dd', { class: 'mono' }, formatUtc(data.serverTime))))),
    panel({ title: 'Error ingesti terbaru', flush: true },
      dataTable({
        compact: true,
        caption: 'Error ingesti terbaru',
        columns: [
          { key: 'at', label: 'Waktu', render: (r) => formatUtc(r.at) },
          { key: 'source', label: 'Sumber', render: (r) => h('span', { class: 'mono' }, r.source) },
          { key: 'message', label: 'Pesan', sortable: false },
        ],
        rows: data.ingestion.recentErrors,
        initialSort: { key: 'at', dir: 'desc' },
        empty: h('p', { class: 'empty__text' }, 'Tidak ada error tercatat.'),
      })),
  ];
}

export async function healthView(ctx) {
  const initial = await api('/api/system/status');
  // Kartu kontrol dibuat sekali (state konfirmasi/request tetap utuh); metrik di bawahnya dirender ulang.
  const control = workerControlCard({ user: ctx?.user, status: initial.workerControl });
  // Proses sync scanner tepat di bawah kartu kontrol; panel memantau GET /api/system/sync sendiri (2 detik selama
  // memulai/backfill, 10 detik saat live) dan berhenti saat halaman ditinggalkan. Tombol kontrol ditekan → panel
  // langsung memantau cepat, sehingga langkah pertama terlihat tanpa menunggu putaran 10 detik.
  const sync = syncProgressPanel({ initial });
  control.el.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('button')) requestSyncRefresh();
  });
  const metrics = h('div', { class: 'stack' }, render(initial));
  const timer = setInterval(async () => {
    try {
      // Auto-refresh bukan aktivitas pengguna: tidak memperpanjang idle timeout sesi.
      const data = await api('/api/system/status', { background: true });
      metrics.replaceChildren(...render(data));
      control.update(data.workerControl);
    } catch {
      // Error ditampilkan oleh indikator koneksi di topbar.
    }
  }, REFRESH_MS);

  return {
    el: page({ title: 'System Health', subtitle: 'Metrik nyata dari proses server dan heartbeat worker, diperbarui setiap 10 detik.' },
      h('div', { class: 'stack' }, control.el, sync, metrics)),
    cleanup: () => {
      clearInterval(timer);
      control.cleanup();
    },
  };
}
