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
