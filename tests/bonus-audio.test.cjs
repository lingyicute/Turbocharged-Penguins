const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSource(context, file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8'), context);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

const nextTick = () => new Promise(resolve => setImmediate(resolve));

async function createApp() {
  let onload;
  const canvas = {style: {}, addEventListener() {}};
  const status = {textContent: ''};
  const window = {
    addEventListener(event, callback) { if (event === 'load') onload = callback; },
    GameAudio: class { constructor() { this.unlocked = true; this.muted = false; } effect() {} },
    ClipTimelines: class { constructor() { this.clips = new Map(); } },
    OriginalArtRenderer: class {}
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: id => id === 'game' ? canvas : status,
      addEventListener() {}
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
  await nextTick();
  return {app: window.TurboPenguins, Physics: window.Physics};
}

test('timeline advances existing clips and queues newly requested children', () => {
  const window = {FRAME_SOUNDS: {}};
  const context = vm.createContext({window});
  loadSource(context, 'timeline.js');
  const app = {mode: 'playing', game: {x: 12, y: 34}, audio: {effect() {}}};
  const timeline = new window.ClipTimelines(app);
  const penguin = {
    path: 'root/sprite568#0/sprite565#0', parentPath: 'root/sprite568#0',
    parentId: 568, id: 565, frame: 200, length: 219, playing: true, soundedFrame: 0
  };
  timeline.clips.set(penguin.path, penguin);

  timeline.advance();
  assert.equal(penguin.frame, 201);
  assert.equal(app.game.explX, 12);
  assert.equal(app.game.explY, 34);
  assert.equal(timeline.clips.size, 1, 'frame scripts do not insert into the iterated clip map');
  assert.equal(timeline.pending.length, 1, 'missing child clips are queued for rendering');
});

test('stroked paths emit closePath for Z subpaths, like the fill paths', () => {
  const context = vm.createContext({window: {}, console});
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'assets', 'canvas-core.js'), 'utf8'),
    context);
  const record = () => {
    const ops = [];
    const ctx = {
      _matrix: [1, 0, 0, 1, 0, 0],
      lineWidth: 1,
      save() {}, restore() {},
      setTransform(a, b, c, d, e, f) { this._matrix = [a, b, c, d, e, f]; },
      beginPath() {},
      moveTo() { ops.push('moveTo'); },
      lineTo() { ops.push('lineTo'); },
      quadraticCurveTo() { ops.push('quadraticCurveTo'); },
      closePath() { ops.push('closePath'); },
      stroke() { ops.push('stroke'); }
    };
    return {ops, ctx};
  };
  const stroked = record();
  context.drawPath(stroked.ctx, 'M 0 0 L 10 0 10 10 Z', true, 'NONE');
  assert.ok(stroked.ops.includes('closePath'), 'stroke branch closes Z subpaths');
  assert.equal(stroked.ops.indexOf('closePath'), stroked.ops.indexOf('stroke') - 1,
    'closePath lands right before the stroke');
  const filled = record();
  context.drawPath(filled.ctx, 'M 0 0 L 10 0 10 10 Z', false);
  assert.ok(filled.ops.includes('closePath'), 'fill branch still closes Z subpaths');
});

test('visual state comparison reuses buffers and detects gameplay, clip, and fade changes', async () => {
  const {app, Physics} = await createApp();
  const buffers = new Set(app.visualParts);

  assert.equal(app.visualStateChanged(), true, 'initial state needs a paint');
  assert.equal(app.visualStateChanged(), false, 'unchanged state is skipped');
  assert.equal(new Set(app.visualParts).size, 2, 'only two reusable snapshots are used');
  for (const buffer of buffers) assert.ok(app.visualParts.includes(buffer));

  const g = app.game = Physics.createInitialGame(1);
  assert.equal(app.visualStateChanged(), true, 'entering gameplay changes the view');
  assert.equal(app.visualStateChanged(), false);
  g.x++;
  assert.equal(app.visualStateChanged(), true, 'camera/gameplay movement changes the view');

  const clip = {id: 900, frame: 1, playing: true};
  app.timeline.clips.set('root/sprite900#0', clip);
  assert.equal(app.visualStateChanged(), true, 'new timeline clips change the view');
  assert.equal(app.visualStateChanged(), false, 'unchanged clip state is skipped');
  assert.equal(app.visualStateChanged(true), false, 'fast check also skips unchanged state with clips');
  clip.frame++;
  assert.equal(app.visualStateChanged(), true, 'clip frames are tracked');

  g.tiles.set(1, {bonuses: [{x: 100, collected: app.now - 100}]});
  assert.equal(app.visualStateChanged(), true, 'a fading pickup changes the view');
  app.now++;
  assert.equal(app.visualStateChanged(), true, 'pickup alpha is tracked over time');
});

