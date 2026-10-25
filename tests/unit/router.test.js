import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouter, resolveRoute } from '../../frontend/js/lib/router.js';

const ROUTES = [{ path: '/overview' }, { path: '/screener' }, { path: '/health' }];
const FALLBACK = '/overview';

/** window tiruan minimal: location.hash + event hashchange. */
function fakeWindow(hash = '') {
  const target = new EventTarget();
  const win = {
    location: { hash },
    addEventListener: (type, fn) => target.addEventListener(type, fn),
    go(next) {
      win.location.hash = next;
      target.dispatchEvent(new Event('hashchange'));
    },
  };
  vi.stubGlobal('window', win);
  return win;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('router hash', () => {
  it('UNIT-RTR-001 hash route dipetakan ke route; kosong & tak dikenal → fallback', () => {
    expect(resolveRoute('#/screener', ROUTES, FALLBACK).path).toBe('/screener');
    expect(resolveRoute('', ROUTES, FALLBACK).path).toBe('/overview');
    expect(resolveRoute('#/tidak-ada', ROUTES, FALLBACK).path).toBe('/overview');
  });

  it('EDGE-RTR-001 fragmen non-route (#main dari skip link) diabaikan, bukan dianggap Overview', () => {
    expect(resolveRoute('#main', ROUTES, FALLBACK)).toBeNull();
    expect(resolveRoute('#sidebar', ROUTES, FALLBACK)).toBeNull();
  });

  it('EDGE-RTR-002 hashchange ke #main mempertahankan route saat ini', () => {
    const win = fakeWindow('#/screener');
    const onChange = vi.fn();
    createRouter({ routes: ROUTES, fallback: FALLBACK, onChange }).start();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].path).toBe('/screener');

    win.go('#main');
    expect(onChange).toHaveBeenCalledTimes(1);

    win.go('#/health');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0].path).toBe('/health');
  });

  it('EDGE-RTR-003 start dengan hash non-route tetap merender fallback', () => {
    fakeWindow('#main');
    const onChange = vi.fn();
    createRouter({ routes: ROUTES, fallback: FALLBACK, onChange }).start();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].path).toBe('/overview');
  });

  it('NEG-RTR-001 penolakan promise onChange diteruskan ke onError (bukan unhandled rejection)', async () => {
    fakeWindow('#/health');
    const failure = new Error('view gagal');
    const onError = vi.fn();
    createRouter({ routes: ROUTES, fallback: FALLBACK, onChange: () => Promise.reject(failure), onError }).start();
    await flush();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('NEG-RTR-002 onChange yang melempar sinkron juga ditangkap', () => {
    fakeWindow('#/health');
    const failure = new Error('sinkron');
    const onError = vi.fn();
    expect(() => createRouter({
      routes: ROUTES, fallback: FALLBACK, onChange: () => { throw failure; }, onError,
    }).start()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('NEG-RTR-003 tanpa onError, penolakan tetap ditangani (dilaporkan ke console.error)', async () => {
    fakeWindow('#/health');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createRouter({ routes: ROUTES, fallback: FALLBACK, onChange: () => Promise.reject(new Error('x')) }).start();
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
