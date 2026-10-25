import { api } from '../lib/api.js';
import { page, panel, stat, statusPill } from '../lib/components.js';
import { h } from '../lib/dom.js';
import { formatBytes, formatDuration, formatUtc } from '../lib/format.js';
import { milestoneLabel } from './roadmap.js';

const REFRESH_MS = 10_000;

function render(data) {
  const db = data.database;
  return [
    h('div', { class: 'grid grid--kpi' },
      stat({ label: 'Uptime server', value: formatDuration(data.uptimeSec), hint: data.nodeVersion }),
      stat({ label: 'Memori (RSS)', value: formatBytes(data.memory.rssBytes), hint: `Heap ${formatBytes(data.memory.heapUsedBytes)} / ${formatBytes(data.memory.heapTotalBytes)}` }),
      stat({ label: 'Latensi DB', value: db.latencyMs === null ? '—' : `${db.latencyMs} ms`, hint: `Skema v${db.schemaVersion ?? '—'}` }),
      stat({ label: 'Durasi scan', value: '—', muted: true, hint: `Tersedia di ${milestoneLabel(2)}` }),
      stat({ label: 'Antrian', value: '—', muted: true, hint: `Tersedia di ${milestoneLabel(2)}` })),
    h('div', { class: 'grid grid--2' },
      panel({ title: 'Komponen' },
        h('dl', { class: 'kv' },
          h('dt', null, 'API server'), h('dd', null, statusPill('ok', 'Berjalan', { live: true })),
          h('dt', null, 'Database'), h('dd', null, db.status === 'ok' ? statusPill('ok', 'OK') : statusPill('error', 'Gagal')),
          h('dt', null, 'Konektivitas Binance'), h('dd', null, statusPill('idle', 'Belum diimplementasi')),
          h('dt', null, 'Worker scanner'), h('dd', null, statusPill('idle', 'Belum diimplementasi')))),
      panel({ title: 'Ingesti data' },
        h('dl', { class: 'kv' },
          h('dt', null, 'Ingesti sukses terakhir'), h('dd', null, '—'),
          h('dt', null, 'Lag candle'), h('dd', null, '—'),
          h('dt', null, 'Error API'), h('dd', null, '—'),
          h('dt', null, 'Waktu server'), h('dd', { class: 'mono' }, formatUtc(data.serverTime))))),
  ];
}

export async function healthView() {
  const body = h('div', { class: 'stack' }, render(await api('/api/system/status')));
  const timer = setInterval(async () => {
    try {
      body.replaceChildren(...render(await api('/api/system/status')));
    } catch {
      // Error ditampilkan oleh indikator koneksi di topbar.
    }
  }, REFRESH_MS);

  return {
    el: page({ title: 'System Health', subtitle: 'Metrik nyata dari proses server, diperbarui setiap 10 detik.' }, body),
    cleanup: () => clearInterval(timer),
  };
}
