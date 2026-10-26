// Peta Benang — renderer SVG (frontend/js/views/smartThreads.js) dan pengalih "Daftar | Peta Benang" di halaman radar,
// dengan DOM tiruan (helpers/fakeDom.js): tanpa request tambahan, aman XSS, aksesibel, panel bukti, sorot & keyboard.
import { afterEach, describe, expect, it } from 'vitest';
import { DISCLAIMERS } from '../../../backend/smartmoney/contracts.js';
import { USD_UNKNOWN } from '../../../frontend/js/views/smartMoneyFormat.js';
import { smartMoneyView } from '../../../frontend/js/views/smartMoneyRadar.js';
import { THREADS_NOTE, threadsGeometry, threadsView } from '../../../frontend/js/views/smartThreads.js';
import { buildThreadsLayout } from '../../../frontend/js/views/smartThreadsLayout.js';
import { flush, installFakeDom } from './helpers/fakeDom.js';

const NOW = Date.UTC(2026, 9, 1, 12, 0);
const T1 = '0x6982508145454ce325ddbe47a25d4ec3d2311933';
const T2 = '0x1111111111111111111111111111111111111111';
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const W3 = '0xcccccccccccccccccccccccccccccccccccccccc';
const TX = `0x${'ab'.repeat(32)}`;
const TXS = Array.from({ length: 7 }, (_, i) => `0x${String(i + 1).repeat(64)}`);

const meta = (over = {}) => ({
  simulated: false, dataAsOf: NOW - 60_000, lastSyncAt: NOW - 120_000, isStale: false,
  coverage: { chains: ['ethereum'], wallets: 3, activities: 20 }, providersConfigured: 1, disclaimers: DISCLAIMERS, ...over,
});

const items = () => [
  {
    tokenKey: `ethereum:${T1}`, chain: 'ethereum', token: { address: T1, symbol: 'PEPE', name: 'Pepe' },
    buyers: [
      {
        wallet: W1, score: 81, clusterId: 'ethereum:k1', netBuyUsd: 5000, buys: 7, sells: 0, firstBuyAt: NOW - 3e6, lastBuyAt: NOW - 1e6,
        label: { label: 'Fund A', category: 'fund', source: 'arkham' },
        txs: TXS.map((h, i) => ({ txHash: h, explorerUrl: `https://etherscan.io/tx/${h}`, type: 'SWAP_BUY', at: NOW - (i + 1) * 60_000, usd: i === 0 ? null : 700 })),
      },
      { wallet: W2, score: 66, clusterId: 'ethereum:k1', netBuyUsd: null, buys: 1, sells: 0, firstBuyAt: NOW - 2e6, lastBuyAt: NOW - 2e6, txs: [], label: null },
    ],
    buyerCount: 2, independentBuyers: 1, exitSignals: [{ wallet: W3, type: 'CEX_DEPOSIT', at: NOW - 5e5, usd: null, txHash: TX, explorerUrl: `https://etherscan.io/tx/${TX}`, via: 'CEX', note: 'dipindah ke exchange, belum tentu dijual' }],
    state: 'ACCUMULATING', conviction: 64, binance: { status: 'MATCHED', futuresSymbol: '1000PEPEUSDT', spotSymbol: 'PEPEUSDT' }, isSimulated: false,
  },
  {
    tokenKey: `base:${T2}`, chain: 'base', token: { address: T2, symbol: 'PEPE' },
    buyers: [{ wallet: W1, score: 70, clusterId: `base:${W1}`, netBuyUsd: 900, buys: 1, sells: 1, firstBuyAt: NOW - 4e6, lastBuyAt: NOW - 4e6, txs: [], label: null }],
    buyerCount: 1, independentBuyers: 1, exitSignals: [], state: 'EXITING', conviction: 30, binance: { status: 'SYMBOL_ONLY' }, isSimulated: true,
  },
];

let dom;
afterEach(() => dom?.uninstall());

const texts = (el) => el.textContent.replace(/\s+/g, ' ');
const strandEls = (el) => el.querySelectorAll('[data-thr="strand"]');
const node = (el, kind, id) => el.querySelectorAll(`[data-thr="${kind}"]`).find((n) => n.getAttribute('data-id') === id);
const ev = (type, extra = {}) => ({ type, preventDefault() { this.defaultPrevented = true; }, ...extra });

