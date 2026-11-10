const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'canvas-core.js'), 'utf8');

function loadCore() {
  class MockContext {}
  const gameCanvas = {width: 620, height: 360, isConnected: true};
  const document = {
    getElementById(id) { return id === 'game' ? gameCanvas : null; },
    createElement() { return {width: 0, height: 0, getContext() { return new MockContext(); }}; }
  };
  const context = vm.createContext({CanvasRenderingContext2D: MockContext, document});
  vm.runInContext(coreSource, context, {filename: 'assets/canvas-core.js'});
  return context;
}

const uniquePath = i => 'M ' + i + ' 0 L ' + i + ' 10 ' + (i + 1) + ' 10 Z';

test('parsePathString turns M/L/Q/Z tokens into flat ops', () => {
  const core = loadCore();
  const parsed = core.parsePathString('M 1 2 L 3 4 5 6 Q 7 8 9 10 Z');
  assert.deepEqual([...parsed.ops], [2, 1, 2, 1, 3, 4, 1, 5, 6, 3, 7, 8, 9, 10, 0]);
  assert.equal(parsed.rawCoords, parsed.ops);
});

test('a repeated path string returns the same cached object', () => {
  const core = loadCore();
  assert.equal(core.parsePathString(uniquePath(1)), core.parsePathString(uniquePath(1)));
});

test('the parsed path cache stays bounded under per-frame unique keys', () => {
  const core = loadCore();
  const limit = core.PARSED_PATH_CACHE_LIMIT;
  for (let i = 0; i < limit * 5; i++) core.parsePathString(uniquePath(i));
  assert.ok(core._parsedPathCache.size <= limit);
  assert.ok(core._parsedPathCachePrev.size <= limit);
});

test('entries that keep being hit survive generation rollovers', () => {
  const core = loadCore();
  const limit = core.PARSED_PATH_CACHE_LIMIT;
  const hotKey = uniquePath(-1);
  const hot = core.parsePathString(hotKey);
  for (let i = 0; i < limit * 4; i++) {
    core.parsePathString(uniquePath(i));
    if (i % 512 === 0) assert.equal(core.parsePathString(hotKey), hot);
  }
  assert.equal(core.parsePathString(hotKey), hot);
});

test('entries that are never hit again are eventually dropped', () => {
  const core = loadCore();
  const limit = core.PARSED_PATH_CACHE_LIMIT;
  const coldKey = uniquePath(-1);
  const cold = core.parsePathString(coldKey);
  for (let i = 0; i < limit * 3; i++) core.parsePathString(uniquePath(i));
  const reparsed = core.parsePathString(coldKey);
  assert.notEqual(reparsed, cold);
  assert.deepEqual([...reparsed.ops], [...cold.ops]);
});

test('parsePathString skips empty tokens and precomputes path bounds', () => {
  const core = loadCore();
  const parsed = core.parsePathString('M  10 -5  L 30 25  Q 40 35 20 15  Z ');
  assert.deepEqual([...parsed.ops], [2, 10, -5, 1, 30, 25, 3, 40, 35, 20, 15, 0]);
  assert.deepEqual({...parsed.box}, {minX: 10, minY: -5, maxX: 40, maxY: 35, n: 4});
});

function loadDrawCore() {
  const ops = [];
  let path2dBuilt = 0;
  class Path2D {
    constructor() { path2dBuilt++; this.cmds = []; }
    moveTo(x, y) { this.cmds.push(['M', x, y]); }
    lineTo(x, y) { this.cmds.push(['L', x, y]); }
    quadraticCurveTo(a, b, c, d) { this.cmds.push(['Q', a, b, c, d]); }
    closePath() { this.cmds.push(['Z']); }
  }
  class MockContext {
    save() {} restore() {} transform() {} setTransform() {} resetTransform() {}
    fillRect() {}
    beginPath() { ops.push('beginPath'); }
    moveTo() { ops.push('moveTo'); }
    lineTo() { ops.push('lineTo'); }
    quadraticCurveTo() { ops.push('quad'); }
    closePath() { ops.push('closePath'); }
    fill(...args) { ops.push(['fill', ...args]); }
    stroke(...args) { ops.push(['stroke', ...args]); }
    clip(...args) { ops.push(['clip', ...args]); }
    createPattern() { return {}; }
  }
  const gameCanvas = {width: 620, height: 360, isConnected: true};
  const document = {
    getElementById(id) { return id === 'game' ? gameCanvas : null; },
    createElement() { return {width: 0, height: 0, getContext() { return new MockContext(); }}; }
  };
  const core = vm.createContext({CanvasRenderingContext2D: MockContext, Path2D, document});
  vm.runInContext(coreSource, core, {filename: 'assets/canvas-core.js'});
  return {core, ops, Path2D, MockContext, built: () => path2dBuilt};
}

test('drawPath caches Path2D for fills and clips while preserving _pathBox and _clipBox', () => {
  const {core, ops, Path2D, MockContext, built} = loadDrawCore();
  const ctx = core.enhanceContext(new MockContext());

  core.drawPath(ctx, 'M 1 2 L 5 8 Z', false);
  ctx.fill('evenodd');
  core.drawPath(ctx, 'M 1 2 L 5 8 Z', false);
  ctx.clip();
  assert.equal(built(), 1, 'Path2D is built once per cached path');
  assert.equal(ops.length, 2);
  assert.ok(ops[0][1] instanceof Path2D && ops[0][2] === 'evenodd');
  assert.ok(ops[1][1] instanceof Path2D);
  assert.deepEqual({...ctx._clipBox, m: undefined}, {minX: 1, minY: 2, maxX: 5, maxY: 8, m: undefined});

  // _floeMaskPathOnly falls back to building the current path directly on ctx
  ops.length = 0;
  ctx._floeMaskPathOnly = true;
  core.drawPath(ctx, 'M 1 2 L 5 8 Z', false);
  ctx._floeMaskPathOnly = false;
  ctx.clip('evenodd');
  assert.deepEqual(ops, ['beginPath', 'moveTo', 'lineTo', 'closePath', ['clip', 'evenodd']]);
});

test('an explicit Path2D argument or a later path-building call overrides the deferred path', () => {
  const {core, ops, Path2D, MockContext} = loadDrawCore();
  const ctx = core.enhanceContext(new MockContext());
  const mine = new Path2D();

  core.drawPath(ctx, 'M 1 2 L 5 8 Z', false);
  ctx.fill(mine, 'evenodd');
  ctx.stroke(mine);
  ctx.clip(mine);
  assert.equal(ops[0][1], mine);
  assert.equal(ops[0][2], 'evenodd');
  assert.equal(ops[1][1], mine);
  assert.equal(ops[2][1], mine);

  // Any explicit path-building call drops the deferred path, so a context that
  // starts a new path is never filled with a stale one.
  ops.length = 0;
  core.drawPath(ctx, 'M 1 2 L 5 8 Z', false);
  ctx.beginPath();
  ctx.lineTo(3, 3);
  ctx.fill();
  assert.deepEqual(ops, ['beginPath', 'lineTo', ['fill']]);
});

test('stroked paths are built on the context and leave no deferred path behind', () => {
  const {core, ops, MockContext} = loadDrawCore();
  const ctx = core.enhanceContext(new MockContext());
  ctx._matrix = [2, 0, 0, 2, 10, 10];

  core.drawPath(ctx, 'M 1 2 L 5 8', true, 'NORMAL');
  assert.equal(ctx._cachedPath, null);
  assert.deepEqual(ops, ['beginPath', 'moveTo', 'lineTo', ['stroke']]);
});