test('clicking and flying through the visible center of each bonus collects it', async () => {
  const {app, Physics} = await createApp();
  app.mode = 'playing';
  const g = app.game = Physics.createInitialGame(1);
  const n = 4;
  g.bgX = -7;
  g.bgY = n * 445 + 10;
  for (let type = 1; type <= 5; type++) {
    const b = {x: 200, y: 130, type, collected: 0};
    g.tiles.clear();
    g.tiles.set(n, {bonuses: [b]});
    g.x = 400;
    g.y = 320;
    const center = Physics.bonusStageCenter(g, n, b);
    assert.ok(Math.abs(center.x - (g.bgX + b.x + 33.1)) < 1e-9);
    assert.ok(Math.abs(center.y - (g.bgY - n * 445 + b.y + 33.1)) < 1e-9);
    assert.equal(app.hitArea(center.x, center.y), b, `type ${type} click`);

    const origin = {x: g.bgX + b.x, y: g.bgY - n * 445 + b.y};
    assert.notEqual(app.hitArea(origin.x, origin.y), b, `type ${type} old hitbox`);
    g.x = origin.x;
    g.y = origin.y;
    Physics.hitTests(g, null);
    assert.equal(b.collected, 0, `type ${type} should not collect outside the icon`);
    g.x = center.x;
    g.y = center.y;
    Physics.hitTests(g, null);
    assert.ok(b.collected > 0, `type ${type} physical pickup`);
  }
});

function createAudio(fetchSound, playMusic, decodeSound = () => Promise.resolve({})) {
  let plays = 0;
  let bedStarts = 0;
  class FakeAudio {
    constructor(url) { this.src = url; this.volume = 0; }
    play() { return playMusic(++plays); }
  }
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    decodeAudioData(buf) { return decodeSound(buf); }
    createBufferSource() {
      return {connect(node) { return node; }, start() { bedStarts++; }};
    }
    createGain() { return {gain: {value: 0}, connect(node) { return node; }}; }
  }
  const window = {AudioContext: FakeAudioContext};
  const context = vm.createContext({window, Audio: FakeAudio, fetch: fetchSound});
  loadSource(context, 'audio.js');
  return {GameAudio: window.GameAudio, plays: () => plays, bedStarts: () => bedStarts};
}

// Keep music and one-shot effect request assertions independent.
const isMusic = url => url === 'assets/audio/1.mp3';

test('one-shot buffers load on demand while the first cue uses the immediate fallback', async () => {
  const first = deferred();
  let musicRequests = 0;
  let effectRequests = 0;
  const {GameAudio, plays, bedStarts} = createAudio(url => {
    if (isMusic(url)) {
      musicRequests++;
      return Promise.reject(new Error('music should not load yet'));
    }
    effectRequests++;
    return first.promise;
  }, () => Promise.resolve());
  const audio = new GameAudio();

  assert.equal(musicRequests, 0, 'constructing the manager does not fetch music');
  assert.equal(effectRequests, 0, 'constructing the manager performs no effect fetches');
  audio.effect(87);
  assert.equal(effectRequests, 1);
  assert.equal(plays(), 1, 'the first cue starts without waiting for decode');
  audio.effect(87);
  assert.equal(effectRequests, 1, 'concurrent cues share the in-flight decode');
  assert.equal(plays(), 2);

  first.resolve({arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))});
  await nextTick();
  assert.ok(audio.buffers.has(87));
  audio.effect(87);
  assert.equal(bedStarts(), 1, 'later cues use the decoded Web Audio buffer');
  assert.equal(plays(), 2);
});

