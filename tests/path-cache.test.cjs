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