describe('Peta Benang — renderer', () => {
  it('UNIT-SM-THREADS-020 SVG aksesibel: title/desc, node ber-aria-label Indonesia, satu tab stop per kolom, ringkasan teks', () => {
    dom = installFakeDom();
    const el = threadsView(items(), meta(), { now: NOW, width: 900 });
    const svg = el.querySelector('svg.sm-thr__svg');
    expect(svg.getAttribute('viewBox')).toMatch(/^0 0 900 \d+$/);
    expect(svg.getAttribute('role')).toBe('group');
    expect(texts(svg.querySelector('title'))).toBe('Peta Benang: wallet → token');
    expect(texts(svg.querySelector('desc'))).toContain('aktivitas on-chain publik');
    expect(texts(svg.querySelector('desc'))).toContain('DATA SIMULASI');
    // 3 wallet (W1 di dua chain = dua node + W2 + W3) dan 2 token PEPE (kontrak/chain berbeda).
    expect(el.querySelectorAll('[data-thr="wallet"]')).toHaveLength(4);
    expect(el.querySelectorAll('[data-thr="token"]')).toHaveLength(2);
    expect(strandEls(el)).toHaveLength(4);
    const tokenLabel = node(el, 'token', `ethereum:${T1}`).getAttribute('aria-label');
    expect(tokenLabel).toContain('skor keyakinan 64 dari 100, bukan probabilitas');
    expect(tokenLabel).toContain('Enter membuka detail token');
    expect(node(el, 'token', `ethereum:${T1}`).getAttribute('href')).toBe(`#/smart-token?c=ethereum&a=${T1}`);
    const walletLabel = node(el, 'wallet', `ethereum:${W1}`).getAttribute('aria-label');
    expect(walletLabel).toContain('skor wallet 81');
    expect(walletLabel).toContain('Fund A (sumber: arkham)');
    expect(walletLabel).toContain('klaster K1: 2 wallet terkait dihitung 1 pembeli independen');
    expect(node(el, 'wallet', `ethereum:${W1}`).getAttribute('href')).toBe(`#/smart-wallet?c=ethereum&a=${W1}`);
    expect(node(el, 'wallet', `ethereum:${W3}`).getAttribute('aria-label')).toContain('skor wallet tidak tersedia (hanya indikasi keluar)');
    for (const kind of ['wallet', 'strand', 'token']) {
      const stops = el.querySelectorAll(`[data-thr="${kind}"]`).filter((n) => n.getAttribute('tabindex') === '0');
      expect(stops).toHaveLength(1);
    }
    // Tooltip keyakinan menyatakan bukan probabilitas; simbol sama di dua kontrak tetap dua node yang dibedakan.
    expect(texts(node(el, 'token', `ethereum:${T1}`).querySelector('title'))).toContain('BUKAN probabilitas profit');
    expect(texts(el.querySelector('[data-testid="sm-threads-count"]'))).toContain('Menampilkan 2 dari 2 token · 4 dari 4 wallet');
    const summary = texts(el.querySelector('[data-testid="sm-threads-summary"]'));
    expect(summary).toContain('PEPE (Ethereum, kontrak 0x6982…1933)');
    expect(summary).toContain('PEPE (Base, kontrak 0x1111…1111)');
    expect(summary).toContain('Klaster K1');
    expect(texts(el)).toContain(THREADS_NOTE);
    expect(THREADS_NOTE).toContain('aktivitas on-chain publik');
    expect(THREADS_NOTE).toContain('Tidak ada informasi orang dalam');
    expect(texts(el)).toContain(DISCLAIMERS.conviction);
  });

  it('UNIT-SM-THREADS-021 data provider hanya sebagai teks: label/simbol berisi HTML tidak pernah menjadi elemen', () => {
    dom = installFakeDom();
    const evil = items();
    evil[0].token.symbol = '<img src=x onerror=alert(1)>';
    evil[0].buyers[0].label = { label: '<script>alert(1)</script>', category: 'x', source: '<b>src</b>' };
    const el = threadsView(evil, meta(), { now: NOW, width: 900 });
    for (const tag of ['img', 'script', 'b']) expect(el.querySelectorAll(tag)).toHaveLength(0);
    expect(texts(el)).toContain('<script>');
    expect(texts(el)).toContain('<img src=x');
    const strand = strandEls(el).find((n) => n.getAttribute('data-id') === `ethereum:${W1}>ethereum:${T1}`);
    strand.click();
    const panel = el.querySelector('[data-testid="sm-threads-evidence"]');
    for (const tag of ['img', 'script', 'b']) expect(panel.querySelectorAll(tag)).toHaveLength(0);
    expect(texts(panel)).toContain('<script>alert(1)</script>');
  });

  it('UNIT-SM-THREADS-022 klik benang → panel bukti (aria-live): beli/jual, USD, waktu, ≤ 5 tx https, SIMULASI', () => {
    dom = installFakeDom();
    const el = threadsView(items(), meta(), { now: NOW, width: 900 });
    const panel = el.querySelector('[data-testid="sm-threads-evidence"]');
    expect(panel.getAttribute('aria-live')).toBe('polite');
    expect(texts(panel)).toContain('Pilih benang');
    strandEls(el).find((n) => n.getAttribute('data-id') === `ethereum:${W1}>ethereum:${T1}`).click();
    let t = texts(panel);
    expect(t).toContain('Beli via swap');
    expect(t).toContain('7 / 0');
    expect(t).toContain('+$5.000');
    expect(t).toContain('Fund A');
    expect(t).toContain('K1: 2 wallet terkait — dihitung 1 pembeli independen');
    expect(t).toContain('2026-10-01 11:10:00 UTC'); // beli pertama (NOW − 50 menit)
    expect(t).toContain('5 terbaru dari 7');
    const links = panel.querySelectorAll('a[target="_blank"]');
    expect(links).toHaveLength(5);
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^https:\/\/etherscan\.io\/tx\/0x/);
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(panel.querySelectorAll('.badge').filter((b) => b.textContent === 'SIMULASI')).toHaveLength(0);
    expect(panel.querySelector(`a[href="#/smart-wallet?c=ethereum&a=${W1}"]`)).not.toBeNull();

    // USD tidak diketahui → teks eksplisit, bukan $0.
    strandEls(el).find((n) => n.getAttribute('data-id') === `ethereum:${W2}>ethereum:${T1}`).click();
    t = texts(panel);
    expect(t).toContain(USD_UNKNOWN);
    expect(t).not.toContain('$0');
    expect(strandEls(el).find((n) => n.getAttribute('data-id') === `ethereum:${W2}>ethereum:${T1}`).getAttribute('data-usd')).toBe('unknown');

    // Indikasi keluar lewat exchange: tidak pernah disebut penjualan.
    strandEls(el).find((n) => n.getAttribute('data-id') === `ethereum:${W3}>ethereum:${T1}`).click();
    t = texts(panel);
    expect(t).toContain('Indikasi keluar: dipindah ke exchange, belum tentu dijual');
    expect(t).toContain('Deposit ke exchange');
    expect(t).not.toMatch(/dijual via swap|Beli & jual/);

    // Token simulasi → benang & bukti bertanda SIMULASI.
    const simStrand = strandEls(el).find((n) => n.getAttribute('data-id') === `base:${W1}>base:${T2}`);
    expect(simStrand.getAttribute('data-sim')).toBe('true');
    expect(simStrand.getAttribute('data-tone')).toBe('mixed');
    simStrand.click();
    expect(panel.querySelectorAll('.badge').filter((b) => b.textContent === 'SIMULASI')).toHaveLength(1);
    expect(texts(panel)).toContain('Beli & jual via swap');
    expect(simStrand.classList.contains('is-selected')).toBe(true);
  });

  it('UNIT-SM-THREADS-023 sorot: fokus/arahkan wallet atau token menyalakan benang & pasangannya, sisanya diredupkan', () => {
    dom = installFakeDom();
    const el = threadsView(items(), meta(), { now: NOW, width: 900 });
    const svg = el.querySelector('svg.sm-thr__svg');
    const w1 = node(el, 'wallet', `ethereum:${W1}`);
    w1.dispatchEvent(ev('focusin'));
    expect(svg.getAttribute('data-focus')).toBe('wallet');
    const on = (kind) => el.querySelectorAll(`[data-thr="${kind}"]`).filter((n) => n.classList.contains('is-on')).map((n) => n.getAttribute('data-id'));
    expect(on('strand')).toEqual([`ethereum:${W1}>ethereum:${T1}`]);
    expect(on('token')).toEqual([`ethereum:${T1}`]);
    expect(on('wallet')).toEqual([`ethereum:${W1}`]);
    w1.dispatchEvent(ev('focusout', { relatedTarget: null }));
    expect(svg.hasAttribute('data-focus')).toBe(false);

    const pepe = node(el, 'token', `ethereum:${T1}`);
    pepe.dispatchEvent(ev('pointerenter', { pointerType: 'mouse' }));
    expect(on('strand').sort()).toEqual([`ethereum:${W1}>ethereum:${T1}`, `ethereum:${W2}>ethereum:${T1}`, `ethereum:${W3}>ethereum:${T1}`].sort());
    expect(on('wallet')).toHaveLength(3);
    pepe.dispatchEvent(ev('pointerleave'));
    expect(on('strand')).toEqual([]);
    // Sentuhan tidak memicu sorot "hover" yang lengket.
    pepe.dispatchEvent(ev('pointerenter', { pointerType: 'touch' }));
    expect(svg.hasAttribute('data-focus')).toBe(false);
  });

  it('UNIT-SM-THREADS-024 keyboard: panah menyusuri kolom & benang, Enter memilih benang, Esc menghapus pilihan', () => {
    dom = installFakeDom();
    const el = threadsView(items(), meta(), { now: NOW, width: 900 });
    const panel = el.querySelector('[data-testid="sm-threads-evidence"]');
    const first = el.querySelectorAll('[data-thr="wallet"]')[0];
    first.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
    const active = globalThis.document.activeElement;
    expect(active.getAttribute('data-thr')).toBe('strand');
    expect(active.getAttribute('data-id').startsWith(`${first.getAttribute('data-id')}>`)).toBe(true);
    expect(active.getAttribute('tabindex')).toBe('0');
    active.dispatchEvent(ev('keydown', { key: 'Enter' }));
    expect(texts(panel)).toContain('Bukti benang');
    expect(texts(panel)).not.toContain('Pilih benang');
    active.dispatchEvent(ev('keydown', { key: 'ArrowRight' }));
    expect(globalThis.document.activeElement.getAttribute('data-thr')).toBe('token');
    const tokenEl = globalThis.document.activeElement;
    tokenEl.dispatchEvent(ev('keydown', { key: 'ArrowDown' }));
    expect(globalThis.document.activeElement).not.toBe(tokenEl);
    expect(globalThis.document.activeElement.getAttribute('data-thr')).toBe('token');
    globalThis.document.activeElement.dispatchEvent(ev('keydown', { key: 'Escape' }));
    expect(texts(panel)).toContain('Pilih benang');
    expect(el.querySelectorAll('.is-selected')).toHaveLength(0);
  });

  it('UNIT-SM-THREADS-025 layar sempit (390 px): geometri ringkas dalam lebar wadah; tanpa item → keadaan kosong jujur', () => {
    dom = installFakeDom();
    const layout = buildThreadsLayout(items());
    const g = threadsGeometry(layout, 324);
    expect(g.compact).toBe(true);
    expect(g.W).toBe(324);
    expect(g.xW).toBeLessThan(g.xT);
    expect(g.xT + 12).toBeLessThan(g.W);
    expect(threadsGeometry(layout, 1100).compact).toBe(false);
    expect(threadsGeometry(layout, 100).W).toBe(300); // batas bawah, diskalakan oleh viewBox
    const el = threadsView(items(), meta(), { now: NOW, width: 324 });
    const svg = el.querySelector('svg.sm-thr__svg');
    expect(svg.getAttribute('data-compact')).toBe('true');
    expect(svg.getAttribute('width')).toBe('100%');
    expect(el.querySelectorAll('.sm-thr-chip')).toHaveLength(0); // label pihak ketiga hanya di tooltip/bukti
    expect(texts(node(el, 'wallet', `ethereum:${W1}`))).toContain('0xaa…aaaa');

    const empty = threadsView([], meta(), { now: NOW });
    expect(texts(empty)).toContain('Belum ada benang untuk ditampilkan');
    expect(empty.querySelector('svg.sm-thr__svg')).toBeNull();
  });
});

