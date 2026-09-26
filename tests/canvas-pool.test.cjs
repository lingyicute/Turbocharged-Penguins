const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'canvas-core.js'), 'utf8');

function loadCore({supportsReset}) {
  const state = {created: [], resetCalls: 0};
  class MockContext {
    save() {}
    restore() {}
    transform() {}
    setTransform() {}
    resetTransform() {}
    fillRect() {}
    clip() {}
    beginPath() {}
    moveTo() {}
    lineTo() {}
    quadraticCurveTo() {}
    createPattern() { return {}; }
    clearRect() {}
  }
  if (supportsReset) {
    MockContext.prototype.reset = function() { state.resetCalls++; };
  }

  const gameCanvas = {width: 620, height: 360, isConnected: true};
  const document = {
    getElementById(id) { return id === 'game' ? gameCanvas : null; },
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        getContext() { return new MockContext(); }
      };
      state.created.push(canvas);
      return canvas;
    }
  };
  const context = vm.createContext({CanvasRenderingContext2D: MockContext, document});
  vm.runInContext(coreSource, context, {filename: 'assets/canvas-core.js'});
  return {core: context, state};
}

test('stage-sized canvases are not pooled when the context cannot fully reset', () => {
  const {core, state} = loadCore({supportsReset: false});
  const first = core.createCanvas(620, 360);

  core.beginCanvasPool();
  const nextFrame = core.createCanvas(620, 360);

  assert.notEqual(nextFrame, first, 'without reset(), reuse could retain native clip/save state');
  assert.equal(state.created.length, 2);
});

test('stage-sized canvases remain pooled when reset() is available', () => {
  const {core, state} = loadCore({supportsReset: true});
  const first = core.createCanvas(620, 360);

  core.beginCanvasPool();
  const nextFrame = core.createCanvas(620, 360);

  assert.equal(nextFrame, first);
  assert.equal(state.created.length, 1);
  assert.equal(state.resetCalls, 1);
});
