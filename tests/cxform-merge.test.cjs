const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'canvas-core.js'), 'utf8');

function loadCore() {
  class MockContext {}
  const document = {getElementById: () => null, createElement: () => ({getContext: () => new MockContext()})};
  const context = vm.createContext({CanvasRenderingContext2D: MockContext, document});
  vm.runInContext(coreSource, context, {filename: 'assets/canvas-core.js'});
  return context;
}

// Pixel scale: out = v * mult / 255 + add. Merging must equal applying the
// child first and the parent second, as Flash concatenates nested transforms.
function applyChannel(cx, ch, v) {
  return v * cx[ch + '_mult'] / 255 + cx[ch + '_add'];
}

test('merged transform equals child-then-parent application', () => {
  const {cxform} = loadCore();
  const parent = new cxform(10, -20, 30, 0, 166, 128, 90, 255);
  const child = new cxform(253, 200, 40, 0, 0, 200, 255, 255);
  const merged = parent.merge(child);
  for (const ch of ['r', 'g', 'b']) {
    for (const v of [0, 17, 128, 255]) {
      const expected = applyChannel(parent, ch, applyChannel(child, ch, v));
      assert.ok(Math.abs(applyChannel(merged, ch, v) - expected) < 1e-9, `${ch}@${v}`);
    }
  }
});

test('child offsets are scaled by the parent multiplier', () => {
  const {cxform} = loadCore();
  const merged = new cxform(0, 0, 0, 0, 128, 128, 128, 255).merge(new cxform(200, 100, 0, 0, 0, 0, 0, 255));
  assert.ok(Math.abs(merged.r_add - 200 * 128 / 255) < 1e-9);
  assert.ok(Math.abs(merged.g_add - 100 * 128 / 255) < 1e-9);
  assert.equal(merged.b_add, 0);
});

test('merging with an identity transform returns the other transform', () => {
  const {cxform} = loadCore();
  const identity = new cxform(0, 0, 0, 0, 255, 255, 255, 255);
  const tint = new cxform(5, 6, 7, 0, 100, 110, 120, 255);
  assert.equal(identity.merge(tint), tint);
  assert.equal(tint.merge(identity), tint);
});
