// Status milestone yang ditampilkan di UI. Diperbarui manual setiap milestone selesai.
export const MILESTONES = [
  { n: 1, title: 'Fondasi', text: 'Arsitektur, autentikasi, shell frontend, API, migrasi', state: 'active' },
  { n: 2, title: 'Data pasar', text: 'Binance REST/WS, candle historis, validasi, worker', state: 'todo' },
  { n: 3, title: 'Mesin pola', text: 'SA, PVA, hybrid timeframe, skor, state machine', state: 'todo' },
  { n: 4, title: 'Dashboard premium', text: 'Screener, grafik candlestick, update real-time', state: 'todo' },
  { n: 5, title: 'Pattern Discovery Lab', text: 'Upload, anotasi, definisi pola berversi, replay', state: 'todo' },
  { n: 6, title: 'Backtesting', text: 'Replay historis, metrik, out-of-sample', state: 'todo' },
  { n: 7, title: 'Keamanan & QA', text: 'Uji positif/negatif/edge, pemindaian, pentest', state: 'todo' },
  { n: 8, title: 'Deployment privat', text: 'Docker, HTTPS, backup, monitoring', state: 'todo' },
];

export const milestoneLabel = (n) => `Milestone ${n} — ${MILESTONES[n - 1].title}`;
