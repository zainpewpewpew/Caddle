// Pembuat elemen DOM yang aman: teks selalu lewat textContent, tidak pernah innerHTML.
// Ini adalah pertahanan utama terhadap XSS pada data yang berasal dari server.

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED_ATTRS = /^on./i;

/**
 * h('div', { class: 'panel', dataset: { id: 1 } }, 'teks', child)
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...(Node | string | number | null | undefined | false | Array<any>)} children
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (BLOCKED_ATTRS.test(key)) throw new Error(`Atribut event inline dilarang: ${key}`);
    if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) el.dataset[k] = String(v);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) el.style.setProperty(k, String(v));
    } else if (key === 'on' && typeof value === 'object') {
      for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Ikon dari sprite SVG same-origin. */
export function icon(name, className = 'nav__icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/assets/icons.svg#i-${name}`);
  svg.append(use);
  return svg;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}