const jsonRoute = (table) => (url, init) => {
  const path = url.split('?')[0];
  const handler = table[`${init.method ?? 'GET'} ${path}`] ?? table[path];
  if (!handler) return { status: 404, body: { error: 'NOT_FOUND', message: 'tidak ada' } };
  return typeof handler === 'function' ? handler(url, init) : { status: 200, body: handler };
};

describe('Peta Benang — pengalih di halaman radar', () => {
  it('UNIT-SM-THREADS-030 Daftar bawaan; beralih ke Peta Benang & kembali tanpa request baru; pilihan tersimpan di hash', async () => {
    dom = installFakeDom({
      hash: '#/smart-money?window=4h',
      responses: jsonRoute({ '/api/smart-money/radar': { meta: meta(), window: '4h', computedAt: NOW, items: items() }, '/api/smart-money/evaluation': { meta: meta(), available: false } }),
    });
    const replaced = [];
    globalThis.window.history = {
      state: null,
      replaceState: (_s, _t, url) => {
        replaced.push(url);
        globalThis.window.location.hash = url;
      },
    };
    const el = await smartMoneyView();
    const requests = dom.requests.length;
    const list = el.querySelector('ul.sm-radar');
    const host = el.querySelector('[data-testid="sm-threads-host"]');
    expect(list.hidden).toBe(false);
    expect(host.hidden).toBe(true);
    expect(host.querySelector('[data-testid="sm-threads"]')).toBeNull(); // dibangun malas
    const group = el.querySelector('[aria-label="Tampilan hasil radar"]');
    expect(group.getAttribute('role')).toBe('radiogroup');
    const radio = (value) => group.querySelector(`input[value="${value}"]`);
    expect(radio('daftar').checked).toBe(true);

    radio('benang').checked = true;
    radio('benang').dispatchEvent({ type: 'change' });
    await flush();
    expect(dom.requests.length).toBe(requests); // respons yang sama — tidak ada request tambahan
    expect(list.hidden).toBe(true);
    expect(host.hidden).toBe(false);
    expect(host.querySelectorAll('[data-thr="token"]')).toHaveLength(2);
    expect(replaced.at(-1)).toBe('#/smart-money?window=4h&view=benang');

    radio('daftar').checked = true;
    radio('daftar').dispatchEvent({ type: 'change' });
    await flush();
    expect(dom.requests.length).toBe(requests);
    expect(list.hidden).toBe(false);
    expect(host.hidden).toBe(true);
    expect(el.querySelectorAll('[data-testid="sm-radar-item"]')).toHaveLength(2);
    expect(replaced.at(-1)).toBe('#/smart-money?window=4h');
  });

  it('UNIT-SM-THREADS-031 #/smart-money?view=benang membuka peta langsung; filter memuat ulang peta, kosong → keadaan kosong', async () => {
    let calls = 0;
    dom = installFakeDom({
      hash: '#/smart-money?view=benang',
      responses: jsonRoute({
        '/api/smart-money/radar': () => {
          calls += 1;
          return { status: 200, body: { meta: meta(), computedAt: NOW, items: calls === 1 ? items() : [] } };
        },
        '/api/smart-money/evaluation': { meta: meta(), available: false },
      }),
    });
    const el = await smartMoneyView();
    expect(el.querySelector('ul.sm-radar').hidden).toBe(true);
    expect(el.querySelector('[data-testid="sm-threads"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Tampilan hasil radar"] input[value="benang"]').checked).toBe(true);
    // Perubahan filter (form) tetap memuat ulang radar seperti biasa.
    const form = el.querySelector('form');
    form.elements.state.value = 'ACCUMULATING';
    form.dispatchEvent({ type: 'change' });
    await flush();
    expect(calls).toBe(2);
    expect(el.querySelector('[data-testid="sm-threads"]')).toBeNull();
    expect(texts(el)).toContain('Tidak ada token yang cocok dengan filter');
  });
});