test('unlocking warms the one-shot buffers before the first in-game cue', async () => {
  const first = deferred();
  const requested = [];
  // A 100-sample buffer: short enough that skipSeek() returns it untouched
  // (its skip offset exceeds the length), so the fake context needs no
  // createBuffer.
  const decode = () => Promise.resolve({sampleRate: 22050, length: 100, numberOfChannels: 1});
  const {GameAudio} = createAudio(url => {
    requested.push(url);
    if (isMusic(url)) return Promise.reject(new Error('music not under test'));
    return first.promise;
  }, () => Promise.resolve(), decode);
  const audio = new GameAudio();
  assert.equal(requested.length, 0, 'construction still performs no fetches');
  audio.unlock();
  const ids = [3, 4, 6, 87, 94, 95, 96, 164, 299, 300, 308, 315, 373, 374, 375, 377, 381, 401, 417];
  const urlOf = id => id === 315 ? 'assets/audio/315.wav' : `assets/audio/${id}.mp3`;
  for (const id of ids) {
    assert.ok(requested.includes(urlOf(id)), `effect ${id} is warmed on unlock`);
  }
  first.resolve({arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))});
  await nextTick();
  for (const id of ids) {
    assert.ok(audio.buffers.has(id), `effect ${id} is decoded after unlock`);
  }
});

test('steady music volume avoids redundant AudioParam writes', () => {
  const {GameAudio} = createAudio(() => Promise.reject(new Error('not used')), () => Promise.resolve());
  const audio = new GameAudio();
  let writes = 0;
  audio.bedGain = {gain: {setValueAtTime() { writes++; }}};
  audio.fade = 1;
  audio.unlocked = true;
  audio.musicStarted = true;

  audio.update(0, true);
  audio.update(0, true);
  assert.equal(writes, 1, 'unchanged volume is submitted once');
  audio.toggle();
  assert.equal(writes, 2, 'mute still updates the gain immediately');
  audio.update(0, true);
  assert.equal(writes, 2, 'muted steady state is also deduplicated');
  audio.toggle();
  assert.equal(writes, 3, 'unmute restores the current fade volume');
});

test('successful Web Audio loading starts one bed and clears the pending state', async () => {
  const first = deferred();
  const {GameAudio, plays, bedStarts} = createAudio(url =>
    isMusic(url) ? first.promise : Promise.reject(new Error('effect unavailable')),
  () => Promise.resolve());
  const audio = new GameAudio();
  audio.seamlessLoops = () => ({});
  audio.seamlessLoop = () => ({});
  audio.unlock();
  first.resolve({arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))});
  await nextTick();
  assert.equal(bedStarts(), 1);
  assert.equal(plays(), 0);
  assert.equal(audio.bedPending, false);
  audio.unlock();
  assert.equal(bedStarts(), 1);
});

test('failed Web Audio load falls back to the media element', async () => {
  const first = deferred();
  let musicRequests = 0;
  const {GameAudio, plays} = createAudio(url => {
    if (isMusic(url)) { musicRequests++; return first.promise; }
    return Promise.reject(new Error('effect unavailable'));
  }, () => Promise.resolve());
  const audio = new GameAudio();
  audio.unlock();
  first.reject(new Error('music fetch failed'));
  await nextTick();
  assert.equal(musicRequests, 1);
  assert.equal(plays(), 1);
  assert.equal(audio.musicStarted, true);
  assert.equal(audio.bedPending, false);
  audio.unlock();
  assert.equal(plays(), 1, 'do not start duplicate background music');
});

