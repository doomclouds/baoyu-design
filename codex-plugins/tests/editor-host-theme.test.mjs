import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { installNativeEditorTransport } from '../source/scripts/editor-native-transport.js';
import { mountNativeEditor } from '../source/ui/native-editor.mjs';

class Style {
  values = new Map();
  priorities = new Map();
  writes = 0;
  setProperty(name, value, priority = '') { this.values.set(name, String(value)); this.priorities.set(name, priority); this.writes++; }
  getPropertyValue(name) { return this.values.get(name) || ''; }
  getPropertyPriority(name) { return this.priorities.get(name) || ''; }
  removeProperty(name) { const value = this.getPropertyValue(name); this.values.delete(name); this.priorities.delete(name); this.writes++; return value; }
}

function themeFixture({ rem = 16, serialized = false, canvas = true, computedColors = {} } = {}) {
  const listeners = new Map(), messages = [], observers = [], roots = [], elements = [], commentHosts = [];
  const canvasPaints = [];
  const color = input => {
    const value = String(input).trim();
    if (value === 'transparent') return [0, 0, 0, 0];
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
    if (hex) { const full = hex.length === 3 ? [...hex].map(part => part + part).join('') : hex; return [0, 2, 4].map(at => parseInt(full.slice(at, at + 2), 16)).concat(1); }
    const rgba = /^rgba?\(([^)]+)\)$/.exec(value)?.[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (rgba?.length === 3 || rgba?.length === 4) return [...rgba.slice(0, 3), rgba[3] ?? 1];
    throw new Error('Unexpected browser-resolved test color: ' + value);
  };
  class Element {
    style = new Style();
    attributes = new Map();
    textContent = '';
    children = [];
    constructor(tag = 'div', { ui = false, authored = false } = {}) {
      this.tagName = tag; this.ui = ui; this.authored = authored; elements.push(this);
      if (tag === 'canvas' && canvas) this.getContext = (kind, options) => {
        assert.equal(kind, '2d'); assert.equal(options.alpha, false);
        const pixel = [0, 0, 0], owner = this;
        return { fillStyle: '#000000', globalCompositeOperation: 'source-over',
          fillRect(x, y, width, height) {
            assert.deepEqual([x, y, width, height], [0, 0, 1, 1]);
            const [r, g, b, alpha] = color(this.fillStyle);
            canvasPaints.push({ canvas: owner, color: this.fillStyle, operation: this.globalCompositeOperation });
            for (const [index, channel] of [r, g, b].entries()) pixel[index] = channel * alpha + pixel[index] * (1 - alpha);
          },
          getImageData() { return { data: Uint8ClampedArray.from([...pixel.map(value => Math.round(value)), 255]) }; },
        };
      };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) { return selector === '.cds-root' ? this.ui : selector.includes('data-baoyu-comments') && (this.attributes.has('data-baoyu-comments') || this.attributes.has('data-baoyu-comments-seat')) || selector.includes('data-baoyu-history-layer') && this.attributes.has('data-baoyu-history-layer'); }
    closest() { return this.authored ? this : null; }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    attachShadow(options) {
      const shadow = { host: this, roots: [], hosts: [], wraps: [], querySelectorAll(selector) { return selector === '.cds-root' ? this.roots : selector === '.wrap' ? this.wraps : this.hosts; } };
      if (options.mode === 'open') this.shadowRoot = shadow;
      return shadow;
    }
  }
  const html = new Element('html', { ui: true });
  html.setAttribute('data-theme', 'dark'); html.setAttribute('data-density', 'comfortable');
  const body = new Element('body'), head = new Element('head');
  const editor = new Element('div', { ui: true });
  editor.setAttribute('data-font', 'anthropic'); editor.setAttribute('data-density', 'comfortable');
  roots.push(editor);
  const authored = new Element('section', { authored: true });
  authored.setAttribute('data-appifact-content', '');
  authored.style.setProperty('font-family', 'Artwork Serif');
  authored.style.setProperty('--cds-font-sans', 'Artwork UI');
  authored.style.setProperty('color', '#254211');
  const nestedArtworkRoot = new Element('div', { ui: true, authored: true });
  nestedArtworkRoot.style.setProperty('--cds-font-sans', 'Authored Component');
  roots.push(nestedArtworkRoot);
  const preview = { srcdoc: '<section style="font-family:Artwork Serif;color:#254211">Keep this artwork.</section>' };
  Object.defineProperty(preview, 'contentDocument', { get() { assert.fail('Theme synchronization must not inspect authored preview documents.'); } });
  const parent = { postMessage: message => messages.push(message) };
  for (const name of ['document', 'codexDesignBridge']) Object.defineProperty(parent, name, { get() { throw new DOMException('Isolated', 'SecurityError'); } });
  const document = { documentElement: html, body, head,
    createElement: tag => new Element(tag), querySelectorAll: selector => selector === '.cds-root' ? roots : commentHosts, querySelector: () => editor,
    getElementById: id => head.children.find(element => element.id === id) };
  const resolve = (element, input, seen = new Set()) => String(input).replace(/var\((--[\w-]+)(?:,\s*([^()]*))?\)/g, (_, name, fallback) => {
    if (seen.has(name)) return '';
    const next = new Set(seen).add(name);
    const value = element.style.getPropertyValue(name);
    return value ? resolve(element, value, next) : fallback === undefined ? '' : resolve(element, fallback, next);
  });
  const length = value => {
    value = value.trim();
    if (/^[0-9.]+px$/.test(value)) return Number(value.slice(0, -2));
    if (/^[0-9.]+r?em$/.test(value)) return Number(value.replace(/r?em$/, '')) * rem;
    if (value.startsWith('calc(') && value.endsWith(')')) {
      const expression = value.slice(5, -1).replace(/([0-9.]+)r?em/g, (_, number) => String(Number(number) * rem)).replace(/([0-9.]+)px/g, '$1');
      if (/^[0-9.+\-*/ ()]+$/.test(expression)) return Function('return (' + expression + ')')();
    }
    return NaN;
  };
  const originalAttachShadow = Element.prototype.attachShadow;
  const target = { parent, document, Element, location: { origin: 'https://codex-design.invalid' }, btoa, atob,
    fetch: async () => { assert.fail('A theme change must not publish or fetch artwork.'); },
    CSS: { supports: (_, value) => !/INVALID|;/.test(value) },
    getComputedStyle(element) { return { getPropertyValue(name) {
      const raw = resolve(element, element.style.getPropertyValue(name));
      if (name.startsWith('--')) return raw;
      if (name === 'font-size') return Number.isFinite(length(raw)) ? length(raw) + 'px' : '';
      if (name === 'font-weight') return ({ normal: '400', bold: '700' })[raw] || raw;
      if (name === 'color') return computedColors[raw] || raw;
      return raw;
    } }; },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.closed = true; } },
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const configuration = { baseUrl: 'https://codex-design.invalid/artifacts/one/', artifactId: 'one', channel: 'theme-channel' };
  if (serialized) vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target)', {
    configuration, target, URL, Map, Set, Uint8Array, EventTarget, Event, MessageEvent, AbortController, DOMException, Blob, Request, Response, TextEncoder, TextDecoder, setTimeout, clearTimeout,
  });
  else installNativeEditorTransport(configuration, target);
  return { target, root: html, editor, authored, nestedArtworkRoot, preview, elements, observers, messages, canvasPaints,
    update(context, snapshot = false) { listeners.get('message')({ source: parent, data: { type: 'codex-design:host-context-changed', channel: 'theme-channel', context, hostContextIsSnapshot: snapshot } }); },
    portal() { const portal = new Element('div', { ui: true }); portal.setAttribute('data-density', 'comfortable'); roots.push(portal); return portal; },
    commentShadow(authored = false) {
      const host = new Element('span', { authored }); host.setAttribute('data-baoyu-comments-seat', ''); commentHosts.push(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const popup = new Element('div', { ui: true }); popup.setAttribute('data-density', 'comfortable'); shadow.roots.push(popup);
      if (authored) Object.defineProperty(host, 'shadowRoot', { get() { assert.fail('Authored shadow content must remain untouched.'); } });
      return { host, shadow, popup };
    },
    historyShadow(authored = false) {
      const host = new Element('div', { authored }); host.setAttribute('data-baoyu-history-layer', ''); commentHosts.push(host);
      const shadow = host.attachShadow({ mode: 'open' }), popup = new Element('div'); shadow.wraps.push(popup);
      if (authored) Object.defineProperty(host, 'shadowRoot', { get() { assert.fail('Authored history-like markup must remain untouched.'); } });
      return { host, shadow, popup };
    },
    originalAttachShadow,
    mutations(records = [{ type: 'childList', target: body, addedNodes: roots, removedNodes: [] }]) { for (const observer of observers) if (!observer.closed) observer.callback(records); },
    close() { listeners.get('unload')(); },
  };
}

