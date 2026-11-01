import test from 'node:test';
import assert from 'node:assert/strict';
import { createMenuDismissal, menuInputMode } from '../source/ui/menu-dismissal.mjs';

function fixture() {
  const surface = () => {
    const listeners = new Map();
    return {
      addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
      removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
      emit(name, event = {}) { for (const handler of [...listeners.get(name) || []]) handler({ target: this, ...event }); },
    };
  };
  const node = (parent, tagName = 'BUTTON') => ({ parent, tagName, contains(target) { for (; target; target = target.parent) if (target === this) return true; return false; } });
  const document = surface(), window = surface(), trigger = node(), menu = node(null, 'DIV'), item = node(menu), outside = node(), iframe = node(null, 'IFRAME');
  // The helper must not inspect cross-origin content, including from blur paths.
  Object.defineProperties(iframe, { contentDocument: { get() { throw new Error('Opaque iframe content is inaccessible.'); } }, contentWindow: { get() { throw new Error('Do not inspect editor frames.'); } } });
  let now = 0, next = 0;
  const timers = new Map(), dismissed = [];
  const helper = createMenuDismissal({ document, window, onDismiss: value => dismissed.push(value),
    setTimeout(handler, delay) { const id = ++next; timers.set(id, { at: now + delay, handler }); return id; },
    clearTimeout(id) { timers.delete(id); } });
  const tick = ms => { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.handler(); } };
  return { helper, document, window, trigger, menu, item, outside, iframe, dismissed, tick, node,
    open(mode = 'pointer') { helper.open({ trigger, menu, mode }); },
    mouse(name, target, relatedTarget) { document.emit(name, { target, relatedTarget, pointerType: 'mouse' }); },
  };
}

test('mouse crosses the trigger-menu gap without dismissing, then closes after leaving both', () => {
  const f = fixture(); f.open();
  f.mouse('pointerout', f.trigger, f.outside); f.tick(120);
  assert.deepEqual(f.dismissed, []);
  f.mouse('pointerover', f.item); f.tick(500);
  assert.deepEqual(f.dismissed, []);
  f.mouse('pointerout', f.item, f.outside); f.tick(219);
  assert.deepEqual(f.dismissed, []);
  f.tick(1); assert.deepEqual(f.dismissed, [false]);
});

test('programmatic menu focus does not disable mouse dismissal, but keyboard navigation cancels it', () => {
  const f = fixture(); f.open();
  f.document.emit('focusin', { target: f.item });
  f.mouse('pointerout', f.trigger, f.outside); f.tick(220);
  assert.deepEqual(f.dismissed, [false]);
  f.open(); f.mouse('pointerout', f.item, f.outside);
  f.document.emit('keydown', { target: f.item, key: 'ArrowDown' }); f.tick(300);
  f.mouse('pointerout', f.item, f.outside); f.tick(300);
  assert.deepEqual(f.dismissed, [false]);
  f.mouse('pointermove', f.item); f.mouse('pointerout', f.item, f.outside); f.tick(220);
  assert.deepEqual(f.dismissed, [false, false]);
});

test('keyboard-opened menus ignore incidental pointer exits until the user resumes mouse navigation', () => {
  const f = fixture(); f.open('keyboard');
  f.mouse('pointerout', f.trigger, f.outside); f.mouse('pointerover', f.iframe); f.tick(500);
  assert.deepEqual(f.dismissed, []);
  f.mouse('pointermove', f.item); f.mouse('pointerout', f.item, f.outside); f.tick(220);
  assert.deepEqual(f.dismissed, [false]);
});

test('touch menus require explicit actions or an outside press, never hover', () => {
  const f = fixture(); f.open('touch');
  f.document.emit('pointerout', { target: f.trigger, relatedTarget: f.outside, pointerType: 'touch' });
  f.mouse('pointerout', f.trigger, f.outside); f.tick(1000);
  assert.deepEqual(f.dismissed, []);
  f.document.emit('pointerdown', { target: f.item, pointerType: 'touch' });
  assert.deepEqual(f.dismissed, []);
  f.document.emit('pointerdown', { target: f.outside, pointerType: 'touch' });
  assert.deepEqual(f.dismissed, [false]);
});