test('after failed decoding and blocked fallback, the next unlock retries Web Audio', async () => {
  let musicRequests = 0;
  let decodes = 0;
  const {GameAudio, plays, bedStarts} = createAudio(url => {
    if (!isMusic(url)) return Promise.reject(new Error('effect unavailable'));
    musicRequests++;
    return Promise.resolve({arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))});
  }, () => Promise.reject(new Error('media playback blocked')),
  () => ++decodes === 1 ? Promise.reject(new Error('music decode failed')) : Promise.resolve({}));
  const audio = new GameAudio();
  audio.unlock();
  await nextTick();
  assert.equal(plays(), 1);
  assert.equal(audio.musicStarted, false);
  assert.equal(audio.bedPending, false);

  // Decoding/looping is not under test here: the second request succeeds.
  audio.seamlessLoops = () => ({});
  audio.seamlessLoop = () => ({});
  audio.unlock();
  await nextTick();
  assert.equal(musicRequests, 2);
  assert.equal(bedStarts(), 1);
  assert.ok(audio.bed);
  assert.equal(audio.musicStarted, true);
  assert.equal(audio.bedPending, false);
});

test('without Web Audio, unlocking starts the media element directly', async () => {
  let plays = 0;
  const window = {};
  class FakeAudio {
    play() { plays++; return Promise.resolve(); }
  }
  const context = vm.createContext({window, Audio: FakeAudio});
  loadSource(context, 'audio.js');
  const audio = new window.GameAudio();
  assert.ok(!audio.music.src, 'fallback music has no source until playback is needed');
  audio.unlock();
  await nextTick();
  assert.equal(audio.music.src, 'assets/audio/1.mp3');
  assert.equal(plays, 1);
  assert.equal(audio.musicStarted, true);
});

test('hiding the page suspends audio and showing it resumes the music', async () => {
  const log = [];
  const window = {};
  class FakeAudio {
    constructor() { this.paused = true; }
    play() { this.paused = false; log.push('music.play'); return Promise.resolve(); }
    pause() { this.paused = true; log.push('music.pause'); }
  }
  class FakeAudioContext {
    constructor() { this.state = 'running'; }
    suspend() { this.state = 'suspended'; log.push('ctx.suspend'); return Promise.resolve(); }
    resume() { this.state = 'running'; log.push('ctx.resume'); return Promise.resolve(); }
  }
  window.AudioContext = FakeAudioContext;
  const context = vm.createContext({window, Audio: FakeAudio});
  loadSource(context, 'audio.js');
  const audio = new window.GameAudio();
  audio.unlocked = true;
  audio.music.play();
  log.length = 0;

  audio.setHidden(true);
  await nextTick();
  assert.ok(log.includes('ctx.suspend') && log.includes('music.pause'));
  log.length = 0;
  audio.setHidden(false);
  await nextTick();
  assert.ok(log.includes('ctx.resume') && log.includes('music.play'));
  log.length = 0;
  audio.setHidden(false);
  assert.deepEqual(log, [], 'showing an already visible page does nothing');
});