const hostVariables = {
  '--font-sans': '"Codex Test Sans", sans-serif', '--font-mono': '"Codex Test Mono", monospace',
  '--font-text-md-size': '14px', '--font-text-md-line-height': '1.5',
  '--font-weight-normal': '420', '--font-weight-medium': '520', '--font-weight-semibold': '620', '--font-weight-bold': '720',
  '--color-background-primary': '#101114', '--color-background-secondary': '#202329', '--color-background-tertiary': '#30343c',
  '--color-text-primary': '#f2f4f7', '--color-text-secondary': '#b6bdc8', '--color-text-tertiary': '#8a94a4', '--color-text-inverse': '#14161b',
  '--color-text-info': '#7cafff', '--color-text-danger': '#fa9094', '--color-text-success': '#6cd4a0', '--color-text-warning': '#e5c96b',
  '--color-border-primary': '#6b778a', '--color-border-secondary': '#424c5c', '--color-ring-primary': '#91baff', '--color-ring-danger': '#fa9094',
  '--border-radius-xs': '3px', '--border-radius-sm': '5px', '--border-radius-md': '7px', '--border-radius-lg': '11px',
  '--shadow-sm': '0 1px 3px #0003', '--shadow-md': '0 4px 12px #0004', '--shadow-lg': '0 8px 24px #0005',
};

