import test from 'node:test';
import assert from 'node:assert/strict';
import { menuPosition } from '../source/ui/layout.mjs';

test('create menu anchors below the sidebar create control when there is room', () => {
  const result = menuPosition({ left: 24, right: 240, top: 64, bottom: 108 }, { width: 252, height: 244, viewportWidth: 1200, viewportHeight: 800, align: 'start' });
  assert.deepEqual(result, { left: 24, top: 114, width: 252, maxHeight: 784 });
});

test('bottom row action menu flips above its anchor and stays inside the viewport', () => {
  const result = menuPosition({ left: 1135, right: 1175, top: 750, bottom: 790 }, { width: 220, height: 158, viewportWidth: 1200, viewportHeight: 800 });
  assert.equal(result.left, 955);
  assert.equal(result.top, 586);
});

test('small window keeps the menu within the available viewport with internal scrolling', () => {
  const result = menuPosition({ left: 0, right: 44, top: 90, bottom: 134 }, { width: 252, height: 300, viewportWidth: 240, viewportHeight: 160, align: 'start' });
  assert.deepEqual(result, { left: 8, top: 8, width: 224, maxHeight: 144 });
});
