const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSource(context, file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context);
}

async function createApp() {
  let onload;
  const canvasEvents = {};
  const documentEvents = {};
  const canvas = {
    style: {},
    addEventListener(name, fn) { canvasEvents[name] = fn; },
    focus() {},
    setPointerCapture() {},
    getBoundingClientRect: () => ({left: 0, top: 0, width: 620, height: 360})
  };
  const window = {
    addEventListener(event, callback) { if (event === 'load') onload = callback; },
    GameAudio: class { constructor() { this.unlocked = true; this.muted = false; } effect() {} },
    ClipTimelines: class { constructor() { this.clips = new Map(); this.byId = new Map(); } requestPlay() {} },
    OriginalArtRenderer: class {}
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: () => canvas,
      addEventListener(name, fn) { documentEvents[name] = fn; }
    },
    localStorage: {getItem: () => null},
    HTMLImageElement: class {},
    performance: {now: () => 1000},
    requestAnimationFrame() {},
    console
  });
  loadSource(context, 'physics.js');
  loadSource(context, 'game.js');
  onload();
  await new Promise(resolve => setImmediate(resolve));
  const app = window.TurboPenguins;
  app.mode = 'playing';
  app.game = window.Physics.createInitialGame(1);
  return {app, Physics: window.Physics, canvasEvents, documentEvents};
}

const pointer = (x, y, extra = {}) => ({
  clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0,
  preventDefault() {}, ...extra
});

test('a pickup is collected on pointer down, before the cliff scrolls away', async () => {
  const {app, Physics, canvasEvents} = await createApp();
  const g = app.game;
  const n = 4;
  g.bgX = -7;
  g.bgY = n * 445 + 10;
  g.x = 400;
  g.y = 320;
  const b = {x: 200, y: 130, type: 1, collected: 0};
  g.tiles.set(n, {bonuses: [b]});
  const center = Physics.bonusStageCenter(g, n, b);
  canvasEvents.pointerdown(pointer(center.x, center.y));
  assert.ok(b.collected > 0);
  assert.equal(g.turbos, 1);
});

test('secondary mouse buttons do not bounce the penguin', async () => {
  const {app, canvasEvents} = await createApp();
  const g = app.game;
  g.x = 300;
  g.y = 200;
  canvasEvents.pointerdown(pointer(300, 200, {button: 2}));
  assert.equal(g.hit, false);
  canvasEvents.pointerdown(pointer(300, 200, {button: 0}));
  assert.equal(g.hit, true);
});

test('keys pressed with Ctrl, Meta or Alt are left to the browser', async () => {
  const {app, documentEvents} = await createApp();
  const key = (code, extra = {}) => ({code, repeat: false, preventDefault() { this.prevented = true; }, ...extra});
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
    app.game.turbos = 3;
    const e = key('Space', {[mod]: true});
    documentEvents.keydown(e);
    assert.equal(app.game.turbos, 3, mod);
    assert.ok(!e.prevented, mod);
  }
  documentEvents.keydown(key('Space'));
  assert.equal(app.game.turbos, 0);
});