test('the canonical History shadow layer follows host fonts and colors without touching authored lookalikes', () => {
  const f = themeFixture({ serialized: true });
  const history = f.historyShadow(), authored = f.historyShadow(true);
  const original = [...f.authored.style.values];
  f.update({ theme: 'light', styles: { variables: hostVariables } }, true);
  assert.equal(history.popup.style.getPropertyValue('font-family'), hostVariables['--font-sans']);
  assert.equal(history.popup.style.getPropertyValue('font-size'), '14px');
  assert.equal(history.popup.style.getPropertyValue('--bg'), 'rgb(32, 35, 41)');
  assert.equal(history.popup.style.getPropertyPriority('--bg'), 'important');
  assert.equal(history.popup.style.getPropertyValue('--fg'), '#f2f4f7');
  assert.equal(authored.popup.style.writes, 0);
  assert.deepEqual([...f.authored.style.values], original);
  f.close();
  assert.equal(history.popup.style.getPropertyValue('--bg'), '');
  assert.equal(history.popup.style.getPropertyValue('font-family'), '');
});

test('History composites translucent host panels over the host base without exposing underlying controls or recoloring artwork', () => {
  for (const [theme, primary, secondary, expected] of [
    ['dark', '#121212', 'rgba(255, 255, 255, 0.08)', 'rgb(37, 37, 37)'],
    ['light', '#f0f0f0', 'rgba(0, 0, 0, 0.05)', 'rgb(228, 228, 228)'],
    ['dark', '#123456', 'transparent', 'rgb(18, 52, 86)'],
  ]) {
    const f = themeFixture({ serialized: true });
    const history = f.historyShadow(), lookalike = f.historyShadow(true);
    const authored = [...f.authored.style.values], sourcePreview = f.preview.srcdoc;
    f.update({ theme, styles: { variables: { ...hostVariables, '--color-background-primary': primary, '--color-background-secondary': secondary } } }, true);
    assert.equal(history.popup.style.getPropertyValue('--bg'), expected);
    assert.equal(history.popup.style.getPropertyPriority('--bg'), 'important');
    assert.equal(f.editor.style.getPropertyValue('--cds-surface-panel'), secondary, 'Other CDS roots retain their original host alpha semantics.');
    assert.deepEqual(f.canvasPaints.map(paint => paint.color), [theme === 'light' ? '#ffffff' : '#262624', primary, secondary]);
    for (const paint of f.canvasPaints) { assert.equal(paint.operation, 'source-over'); assert.equal(paint.canvas.parent, undefined); }
    assert.equal(lookalike.popup.style.writes, 0);
    assert.deepEqual([...f.authored.style.values], authored); assert.equal(f.preview.srcdoc, sourcePreview);
    assert.equal(f.messages.some(message => message.action === 'editor.request'), false);
    const paints = f.canvasPaints.length;
    f.update({ theme });
    assert.equal(f.canvasPaints.length, paints, 'Unchanged host colors do not redraw a compositing probe.');
    f.close();
  }
});

