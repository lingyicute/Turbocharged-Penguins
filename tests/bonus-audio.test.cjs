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
    ClipTimelines: class {},
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

// An effect preload also calls fetch(), so isolate sound 1 in each test.
const isMusic = url => url === 'assets/audio/1.mp3';

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
  audio.unlock();
  await nextTick();
  assert.equal(plays, 1);
  assert.equal(audio.musicStarted, true);
});
