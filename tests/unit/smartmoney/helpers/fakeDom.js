// DOM tiruan minimal untuk menguji render view Smart Money di lingkungan Vitest `node` (tanpa jsdom).
// Hanya mendukung API yang dipakai frontend/js/lib/{dom,components}.js dan view smart money: elemen, teks, atribut,
// dataset, classList, event sederhana, selektor sederhana (tag/.kelas/#id/[attr]/[attr="v"], keturunan, daftar koma),
// properti form (value/checked/elements) dan FormData.

class FakeNode {
  constructor() {
    this.parentNode = null;
    this.childNodes = [];
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.data = String(text);
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = String(v);
  }
}

const BOOL_PROPS = ['hidden', 'disabled', 'checked', 'selected'];

function parseSimple(sel) {
  const out = { tag: null, classes: [], id: null, attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(sel))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else out.attrs.push([m[4], m[5]]);
  }
  return out;
}

function matchesSimple(el, s) {
  if (!(el instanceof FakeElement)) return false;
  if (s.tag && el.tagName !== s.tag) return false;
  if (s.id && el.getAttribute('id') !== s.id) return false;
  if (s.classes.some((c) => !el.classList.contains(c))) return false;
  return s.attrs.every(([k, v]) => (v === undefined ? el.hasAttribute(k) : el.getAttribute(k) === v));
}

function matches(el, selector) {
  return selector.split(',').some((part) => {
    // Pisah pada spasi di luar [ ] (nilai atribut boleh berisi spasi).
    const chain = (part.trim().match(/(?:\[[^\]]*\]|[^\s[])+/g) ?? []).map(parseSimple);
    if (!matchesSimple(el, chain[chain.length - 1])) return false;
    let node = el.parentNode;
    for (let i = chain.length - 2; i >= 0; i -= 1) {
      while (node && !matchesSimple(node, chain[i])) node = node.parentNode;
      if (!node) return false;
      node = node.parentNode;
    }
    return true;
  });
}

export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.listeners = {};
    this.props = {};
    const self = this;
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    this.dataset = new Proxy({}, {
      get: (_, k) => self.getAttribute(`data-${toKebab(k)}`) ?? undefined,
      set: (_, k, v) => { self.setAttribute(`data-${toKebab(k)}`, String(v)); return true; },
      deleteProperty: (_, k) => { self.removeAttribute(`data-${toKebab(k)}`); return true; },
    });
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(' ').filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
      remove: (...c) => { self.className = self.className.split(' ').filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => self.className.split(' ').includes(c),
    };
  }

  get className() { return this.getAttribute('class') ?? ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') ?? ''; }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(v) { this.setAttribute('title', v); }
  get children() { return this.childNodes.filter((c) => c instanceof FakeElement); }
  get firstChild() { return this.childNodes[0] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get nextElementSibling() { const s = this.parentNode?.children ?? []; return s[s.indexOf(this) + 1] ?? null; }
  get previousElementSibling() { const s = this.parentNode?.children ?? []; return s[s.indexOf(this) - 1] ?? null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document?.body || n === globalThis.document?.documentElement; }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
  set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
  get type() { return this.getAttribute('type') ?? ''; }
  get name() { return this.getAttribute('name') ?? ''; }

  get textContent() { return super.textContent; }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = [new FakeText(v)]; this.childNodes[0].parentNode = this; }

  get value() {
    if (this.tagName === 'SELECT') {
      if ('value' in this.props) return this.props.value;
      const opts = this.querySelectorAll('option');
      return (opts.find((o) => o.hasAttribute('selected')) ?? opts[0])?.getAttribute('value') ?? '';
    }
    return 'value' in this.props ? this.props.value : this.getAttribute('value') ?? (this.type === 'checkbox' || this.type === 'radio' ? 'on' : '');
  }

  set value(v) { this.props.value = String(v); }

  get elements() {
    const form = this;
    return new Proxy({}, { get: (_, name) => form.querySelectorAll(`[name="${String(name)}"]`)[0] });
  }

  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }

  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof FakeNode ? n : new FakeText(n);
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  appendChild(n) { this.append(n); return n; }

  replaceChildren(...nodes) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    this.append(...nodes);
  }

  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  closest(sel) { for (let x = this; x instanceof FakeElement; x = x.parentNode) if (matches(x, sel)) return x; return null; }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  querySelectorAll(sel) { return this.descendants().filter((el) => matches(el, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }

  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    for (let x = this; x; x = x.parentNode) {
      event.currentTarget = x;
      for (const fn of x.listeners?.[event.type] ?? []) fn(event);
    }
    return true;
  }

  click() { this.dispatchEvent({ type: 'click' }); }
  focus() { globalThis.document.activeElement = this; }
}

for (const prop of BOOL_PROPS) {
  Object.defineProperty(FakeElement.prototype, prop, {
    get() { return prop in this.props ? this.props[prop] : this.hasAttribute(prop); },
    set(v) { if (prop === 'hidden' || prop === 'disabled') { if (v) this.setAttribute(prop, ''); else this.removeAttribute(prop); } else this.props[prop] = Boolean(v); },
  });
}

const toKebab = (k) => String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class FakeFormData {
  constructor(form) {
    this.entries = [];
    for (const el of form.querySelectorAll('[name]')) {
      if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA') continue;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) continue;
      this.entries.push([el.name, el.value]);
    }
  }

  get(name) { return this.entries.find(([k]) => k === name)?.[1] ?? null; }
  getAll(name) { return this.entries.filter(([k]) => k === name).map(([, v]) => v); }
  values() { return this.entries.map(([, v]) => v)[Symbol.iterator](); }
}

/**
 * Pasang DOM tiruan di globalThis. `routes` memetakan path API (tanpa query bila `exact` false) ke respons.
 * @param {{ hash?: string, responses?: (url: string, init: object) => { status?: number, body?: unknown } }} options
 */
export function installFakeDom({ hash = '', responses = () => ({ status: 404, body: { error: 'NOT_FOUND' } }) } = {}) {
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  documentElement.append(body);
  const requests = [];
  const KEYS = ['Node', 'Element', 'HTMLElement', 'FormData', 'document', 'window', 'fetch'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  globalThis.Node = FakeNode;
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.FormData = FakeFormData;
  globalThis.document = {
    documentElement,
    body,
    hidden: false,
    activeElement: body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (t) => new FakeText(t),
    querySelector: (sel) => documentElement.querySelector(sel),
  };
  globalThis.window = { location: { hash, assign() {} }, addEventListener() {}, dispatchEvent() {} };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, body: resBody = null } = responses(url, init) ?? {};
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => 'application/json' },
      json: async () => resBody,
    };
  };
  return {
    requests,
    uninstall() {
      for (const k of KEYS) {
        if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
        else delete globalThis[k];
      }
    },
  };
}

/** Tunggu antrian microtask/timer singkat (render async setelah event). */
export async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
}