test('History uses browser-resolved CSS colors, recomposites palette changes and restores the exact prior value on clear', () => {
  const mixed = 'color-mix(in srgb, white 8%, transparent)';
  const f = themeFixture({ computedColors: { [mixed]: 'rgba(255, 255, 255, 0.08)' } });
  const history = f.historyShadow();
  history.popup.style.setProperty('--bg', 'original-history-background', 'important');
  f.update({ theme: 'dark', styles: { variables: { '--color-background-primary': '#121212', '--color-background-secondary': mixed } } }, true);
  assert.equal(history.popup.style.getPropertyValue('--bg'), 'rgb(37, 37, 37)');
  assert.equal(f.canvasPaints.at(-1).color, 'rgba(255, 255, 255, 0.08)');
  f.update({ styles: { variables: { '--color-background-secondary': 'rgba(0, 0, 0, 0.5)' } } });
  assert.equal(history.popup.style.getPropertyValue('--bg'), 'rgb(9, 9, 9)');
  const late = f.historyShadow(); f.mutations();
  assert.equal(late.popup.style.getPropertyValue('--bg'), 'rgb(9, 9, 9)');
  f.update({ styles: { variables: null } });
  assert.equal(history.popup.style.getPropertyValue('--bg'), 'original-history-background');
  assert.equal(history.popup.style.getPropertyPriority('--bg'), 'important');
  assert.equal(late.popup.style.getPropertyValue('--bg'), '');
  f.close();
});

test('History remains opaque with transparent host bases or an unavailable local compositor', () => {
  const transparent = themeFixture();
  const history = transparent.historyShadow();
  transparent.update({ theme: 'dark', styles: { variables: { '--color-background-primary': 'transparent', '--color-background-secondary': 'transparent' } } }, true);
  assert.equal(history.popup.style.getPropertyValue('--bg'), 'rgb(38, 38, 36)');
  transparent.close();
  for (const [theme, expected] of [['dark', '#262624'], ['light', '#ffffff']]) {
    const f = themeFixture({ canvas: false }), history = f.historyShadow();
    f.update({ theme, styles: { variables: { '--color-background-primary': 'transparent', '--color-background-secondary': 'rgba(255, 255, 255, 0.08)' } } }, true);
    assert.equal(history.popup.style.getPropertyValue('--bg'), expected);
    f.close(); assert.equal(history.popup.style.getPropertyValue('--bg'), '');
  }
});