test("decoding finishing while hidden does not resume the context or lose sting time", async () => {
  const first = deferred();
  let resumed = 0;
  let now = 1000;
  class FakeAudio {
    constructor() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class FakeAudioContext {
    constructor() { this.state = "running"; this.destination = {}; this.currentTime = 0; }
    suspend() { this.state = "suspended"; return Promise.resolve(); }
    resume() { this.state = "running"; resumed++; return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() { return {connect: n => n, start() {}, stop() {}}; }
    createGain() { return {gain: {value: 0, setValueAtTime() {}}, connect: n => n}; }
  }
  const window = {AudioContext: FakeAudioContext};
  const context = vm.createContext({
    window,
    Audio: FakeAudio,
    fetch: url => isMusic(url) ? first.promise : Promise.reject(new Error("unused")),
    performance: {now: () => now}
  });
  loadSource(context, "audio.js");
  const audio = new window.GameAudio();
  audio.seamlessLoops = () => ({});
  audio.seamlessLoop = () => ({});
  audio.unlock();
  audio.playIntroSting();
  audio.setHidden(true);
  resumed = 0;
  first.resolve({arrayBuffer: () => Promise.resolve(new ArrayBuffer(1))});
  await nextTick();
  assert.equal(resumed, 0, "context stays suspended while hidden");
  assert.equal(audio.audioContext.state, "suspended");
  now = 11000;
  audio.setHidden(false);
  assert.equal(resumed, 1, "context resumes when visible again");
  audio.applyStingEnvelope();
  assert.ok(audio.sting, "sting is not killed by time elapsed while hidden");
});

test("timeline.end cleans up unseen clips from byId and penguins maps", () => {
  const window = {FRAME_SOUNDS: {}, sprite378: function() { var frame_cnt = 26; }, sprite379: function() { var frame_cnt = 38; }};
  const context = vm.createContext({window});
  loadSource(context, "timeline.js");
  const timeline = new window.ClipTimelines({rootFrame: 55});
  timeline.begin();
  timeline.enter("sprite379");
  const p1 = timeline.enter("sprite378");
  timeline.leave();
  timeline.leave();
  timeline.end();
  assert.equal(timeline.byId.get(378), p1);
  assert.equal(timeline.penguins.get("p3"), p1);

  // Next render does not visit sprite379/sprite378
  timeline.begin();
  timeline.end();
  assert.equal(timeline.byId.has(378), false);
  assert.equal(timeline.penguins.size, 0);
});

test("sprite478 shifts only the frame-1 bubble icon and sprite418 applies launchDx during launching", () => {
  const calls = [];
  const canvas = {width: 620, height: 360, getBoundingClientRect: () => ({width: 620, height: 360}), getContext: () => ({})};
  const window = {
    place(name, c, ctx, mat, ct, bl, fr) { calls.push({name, tx: mat[4], ty: mat[5], fr}); },
    addEventListener() {}
  };
  const context = vm.createContext({
    window,
    document: {getElementById: () => canvas}
  });
  loadSource(context, "timeline.js");
  loadSource(context, "renderer.js");
  const app = {rootFrame: 58, mode: "launching", game: null, launchDx: 120, audio: {muted: false}};
  app.timeline = new window.ClipTimelines(app);
  const renderer = new window.OriginalArtRenderer(app);

  app.timeline.begin();
  window.place("sprite418", canvas, {}, [0.05, 0, 0, 0.05, 221.35, 262.95], {}, 1, 0, 0, 0);
  window.place("sprite478", canvas, {}, [1, 0, 0, 1, 0, 0], {}, 1, 0, 0, 0);
  app.timeline.end();

  assert.equal(calls[0].name, "sprite418");
  assert.equal(calls[0].tx, 341.35, "launch effect is shifted by launchDx on rootFrame 58");
  assert.equal(calls[1].name, "sprite488");
  assert.equal(calls[1].tx, 662, "frame-1 bubble icon is shifted by +662 into bonus center");

  calls.length = 0;
  const clip478 = app.timeline.lookup("root/sprite478#0");
  clip478.frame = 2;
  app.timeline.begin();
  window.place("sprite478", canvas, {}, [1, 0, 0, 1, 0, 0], {}, 1, 0, 0, 0);
  app.timeline.end();
  assert.equal(calls[0].name, "sprite478");
  assert.equal(calls[0].tx, 0, "burst frames use unshifted sprite478 coordinates");
  assert.equal(calls[0].fr, 1);
});

test("bonus timelines stay isolated per tile pickup and start burst when collected before first render", () => {
  const canvas = {width: 620, height: 360, getBoundingClientRect: () => ({width: 620, height: 360}), getContext: () => ({save() {}, restore() {}, globalAlpha: 1})};
  const window = {
    sprite478: function() { var frame_cnt = 13; },
    sprite488: function() { var frame_cnt = 13; },
    sprite509(ctx, ctrans, frame) {
      window.place("sprite478", canvas, ctx, [1, 0, 0, 1, 0, 0], ctrans, 1, 0, 0, 0);
    },
    sprite537() {},
    place(name, c, ctx, mat, ct, bl, fr) {
      if (window[name]) window[name](ctx, ct, fr, 0, 0);
    },
    addEventListener() {}
  };
  const context = vm.createContext({window, document: {getElementById: () => canvas}});
  loadSource(context, "timeline.js");
  loadSource(context, "renderer.js");
  const b0 = {x: 100, y: 100, type: 1, collected: 1000};
  const b1 = {x: 200, y: 200, type: 1, collected: 0};
  const app = {
    rootFrame: 115, mode: "playing", now: 1100, storedBest: 0, audio: {muted: false},
    game: {bgX: 0, bgY: 4 * 445, vy: -10, tiles: new Map([[4, {bonuses: [b0, b1]}]])}
  };
  app.timeline = new window.ClipTimelines(app);
  const renderer = new window.OriginalArtRenderer(app);

  // Render 1: b0 was collected before its first render; its clip should start playing
  app.timeline.begin();
  app.timeline.enter("sprite538");
  renderer.drawTiles(canvas, canvas.getContext("2d"), {}, 1);
  app.timeline.leave();
  app.timeline.end();

  const clip0 = app.timeline.lookup(b0.visualPath);
  const clip1 = app.timeline.lookup(b1.visualPath);
  assert.notEqual(b0.visualPath, b1.visualPath);
  assert.equal(clip0.playing, true, "pre-collected bonus starts burst animation on first render");
  assert.equal(clip1.playing, false, "uncollected bonus stays held on icon frame 1");

  // Simulate b0 finishing its burst (frame 13) and then fading out (>560ms)
  clip0.frame = 13;
  clip0.playing = false;
  app.now = 1700;
  app.timeline.begin();
  app.timeline.enter("sprite538");
  renderer.drawTiles(canvas, canvas.getContext("2d"), {}, 1);
  app.timeline.leave();
  app.timeline.end();

  const clip1After = app.timeline.lookup(b1.visualPath);
  assert.equal(clip1After.frame, 1, "remaining uncollected bonus does not inherit faded sibling frame 13");
});

test("delay frames stop parents across multi-step advance and end() clears unmatched pending cues", () => {
  const window = {FRAME_SOUNDS: {}, sprite312: function() { var frame_cnt = 66; }};
  const context = vm.createContext({window});
  loadSource(context, "timeline.js");
  const timeline = new window.ClipTimelines({rootFrame: 50, audio: {effect() {}}});
  timeline.begin();
  const clip = timeline.enter("sprite312");
  timeline.leave();
  timeline.end();

  clip.frame = 31;
  clip.playing = true;
  // Two consecutive advance() calls before render() must not skip frame 32 (a DELAYS frame)
  timeline.advance();
  timeline.advance();
  assert.equal(clip.frame, 32, "delay frame 32 stops clip immediately without waiting for render()");
  assert.equal(clip.playing, false);

  // Unmatched pending cues for absent children are cleared at timeline.end()
  timeline.requestPlay("root/sprite568#0/sprite565#0/sprite294#0", 2, true);
  assert.equal(timeline.pending.length, 1);
  timeline.begin();
  timeline.end();
  assert.equal(timeline.pending.length, 0, "unmatched pending cues are cleared after render pass");
});

test("panel frame sounds fire on stepped frames and pending goto skips frame-1 sound", async () => {
  const {app, Physics} = await createApp();
  const played = [];
  app.audio.effect = id => played.push(id);
  const window = {
    FRAME_SOUNDS: {257: {45: [96], 56: [164]}, 376: {1: [3], 3: [374]}},
    sprite257: function() { var frame_cnt = 306; },
    sprite376: function() { var frame_cnt = 4; }
  };
  const context = require("node:vm").createContext({window});
  loadSource(context, "timeline.js");
  app.timeline = new window.ClipTimelines(app);
  app.timeline.begin();
  const panel = app.timeline.enter("sprite257");
  app.timeline.leave();
  app.timeline.end();

  app.mode = "menuIn";
  app.panelFrame = 44;
  app.advanceFrame();
  assert.equal(panel.frame, 45);
  assert.deepEqual(played, [96], "menuIn panel advance triggers sprite257 frame 45 cue");

  played.length = 0;
  app.timeline.requestPlay("root/sprite376#0", 3, false);
  app.timeline.begin();
  const c376 = app.timeline.enter("sprite376");
  app.timeline.leave();
  app.timeline.end();
  assert.equal(c376.frame, 3);
  assert.deepEqual(played, [374], "pending goto on new clip does not fire frame 1 before jumping");

  // Mid-flight bonus pickup uses app.now timestamp
  app.mode = "playing";
  app.now = 4321;
  const g = app.game = Physics.createInitialGame(1);
  const b = {x: 200, y: 130, type: 1, collected: 0};
  g.bgX = 0;
  g.bgY = 4 * 445;
  g.tiles.set(4, {bonuses: [b]});
  const center = Physics.bonusStageCenter(g, 4, b);
  g.x = center.x;
  g.y = center.y;
  Physics.hitTests(g, app.audio, app.now);
  assert.equal(b.collected, 4321, "flight pickup records caller timestamp");
});

test("pending frame-less requestPlay survives frame-1 stops and syncs stack parentFrame", () => {
  const window = {
    FRAME_SOUNDS: {},
    sprite418: function() { var frame_cnt = 2; },
    sprite550: function() { var frame_cnt = 20; },
    sprite553: function() { var frame_cnt = 26; },
    sprite379: function() { var frame_cnt = 38; },
    sprite378: function() { var frame_cnt = 26; }
  };
  const context = vm.createContext({window});
  loadSource(context, "timeline.js");
  const app = {rootFrame: 55, mode: "playing", game: {turbos: 1, firstTurbo: true}, audio: {effect() {}}};
  const timeline = new window.ClipTimelines(app);

  // Queuing requestPlay with frame = null on a frame-1 stop clip (sprite418) keeps playing = true
  timeline.requestPlay("root/sprite418#0", null, true);
  timeline.begin();
  const c418 = timeline.enter("sprite418");
  timeline.leave();
  timeline.end();
  assert.equal(c418.frame, 1);
  assert.equal(c418.playing, true, "pending play() is not clobbered by frame-1 stop");

  // Entering sprite553 frame 2 with turbos >= 1 queues sprite550 flash
  timeline.begin();
  const c553 = timeline.enter("sprite553");
  timeline.leave();
  timeline.end();
  c553.playing = true;
  timeline.advance();
  assert.equal(c553.frame, 2);
  timeline.begin();
  timeline.enter("sprite553");
  const c550 = timeline.enter("sprite550");
  timeline.leave();
  timeline.leave();
  timeline.end();
  assert.equal(c550.playing, true, "sprite550 starts flashing when sprite553 enters frame 2");

  // goto() on active stack top updates parentFrame for children entered in the same pass
  timeline.begin();
  const c379 = timeline.enter("sprite379");
  timeline.goto(c379, 5, true);
  const child = timeline.enter("sprite378");
  timeline.leave();
  timeline.leave();
  timeline.end();
  assert.equal(child.parentFrame, 5, "child sees updated parentFrame after goto()");
});

test("hiding while fallback music.play() is pending pauses it and resumes later", async () => {
  const pending = deferred();
  const log = [];
  class FakeAudio {
    constructor() { this.paused = true; this.volume = 0; }
    play() { log.push("play"); return pending.promise.then(() => { this.paused = false; }); }
    pause() { log.push("pause"); this.paused = true; }
  }
  const window = {};
  const context = vm.createContext({window, Audio: FakeAudio});
  loadSource(context, "audio.js");
  const audio = new window.GameAudio();
  audio.unlocked = true;
  audio.ensureMusic();
  assert.equal(audio.music.paused, true, "play() has not settled yet");
  log.length = 0;
  audio.setHidden(true);
  assert.deepEqual(log, ["pause"]);
  audio.setHidden(false);
  assert.deepEqual(log, ["pause", "play"]);
});

test("web audio bed does not make hiding touch the idle media element", () => {
  const {GameAudio} = createAudio(() => Promise.reject(new Error("unused")), () => Promise.resolve());
  const audio = new GameAudio();
  audio.unlocked = true;
  audio.musicStarted = true;
  audio.audioContext = {state: "running", suspend: () => Promise.resolve(), resume: () => Promise.resolve()};
  let plays = 0;
  audio.music.paused = true;
  audio.music.play = () => { plays++; return Promise.resolve(); };
  audio.setHidden(true);
  audio.setHidden(false);
  assert.equal(plays, 0);
});
