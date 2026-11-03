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

test('transformRect bounds stay correct for rectangles left of or above the origin', () => {
  const {core} = loadCore({supportsReset: true});
  const rect = core.transformRect([1, 0, 0, 1, 0, 0], {xMin: -30, xMax: -10, yMin: -8, yMax: -2});
  assert.deepEqual({...rect}, {xMin: -30, xMax: -10, yMin: -8, yMax: -2});
});

test('tint results are cached on images, never on or in pooled canvases', () => {
  const {core} = loadCore({supportsReset: true});
  const proto = core.CanvasRenderingContext2D.prototype;
  proto.drawImage = () => {};
  proto.getImageData = (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)});
  proto.putImageData = () => {};
  const tint = new core.cxform(0, 0, 0, 0, 128, 128, 128, 255);
  const image = {width: 4, height: 4};
  const a = tint.applyToImage(image);
  assert.equal(tint.applyToImage(image), a, 'image results stay cached');

  core.beginCanvasPool();
  const stage = core.createCanvas(620, 360);
  assert.equal(stage._pooled, true);
  const first = tint.applyToImage(stage);
  assert.equal(stage._cxCache, undefined, 'pooled canvases carry no cache into the next frame');
  assert.notEqual(tint.applyToImage(stage), first);
});

test("drawPath and drawMorphPath preserve positive stroke width under flip and rotation and restore lineWidth", () => {
  const {core} = loadCore({supportsReset: true});
  const widths = [];
  let savedWidth = 0;
  const ctx = {
    _matrix: [-0.8, 0, 0, -1.2, 0, 0],
    lineWidth: 4,
    save() { savedWidth = this.lineWidth; },
    restore() { this.lineWidth = savedWidth; },
    setTransform() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    quadraticCurveTo() {},
    closePath() {},
    stroke() { widths.push(this.lineWidth); }
  };
  core.drawPath(ctx, "M 0 0 L 10 10", true, "NORMAL");
  assert.ok(widths[0] > 0, "flipped NORMAL stroke stays positive");
  assert.equal(ctx.lineWidth, 4, "outer lineWidth is restored after stroke");

  ctx._matrix = [0, -1.5, 1.5, 0, 0, 0];
  core.drawPath(ctx, "M 0 0 L 10 10", true, "NORMAL");
  assert.equal(widths[1], 4 * 20 * 1.5, "90-degree rotated NORMAL stroke uses off-diagonal scale");

  ctx._matrix = [-1, 0, 0, -2, 0, 0];
  core.drawMorphPath(ctx, "M 0 0 0 0 L 10 10 20 20", 32768, true, "VERTICAL");
  assert.equal(widths[2], 4 * 20 * 2, "flipped VERTICAL morph stroke stays positive");
  assert.equal(ctx.lineWidth, 4);
});