test('host semantic tokens override actual nested CDS declarations while preserving artwork boundaries', async () => {
  const f = themeFixture({ serialized: true });
  const untouched = [f.authored, f.nestedArtworkRoot].map(element => [...element.style.values]);
  const preview = f.preview.srcdoc;
  f.update({ theme: 'dark', styles: { variables: hostVariables, css: { fonts: '@font-face{font-family:"Codex Test Sans";src:local("Arial")}' } } }, true);
  for (const root of [f.root, f.editor]) {
    assert.equal(root.style.getPropertyValue('--cds-font-sans'), hostVariables['--font-sans']);
    assert.equal(root.style.getPropertyPriority('--cds-font-sans'), 'important');
    assert.equal(root.style.getPropertyValue('--cds-font-mono-ui'), hostVariables['--font-mono']);
    assert.equal(root.style.getPropertyValue('--cds-font-size-body'), '14px');
    assert.equal(root.style.getPropertyValue('--cds-rem-scale'), '1');
    assert.equal(root.style.getPropertyValue('--cds-leading-body'), '1.5');
    assert.equal(root.style.getPropertyValue('--cds-font-weight-regular'), '420');
    assert.equal(root.style.getPropertyValue('--cds-font-wght-semibold'), '"wght" 620');
    assert.equal(root.style.getPropertyValue('--cds-page-bg'), '#101114');
    assert.equal(root.style.getPropertyValue('--cds-surface-panel'), '#202329');
    assert.equal(root.style.getPropertyValue('--cds-text-primary'), '#f2f4f7');
    assert.equal(root.style.getPropertyValue('--cds-border'), '#424c5c');
    assert.equal(root.style.getPropertyValue('--cds-fill-accent'), '#7cafff');
    assert.equal(root.style.getPropertyValue('--cds-text-danger'), '#fa9094');
    assert.equal(root.style.getPropertyValue('--cds-focus-shadow'), '0 0 0 2px #91baff');
    assert.equal(root.style.getPropertyValue('--cds-radius'), '7px');
    assert.equal(root.style.getPropertyValue('--cds-shadow-popover'), '0 4px 12px #0004');
    assert.equal(root.style.getPropertyValue('--cds-font-system'), '');
    assert.equal(root.style.getPropertyValue('--cds-font-mono'), '');
  }
  assert.deepEqual([f.authored, f.nestedArtworkRoot].map(element => [...element.style.values]), untouched);
  assert.equal(f.preview.srcdoc, preview);
  assert.equal(f.messages.some(message => message.action === 'editor.request'), false);
  for (const kind of ['slides', 'design', 'design-system', 'dashboard']) {
    const assets = new URL('../codex-design/skills/codex-' + kind + '/scripts/editor/assets/', import.meta.url);
    const filename = (await fs.readdir(assets)).find(name => /^index-.*\.css$/.test(name));
    const css = await fs.readFile(new URL(filename, assets), 'utf8');
    assert.match(css, /--cds-font-size-body:\s*calc\(\.875rem \* var\(--cds-rem-scale,\s*1\)\)/);
    assert.match(css, /\.cds-root\{[^{}]*--cds-font-sans:\s*var\(--font-anthropic-sans/);
    assert.match(css, /\[data-appifact-content\]\{[^{}]*--cds-font-sans:\s*var\(--cds-font-system\)/);
  }
  f.close();
});

test('CSS font lengths use their actual units and preserve the vendor hierarchy at 16/18px', () => {
  for (const [input, extra, expected] of [
    ['16px', {}, 16], ['1.125rem', {}, 18],
    ['var(--my-ui-size)', { '--my-ui-size': '18px' }, 18],
    ['calc(1rem + 2px)', {}, 18],
  ]) {
    const f = themeFixture();
    f.update({ styles: { variables: { ...hostVariables, ...extra, '--font-text-md-size': input } } }, true);
    assert.equal(f.editor.style.getPropertyValue('--cds-font-size-body'), expected + 'px');
    assert.equal(Number(f.editor.style.getPropertyValue('--cds-rem-scale')), expected / 14);
    f.close();
  }
  const largeRoot = themeFixture({ rem: 20 });
  largeRoot.update({ styles: { variables: { '--font-text-md-size': '1rem' } } }, true);
  assert.equal(largeRoot.editor.style.getPropertyValue('--cds-font-size-body'), '20px');
  assert.equal(Number(largeRoot.editor.style.getPropertyValue('--cds-rem-scale')), 20 / 17.5);
  largeRoot.close();
});

test('partial host contexts merge, complete snapshots remove stale tokens, and explicit clears restore local values', () => {
  const f = themeFixture();
  f.editor.style.setProperty('--cds-page-bg', 'vendor-background');
  f.editor.style.setProperty('--cds-font-sans', 'Vendor Sans');
  f.update({ theme: 'dark', styles: { variables: hostVariables, css: { fonts: '@font-face{font-family:SnapshotFont;src:local(Arial)}' } } }, true);
  f.update({ theme: 'light' });
  assert.equal(f.root.getAttribute('data-theme'), 'light');
  assert.equal(f.editor.style.getPropertyValue('--cds-page-bg'), '#101114');
  assert.match(f.target.document.getElementById('codex-native-host-fonts').textContent, /SnapshotFont/);
  f.update({ styles: { variables: { '--font-sans': 'Another Sans' } } });
  assert.equal(f.editor.style.getPropertyValue('--cds-font-sans'), 'Another Sans');
  assert.equal(f.editor.style.getPropertyValue('--cds-page-bg'), '#101114');
  f.update({ theme: 'light', styles: { variables: { '--font-sans': 'Another Sans' } } }, true);
  assert.equal(f.editor.style.getPropertyValue('--cds-page-bg'), 'vendor-background');
  assert.equal(f.editor.style.getPropertyValue('--cds-rem-scale'), '');
  assert.equal(f.target.document.getElementById('codex-native-host-fonts'), undefined);
  f.update({ styles: { variables: { '--font-sans': null } } });
  assert.equal(f.editor.style.getPropertyValue('--cds-font-sans'), 'Vendor Sans');
  f.update({ styles: { variables: hostVariables } });
  f.update({ styles: { variables: null } });
  assert.equal(f.editor.style.getPropertyValue('--cds-page-bg'), 'vendor-background');
  assert.equal(f.editor.style.getPropertyValue('--cds-font-sans'), 'Vendor Sans');
  f.close();
});

test('light/custom palettes and newly mounted portals follow the host, including React style replacements', () => {
  const f = themeFixture();
  f.update({ theme: 'dark', styles: { variables: hostVariables } }, true);
  const portal = f.portal();
  f.mutations();
  assert.equal(portal.style.getPropertyValue('--cds-font-sans'), hostVariables['--font-sans']);
  assert.equal(portal.style.getPropertyValue('--cds-text-primary'), '#f2f4f7');
  const light = { ...hostVariables, '--font-text-md-size': '18px', '--color-background-primary': '#faf6ed', '--color-text-primary': '#231f19' };
  f.update({ theme: 'light', styles: { variables: light } }, true);
  assert.equal(portal.style.getPropertyValue('--cds-page-bg'), '#faf6ed');
  assert.equal(portal.style.getPropertyValue('--cds-text-primary'), '#231f19');
  assert.equal(portal.style.getPropertyValue('--cds-font-size-body'), '18px');
  portal.style.setProperty('--cds-font-sans', 'React replacement');
  f.mutations();
  assert.equal(portal.style.getPropertyValue('--cds-font-sans'), hostVariables['--font-sans']);
  const writes = portal.style.writes;
  f.mutations();
  assert.equal(portal.style.writes, writes, 'unchanged observer deliveries cannot cause a style-write loop');
  f.update({ styles: { variables: {} } }, true);
  assert.equal(portal.style.getPropertyValue('--cds-font-sans'), 'React replacement');
  f.close();
  assert.equal(f.observers[0].closed, true);
});

test('unknown/cyclic CSS variables and invalid sizes do not become parseFloat-based or stale font overrides', () => {
  const f = themeFixture();
  f.update({ styles: { variables: hostVariables } }, true);
  for (const value of ['var(--absent)', 'var(--cycle)', 'INVALID', '2px', '100px']) {
    f.update({ styles: { variables: { '--font-text-md-size': value, '--cycle': 'var(--cycle)' } } }, true);
    assert.equal(f.editor.style.getPropertyValue('--cds-font-size-body'), '', value);
    assert.equal(f.editor.style.getPropertyValue('--cds-rem-scale'), '', value);
  }
  f.close();
});

test('canonical comment shadow portals follow host tokens while authored shadow roots remain isolated', () => {
  const f = themeFixture();
  const early = f.commentShadow();
  const authored = f.commentShadow(true);
  f.update({ theme: 'dark', styles: { variables: hostVariables } }, true);
  assert.equal(early.popup.style.getPropertyValue('--cds-font-sans'), hostVariables['--font-sans']);
  assert.equal(early.popup.style.getPropertyValue('--cds-surface-panel'), '#202329');
  const late = f.commentShadow(); f.mutations();
  assert.equal(late.popup.style.getPropertyValue('--cds-text-primary'), '#f2f4f7');
  assert.equal(late.popup.style.getPropertyValue('--cds-font-size-body'), '14px');
  f.update({ theme: 'light', styles: { variables: { ...hostVariables, '--color-background-secondary': '#f4efdf' } } }, true);
  assert.equal(early.popup.style.getPropertyValue('--cds-surface-panel'), '#f4efdf');
  assert.equal(late.popup.style.getPropertyValue('--cds-surface-panel'), '#f4efdf');
  assert.equal(authored.popup.style.writes, 0);
  f.close();
  assert.equal(f.target.Element.prototype.attachShadow, f.originalAttachShadow);
});

test('native editor broker marks forwarded SDK context as an authoritative snapshot', async t => {
  let listener, subscriber;
  const sent = [], ownerWindow = { addEventListener: (_, handler) => { listener = handler; }, removeEventListener() {} };
  const iframe = { ownerDocument: { defaultView: ownerWindow }, contentWindow: { postMessage: message => sent.push(message) }, setAttribute() {} };
  const bridge = { hostContext: { theme: 'dark', styles: { variables: hostVariables } }, invoke() {}, subscribe(handler) { subscriber = handler; return () => {}; } };
  const editor = mountNativeEditor({ iframe, bridge, artifactId: 'one', channel: 'snapshot-channel', document: { html: '<html><body>editor</body></html>' } });
  t.after(() => editor.dispose());
  await listener({ source: iframe.contentWindow, data: { type: 'codex-design:editor-transport-ready', channel: 'snapshot-channel' } });
  assert.equal(sent.at(-1).hostContextIsSnapshot, true);
  assert.equal(sent.at(-1).context, bridge.hostContext);
  bridge.hostContext = { theme: 'light', styles: { variables: {} } };
  subscriber({ type: 'host-context.changed' });
  assert.equal(sent.at(-1).hostContextIsSnapshot, true);
  assert.deepEqual(sent.at(-1).context.styles.variables, {});
});

test('interactive downloads have no network deadline; normal RPC timeout, user cancellation and unload retain cleanup', async () => {
  const listeners = new Map(), sent = [], timers = new Map();
  let timerId = 0;
  const parent = { postMessage: message => sent.push(message) };
  const target = { parent, fetch: async () => {}, addEventListener: (type, handler) => listeners.set(type, handler), btoa, atob };
  vm.runInNewContext('(' + installNativeEditorTransport.toString() + ')(configuration,target)', {
    target, configuration: { baseUrl: 'https://codex-design.invalid/artifacts/one/', channel: 'download-lifetime' },
    URL, Map, Set, Uint8Array, EventTarget, Event, MessageEvent, AbortController, DOMException, Blob, Request, Response, TextEncoder, TextDecoder,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  target.designHost = {};
  let downloadDone = false;
  const download = target.designHost.downloads.save({ filename: 'deck.pdf', data: new Blob(['test']) }).finally(() => { downloadDone = true; });
  const cancelled = assert.rejects(download, { code: 'declined' });
  await new Promise(resolve => setImmediate(resolve));
  const downloadRequest = sent.find(message => message.action === 'editor.download');
  assert.ok(downloadRequest);
  assert.equal(timers.size, 0);
  const normal = target.fetch('project/deck.json');
  const timedOut = assert.rejects(normal, { code: 'EDITOR_TRANSPORT_TIMEOUT' });
  assert.equal(timers.size, 1);
  const deadline = [...timers.values()][0];
  assert.equal(deadline.delay, 45_000);
  deadline.callback(); await timedOut;
  assert.equal(downloadDone, false);
  listeners.get('message')({ source: parent, data: { type: 'codex-design:editor-response', channel: 'download-lifetime', requestId: downloadRequest.requestId,
    error: { code: 'DOWNLOAD_CANCELLED', message: 'Save was cancelled.' } } });
  await cancelled;
  const second = target.designHost.downloads.save({ filename: 'another.pdf', data: new Blob(['test']) });
  const closed = assert.rejects(second, { code: 'EDITOR_CLOSED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.size, 0);
  listeners.get('unload')(); await closed;
  const count = sent.length;
  await assert.rejects(target.fetch('project/deck.json'), { code: 'EDITOR_CLOSED' });
  assert.equal(sent.length, count);
});
