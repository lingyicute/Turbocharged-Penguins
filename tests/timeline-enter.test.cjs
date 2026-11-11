const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function timeline() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src/timeline.js'), 'utf8'), {window});
  return new window.ClipTimelines({rootFrame: 1, audio: null});
}

test('sibling ordinals restart for every visit of a parent clip', () => {
  const t = timeline();
  t.begin();
  const a0 = t.enter('sprite10');
  const x0 = t.enter('sprite20'); t.leave();
  const x1 = t.enter('sprite20'); t.leave();
  t.leave();
  const a1 = t.enter('sprite10');
  const y0 = t.enter('sprite20'); t.leave();
  t.leave();
  t.end();
  assert.deepEqual([a0.path, x0.path, x1.path, a1.path, y0.path], [
    'root/sprite10#0', 'root/sprite10#0/sprite20#0', 'root/sprite10#0/sprite20#1',
    'root/sprite10#1', 'root/sprite10#1/sprite20#0'
  ]);
});

test('clips and their paths are stable across renders, and unseen clips are dropped', () => {
  const t = timeline();
  const render = names => {
    t.begin();
    const clips = names.map(name => { const clip = t.enter(name); t.leave(); return clip; });
    t.end();
    return clips;
  };
  const [first, second] = render(['sprite1', 'sprite2']);
  const [again] = render(['sprite1']);
  assert.equal(again, first, 'the same placement resolves to the same clip');
  assert.equal(t.clips.get('root/sprite1#0'), first);
  assert.equal(t.clips.has(second.path), false);
  const [revived] = render(['sprite2']);
  assert.notEqual(revived, second, 'a dropped clip starts over');
  assert.equal(revived.frame, 1);
});

test('custom ids and floe penguin identities keep their paths', () => {
  const t = timeline();
  t.begin();
  t.enter('sprite379');
  const paths = [];
  for (let i = 0; i < 3; i++) { paths.push(t.enter('sprite378').path); t.leave(); }
  paths.push(t.enter('sprite509', 't3_0').path); t.leave();
  paths.push(t.enter('sprite509', 't3_0').path); t.leave();
  t.leave();
  t.end();
  assert.deepEqual(paths, [
    'root/sprite379#0/sprite378#p3', 'root/sprite379#0/sprite378#p2', 'root/sprite379#0/sprite378#p1',
    'root/sprite379#0/sprite509#t3_0', 'root/sprite379#0/sprite509#t3_0'
  ]);
  assert.equal(t.penguins.get('p3').path, paths[0]);
});

test('ids are parsed from sprite names and clip lengths come from the export', () => {
  const window = {sprite7: function () { const frame_cnt = 12; return frame_cnt; }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src/timeline.js'), 'utf8'), {window});
  const t = new window.ClipTimelines({rootFrame: 1, audio: null});
  t.begin();
  const clip = t.enter('sprite7');
  const other = t.enter('button3');
  t.end();
  assert.equal(clip.id, 7);
  assert.equal(clip.length, 12);
  assert.equal(other.id, 0);
  assert.equal(other.length, 1);
});

test('string-identity path cache stays bounded while paths stay correct', () => {
  const t = timeline();
  const paths = [];
  for (let i = 0; i < 2000; i++) {
    t.begin();
    paths.push(t.enter('sprite509', `t${i}_0`).path);
    t.leave();
    t.end();
  }
  assert.equal(paths[0], 'root/sprite509#t0_0');
  assert.equal(paths[1999], 'root/sprite509#t1999_0');
  const slot = t.rootClip.kids.get('sprite509');
  assert.ok(slot.strPaths.size <= 512, `cache grew to ${slot.strPaths.size}`);
});