test('outside presses dismiss, including a different menu trigger, without returning focus', () => {
  const f = fixture(); f.open();
  for (const target of [f.trigger, f.item]) f.document.emit('pointerdown', { target, pointerType: 'mouse' });
  assert.deepEqual(f.dismissed, []);
  const anotherTrigger = f.node(); anotherTrigger.dataset = { menuTrigger: 'true' };
  f.document.emit('pointerdown', { target: anotherTrigger, pointerType: 'mouse' });
  assert.deepEqual(f.dismissed, [false]);
});

test('Escape returns menu focus and is not consumed when only a dialog remains', () => {
  const f = fixture(); f.open('keyboard'); let prevented = 0, stopped = 0;
  const event = { target: f.item, key: 'Escape', preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  f.document.emit('keydown', event);
  assert.deepEqual(f.dismissed, [true]);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  f.document.emit('keydown', { ...event, target: f.outside });
  f.window.emit('blur'); f.mouse('pointerout', f.item, f.outside); f.tick(1000);
  assert.equal(prevented, 1); assert.equal(stopped, 1); assert.equal(f.dismissed.length, 1);
});

test('crossing an iframe-backed gap on the way from trigger to menu cancels the same leave timer', () => {
  const f = fixture(); f.open();
  f.mouse('pointerout', f.trigger, f.iframe); f.tick(40);
  f.mouse('pointerenter', f.iframe); f.tick(100);
  assert.deepEqual(f.dismissed, []);
  f.mouse('pointerenter', f.item); f.tick(1000);
  assert.deepEqual(f.dismissed, []);
});

test('opaque iframe hover waits for the leave grace but actual presses and blur dismiss immediately', () => {
  const f = fixture(); f.open();
  f.mouse('pointerenter', f.iframe); f.tick(219);
  assert.deepEqual(f.dismissed, []);
  f.tick(1); assert.deepEqual(f.dismissed, [false]);
  f.open(); f.mouse('pointerenter', f.iframe);
  f.document.emit('pointerdown', { target: f.iframe, pointerType: 'mouse' });
  assert.deepEqual(f.dismissed, [false, false]);
  f.open('keyboard'); f.window.emit('blur'); assert.deepEqual(f.dismissed, [false, false, false]);
});

test('focus leaving the menu closes it, and replacing/disposal cancels old timers', () => {
  const f = fixture(); f.open(); f.document.emit('focusin', { target: f.outside });
  assert.deepEqual(f.dismissed, [false]);
  f.open(); f.mouse('pointerout', f.trigger, f.outside); f.tick(100); f.open('keyboard'); f.tick(500);
  assert.equal(f.dismissed.length, 1);
  f.open(); f.mouse('pointerout', f.item, f.outside); f.helper.dispose(); f.tick(500);
  f.window.emit('blur'); f.document.emit('pointerdown', { target: f.outside });
  assert.equal(f.dismissed.length, 1);
});

test('captured element blur cannot dismiss a menu during trigger-to-item or item-to-item focus transfer', () => {
  const f = fixture(); f.open();
  f.window.emit('blur', { target: f.trigger, relatedTarget: f.item });
  f.document.emit('focusin', { target: f.item });
  assert.deepEqual(f.dismissed, []);
  const nextItem = f.node(f.menu);
  f.window.emit('blur', { target: f.item, relatedTarget: nextItem });
  f.document.emit('focusin', { target: nextItem });
  f.tick(1000);
  assert.deepEqual(f.dismissed, []);
  f.window.emit('blur');
  assert.deepEqual(f.dismissed, [false], 'genuine window blur still closes the menu');
});

test('activation modality distinguishes keyboard and touch without treating focused mouse menus as keyboard', () => {
  assert.equal(menuInputMode({ detail: 0 }), 'keyboard');
  assert.equal(menuInputMode({ detail: 1, pointerType: 'mouse' }), 'pointer');
  assert.equal(menuInputMode({ detail: 0, pointerType: 'touch' }), 'touch');
  assert.equal(menuInputMode({ detail: 0, pointerType: 'pen' }), 'touch');
});
