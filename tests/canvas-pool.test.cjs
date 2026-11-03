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

test("gradientGlow and gradientBevel use local canvas contexts and integer LUT indices", () => {
  const {core} = loadCore({supportsReset: true});
  const proto = core.CanvasRenderingContext2D.prototype;
  proto.createLinearGradient = () => ({addColorStop() {}});
  proto.drawImage = () => {};
  proto.createImageData = (w, h) => ({data: new Uint8ClampedArray(w * h * 4), width: w, height: h});
  proto.getImageData = (x, y, w, h) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) { data[i] = 100; data[i + 2] = 30; data[i + 3] = 200; }
    return {data, width: w, height: h};
  };
  proto.putImageData = () => {};
  const srcCanvas = core.createCanvas(4, 4);
  const srcCtx = srcCanvas.getContext("2d");
  const glow = core.Filters.gradientGlow(srcCanvas, srcCtx, 2, 2, 45, 1, [[255, 0, 0, 1], [0, 0, 255, 1]], [0, 1], core.Filters.FULL, 1, 1.5, false);
  assert.equal(glow.width, 4);
  const bevel = core.Filters.gradientBevel(srcCanvas, srcCtx, [[255, 0, 0, 1], [0, 255, 0, 1]], [0, 1], 2, 2, 1.5, core.Filters.FULL, 45, 1, true, 1);
  assert.equal(bevel.width, 4);
});

test("cxform.merge returns the other operand without allocation when either side is identity", () => {
  const {core} = loadCore({supportsReset: true});
  const id = new core.cxform(0, 0, 0, 0, 255, 255, 255, 255);
  const tint = new core.cxform(10, 20, 30, 0, 128, 128, 128, 256);
  assert.equal(id.merge(tint), tint);
  assert.equal(tint.merge(id), tint);
  assert.equal(id.merge(id), id);
});

test("drawMorphPath handles Z closePath, BlendModes.normal binds _cut, and restore pops _clipBox", () => {
  const {core} = loadCore({supportsReset: true});
  const ops = [];
  const ctx = core.enhanceContext(new core.CanvasRenderingContext2D());
  ctx.lineWidth = 2;
  ctx.closePath = () => ops.push("closePath");
  ctx.stroke = () => ops.push("stroke");
  core.drawMorphPath(ctx, "M 0 0 0 0 L 10 0 20 0 Z L 5 5 10 10", 32768, true, "NONE");
  assert.ok(ops.includes("closePath"), "stroked morph path emits closePath for Z");
  ops.length = 0;
  core.drawMorphPath(ctx, "M 0 0 0 0 L 10 0 20 0 Z", 0, false);
  assert.ok(ops.includes("closePath"), "filled morph path emits closePath for Z");

  // _clipBox is scoped to save/restore
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(10, 10);
  ctx.clip();
  assert.ok(ctx._clipBox, "clip records _clipBox");
  ctx.restore();
  assert.equal(ctx._clipBox, null, "restore clears inner _clipBox");

  // BlendModes.blendData mode 0/1 (normal) does not throw on this._cut
  const src = new Uint8ClampedArray([200, 100, 50, 128]);
  const dst = new Uint8ClampedArray([20, 40, 60, 255]);
  const out = new Uint8ClampedArray(4);
  core.BlendModes.blendData(src, dst, out, 1);
  assert.ok(out[3] > 0);
});

test("cxform.applyToImage LUT matches exact rounded channel transform across 0..255", () => {
  const {core} = loadCore({supportsReset: true});
  let lastPut = null;
  const proto = core.CanvasRenderingContext2D.prototype;
  proto.drawImage = () => {};
  proto.getImageData = () => {
    const data = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      data[i * 4] = i;
      data[i * 4 + 1] = 255 - i;
      data[i * 4 + 2] = (i * 7) & 255;
      data[i * 4 + 3] = i;
    }
    return {data, width: 256, height: 1};
  };
  proto.putImageData = im => { lastPut = im.data; };
  const cx = new core.cxform(15, -20, 5, -10, 180, 90, 256, 200);
  cx.applyToImage({width: 256, height: 1, _pooled: true});
  assert.ok(lastPut);
  const clamp = v => v <= 0 ? 0 : v > 255 ? 255 : v;
  for (let i = 0; i < 256; i++) {
    assert.equal(lastPut[i * 4], clamp(Math.round(i * 180 / 255 + 15)));
    assert.equal(lastPut[i * 4 + 1], clamp(Math.round((255 - i) * 90 / 255 - 20)));
    assert.equal(lastPut[i * 4 + 2], clamp(Math.round(((i * 7) & 255) * 256 / 255 + 5)));
    assert.equal(lastPut[i * 4 + 3], clamp(Math.round(i * 200 / 255 - 10)));
  }
});
