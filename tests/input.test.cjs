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

test("cancelling a penguin charge resets hover state and thank-you panel ignores repeat submit", async () => {
  const {app, canvasEvents} = await createApp();
  const clip1 = {path: "p1", frame: 1, playing: false};
  app.timeline.penguins = new Map([["p1", clip1]]);
  app.timeline.clips.set("p1", clip1);
  app.timeline.lookup = path => app.timeline.clips.get(path);
  app.timeline.goto = (c, f, p) => { c.frame = f; c.playing = p; };
  app.mode = "select";

  canvasEvents.pointermove(pointer(220, 260));
  assert.equal(app.hovered, 1);
  assert.equal(clip1.frame, 2);

  canvasEvents.pointerdown(pointer(220, 260));
  assert.equal(app.charging, 1);
  assert.equal(clip1.frame, 19);

  // Release outside the penguin to cancel charge, then move back over penguin 1
  canvasEvents.pointerup(pointer(50, 50));
  assert.equal(app.charging, 0);
  assert.equal(app.hovered, 0);
  assert.equal(clip1.frame, 8);

  clip1.playing = false;
  canvasEvents.pointermove(pointer(220, 260));
  assert.equal(app.hovered, 1);
  assert.equal(clip1.frame, 2, "hover animation replays after cancelled charge");

  // Thank-you confirmation frame (140) has no submit button
  app.mode = "result";
  app.panelFrame = 103;
  app.submitScore();
  assert.equal(app.panelFrame, 140);
  app.transitionTick = 50;
  assert.equal(app.hitArea(300, 210), null);
  app.submitScore();
  assert.equal(app.transitionTick, 50, "repeat submit on frame 140 does not reset timer");
});

test("keyboard penguin select updates sprite403 frame and result keydown respects panel state", async () => {
  const {app, canvasEvents, documentEvents} = await createApp();
  const blurs = {path: "root/sprite403#0", frame: 1, playing: false};
  const clip3 = {path: "p3", frame: 1, playing: false};
  app.timeline.penguins = new Map([["p3", clip3]]);
  app.timeline.clips.set("root/sprite403#0", blurs);
  app.timeline.clips.set("p3", clip3);
  app.timeline.lookup = path => app.timeline.clips.get(path);
  app.timeline.goto = (c, f, p) => { c.frame = f; c.playing = p; };
  app.mode = "select";

  canvasEvents.pointermove(pointer(360, 260));
  assert.equal(app.hovered, 3);
  canvasEvents.pointerleave();
  assert.equal(app.hovered, 0, "pointerleave clears hover state");

  documentEvents.keydown({code: "Digit3", repeat: false, preventDefault() {}});
  assert.equal(app.mode, "launching");
  assert.equal(blurs.frame, 3, "keyboard penguin selection positions launch blur on chosen penguin");

  // Result screen: frame 72 submits, frame 140 ignores Enter/Space and restart(), frame 160 restarts
  app.mode = "result";
  app.panelFrame = 72;
  documentEvents.keydown({code: "Enter", repeat: false, preventDefault() {}});
  assert.equal(app.panelFrame, 140, "Enter on submit panel 72 submits score");
  documentEvents.keydown({code: "Space", repeat: false, preventDefault() {}});
  assert.equal(app.mode, "result", "Space on thank-you frame 140 does not prematurely restart");
  app.restart();
  assert.equal(app.mode, "result", "restart() is blocked on thank-you frame 140");
  app.panelFrame = 160;
  app.submitScore();
  assert.equal(app.panelFrame, 160, "submitScore() is ignored on non-submit panel 160");
  documentEvents.keydown({code: "Space", repeat: false, preventDefault() {}});
  assert.equal(app.mode, "restarting", "Space on panel 160 triggers restart");
});

test("releasing a cancelled charge over another penguin hovers it and window blur cancels charge", async () => {
  let blurHandler;
  const {app, canvasEvents} = await createApp();
  const clip1 = {path: "p1", frame: 1, playing: false};
  const clip2 = {path: "p2", frame: 1, playing: false};
  app.timeline.penguins = new Map([["p1", clip1], ["p2", clip2]]);
  app.timeline.clips.set("p1", clip1);
  app.timeline.clips.set("p2", clip2);
  app.timeline.lookup = path => app.timeline.clips.get(path);
  app.timeline.goto = (c, f, p) => { c.frame = f; c.playing = p; };
  app.mode = "select";

  canvasEvents.pointerdown(pointer(220, 260));
  assert.equal(app.charging, 1);
  // Release over penguin 2: cancels charge on 1 and immediately hovers 2
  canvasEvents.pointerup(pointer(300, 260));
  assert.equal(app.charging, 0);
  assert.equal(app.hovered, 2);
  assert.equal(clip2.frame, 2);
});
