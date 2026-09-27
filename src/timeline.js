/*
 * Timeline adapter.
 * The canvas export draws each sprite frame, but its (offset+time)%length
 * clock ignores stop/play/goto and child clocks. Every instance gets its own
 * playhead here. Frame scripts are transcribed separately.
 *
 * Frame sounds are not in the canvas export. playFrameSounds() fires them
 * when a clip actually enters that frame (see src/f-data.js).
 */
(() => {
  'use strict';

  const STOPS = Object.freeze({
    5: [1], 7: [1], 25: [1, 3], 27: [], 28: [1], 31: [], 72: [22],
    184: [1, 2],
    257: [12, 33, 43, 65, 71, 103, 113, 140, 150, 160, 179, 205, 211, 219, 272, 297, 305, 306],
    261: [1, 14], 268: [1, 15], 294: [1], 298: [1], 302: [12], 307: [8],
    312: [66], 319: [22], 320: [26, 27], 370: [], 371: [1, 12], 372: [14],
    376: [2, 3, 4], 378: [1, 7, 23, 26], 379: [3, 4],
    382: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], 389: [1, 2],
    400: [16], 402: [1, 59], 403: [1, 2, 3], 416: [172], 418: [1, 2],
    423: [1, 5], 436: [1, 500],
    460: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
    469: [1, 3, 10], 474: [19], 478: [1, 13], 482: [1, 2], 488: [1, 13],
    490: [19], 492: [1, 11], 496: [1, 13], 498: [1, 10], 501: [1, 13],
    503: [1, 10], 506: [1, 13], 508: [1, 10], 509: [2], 514: [1],
    520: [1], 526: [1], 534: [1, 2], 536: [1, 2], 537: [2, 3, 4],
    544: [1, 5], 550: [1], 553: [], 555: [],
    // 130/46/157 are loops back to a label, not stops.
    565: [39, 82, 109, 147, 148, 183, 190, 200, 219],
    569: [1, 33], 578: [1], 579: [4, 8]
  });

  // Seconds values from clip events. Sprite 25 frame 3 always
  // jumps to frame 2, and that frame's timer++ runs in the same tick, so the
  // counter advances once per frame. The parent then resumes on the next tick.
  // 2*seconds-1 held every pause about twice as long as the original.
  const DELAYS = Object.freeze({
    27: {1: 60},
    312: {1: 20, 32: 20, 40: 15, 41: 20, 50: 15},
    320: {28: 15, 47: 12, 48: 120},
    379: {1: 190, 2: 8},
    416: {1: 15},
    565: {167: 6, 218: 50},
    578: {5: 50}
  });
  const REPLACED_DELAYS = Object.freeze({312: [41], 320: [48], 379: [2]});

  // Bonus graphics must stay on their icon frame until bonus.play().
  const BONUS_HOLD = new Set([478, 488, 492, 496, 498, 501, 503, 506, 508]);
  const SHOTS = Object.freeze({2: ['p1'], 3: ['p2', 'p1'], 4: ['p3']});
  const STANDING_4 = Object.freeze(['p2', 'p1']);
  const STANDING_DEFAULT = Object.freeze(['p3', 'p2', 'p1']);

  class ClipTimelines {
    constructor(app) {
      this.app = app;
      this.clips = new Map();
      this.lengths = new Map();
      this.byId = new Map();
      this.penguins = new Map();
      this.renderNumber = 0;
      this.stack = [];
      this.stackIndex = -1;
      this.pending = [];
    }

    length(id) {
      if (this.lengths.has(id)) return this.lengths.get(id);
      const fn = window['sprite' + id];
      const match = fn && /frame_cnt\s*=\s*(\d+)/.exec(Function.prototype.toString.call(fn));
      const count = match ? Number(match[1]) : 1;
      this.lengths.set(id, count);
      return count;
    }

    begin() {
      this.renderNumber++;
      this.stackIndex = 0;
      let root = this.stack[0];
      if (!root) {
        this.stack[0] = {path: 'root', id: 0, frame: this.app.rootFrame, counts: Object.create(null)};
      } else {
        root.path = 'root';
        root.id = 0;
        root.frame = this.app.rootFrame;
        // Allocate a fresh null-proto object instead of enumerating+deleting
        // every key from the previous sibling counts.
        root.counts = Object.create(null);
      }
    }

    end() {
      for (const [path, clip] of this.clips)
        if (clip.seen !== this.renderNumber) this.clips.delete(path);
      this.stackIndex = -1;
    }

    parent() { return this.stack[this.stackIndex]; }

    enter(name) {
      const parent = this.parent();
      const ordinal = parent.counts[name] || 0;
      parent.counts[name] = ordinal + 1;
      const id = name.startsWith('sprite') ? Number(name.slice(6)) : 0;
      let identity = ordinal;
      if (parent.id === 379 && id === 372) {
        identity = SHOTS[parent.frame]?.[ordinal] || ordinal;
      } else if (parent.id === 379 && id === 378) {
        const standing = parent.frame === 4 ? STANDING_4 : STANDING_DEFAULT;
        identity = standing[ordinal] || ordinal;
      }
      const path = parent.path + '/' + name + '#' + identity;
      const length = id ? this.length(id) : 1;
      let clip = this.clips.get(path);
      if (clip && id === 25 && clip.parentFrame !== parent.frame &&
          REPLACED_DELAYS[parent.id]?.includes(parent.frame)) {
        this.clips.delete(path);
        clip = null;
      }
      if (!clip) {
        clip = {
          path, parentPath: parent.path, parentId: parent.id,
          parentFrame: parent.frame, id, frame: 1, length, playing: true,
          seen: this.renderNumber, delay: 0, loopVar: 0, soundedFrame: 0
        };
        this.clips.set(path, clip);
        this.onFrame(clip);
        this.flushPending(clip);
      }
      clip.seen = this.renderNumber;
      clip.parentFrame = parent.frame;
      if (id) this.byId.set(id, clip);
      if (id === 378 && typeof identity === 'string') this.penguins.set(identity, clip);
      this.stackIndex++;
      let entry = this.stack[this.stackIndex];
      if (!entry) {
        this.stack[this.stackIndex] = {path, id, frame: clip.frame, counts: Object.create(null)};
      } else {
        entry.path = path;
        entry.id = id;
        entry.frame = clip.frame;
        // Fresh null-proto counts; faster than enumerating and deleting every
        // previous child-name key.
        entry.counts = Object.create(null);
      }
      return clip;
    }

    leave() { this.stackIndex--; }
    lookup(path) { return this.clips.get(path); }
    play(clip) { if (clip) clip.playing = true; }
    stop(clip) { if (clip) clip.playing = false; }

    goto(clip, frame, playing = true, retrigger = false) {
      if (!clip) return;
      clip.frame = Math.max(1, Math.min(clip.length, frame));
      clip.playing = playing;
      // A goto that plays re-runs the frame, including its sound, even if
      // the playhead was already there. Internal loops must not pass retrigger
      // or a same-frame goto would recurse.
      if (retrigger) clip.soundedFrame = 0;
      this.onFrame(clip);
    }

    requestPlay(path, frame, playing = true) {
      const clip = this.lookup(path);
      if (!clip) {
        this.pending.push({path, frame, playing, retrigger: frame != null});
        return;
      }
      if (frame == null) this.play(clip);
      else this.goto(clip, frame, playing, true);
    }

    flushPending(clip) {
      if (this.pending.length === 0) return;
      const left = [];
      for (let i = 0; i < this.pending.length; i++) {
        const item = this.pending[i];
        if (item.path !== clip.path) { left.push(item); continue; }
        if (item.frame == null) this.play(clip);
        else this.goto(clip, item.frame, item.playing, !!item.retrigger);
      }
      this.pending = left;
    }

    sibling(clip, id, ordinal = 0) {
      return this.lookup(clip.parentPath + '/sprite' + id + '#' + ordinal);
    }
    child(clip, id, ordinal = 0) {
      return this.lookup(clip.path + '/sprite' + id + '#' + ordinal);
    }
    ancestor(clip, id) {
      let parent = this.lookup(clip.parentPath);
      while (parent && parent.id !== id) parent = this.lookup(parent.parentPath);
      return parent;
    }

    playFrameSounds(clip) {
      if (!clip || clip.soundedFrame === clip.frame) return;
      clip.soundedFrame = clip.frame;
      const sounds = window.FRAME_SOUNDS?.[clip.id]?.[clip.frame];
      if (!sounds || !this.app.audio) return;
      for (const id of sounds) {
        if (id === 1 && clip.id === 320) {
          this.app.audio.playIntroSting();
          continue;
        }
        this.app.audio.effect(id, id === 1 ? 0 : 0.78);
      }
    }

    onFrame(clip) {
      const {id, frame: f} = clip;
      if (id === 25) {
        const seconds = DELAYS[clip.parentId]?.[clip.parentFrame] || 1;
        clip.delay = Math.max(1, seconds);
        this.stop(this.lookup(clip.parentPath));
        return;
      }
      if (BONUS_HOLD.has(id) && f === 1) clip.playing = false;
      if (STOPS[id]?.includes(f)) clip.playing = false;
      if (BONUS_HOLD.has(id) && f === clip.length) clip.playing = false;

      switch (id) {
        case 28:
          if (f === 2) {
            clip.loopVar = Math.floor(Math.random() * 30);
            if (clip.loopVar < 29) this.goto(clip, 2, true);
          }
          break;
        case 31:
          if (f === 26) {
            clip.loopVar = Math.floor(Math.random() * 4);
            if (clip.loopVar < 3) this.goto(clip, 1, true);
          }
          break;
        case 268:
          if (f === 15) this.play(this.lookup(clip.parentPath));
          break;
        case 312:
          if (f === 41) this.play(this.child(clip, 294));
          if (f === 54) {
            this.play(this.sibling(clip, 261));
            this.play(this.sibling(clip, 268));
          }
          if (f === 66) this.play(this.lookup(clip.parentPath));
          break;
        case 320:
          if (f === 26 || f === 61) this.app.continueIntro();
          // Sound 1 is tagged on frame 30, after sprite312 f66 and sprite268 f15
          // release the stops at 26 and 27 and the frame-28 delay elapses.
          // Do not start it on the frame-26 hold — that is when the tear begins.
          break;
        case 370:
          if (f === 2 && Math.random() < 0.98) this.goto(clip, 1, true);
          break;
        case 371:
          if (f === 5) this.play(this.child(clip, 294));
          if (f === 11) this.play(this.ancestor(clip, 379));
          break;
        case 372:
          if (f === 13) this.play(this.child(clip, 371));
          break;
        case 376:
          if (f === 1) this.goto(clip, 2 + Math.floor(Math.random() * 3), false);
          break;
        case 378:
          if (f === 2) this.play(this.child(clip, 294));
          if (f === 18) this.goto(clip, 1, false);
          if (f === 25 && this.app.mode === 'launching') {
            this.app.launchReady = true;
            const blurs = this.lookup('root/sprite403#0');
            if (blurs) this.play(this.child(blurs, 402));
          }
          break;
        case 379:
          if (f === 38) this.goto(clip, 5, true);
          break;
        case 469:
          if (f === 2 || f === 9 || f === 16) this.goto(clip, 1, false);
          break;
        case 509:
          break;
        case 553:
          this.turboButton(clip, f);
          break;
        case 555:
          if (f === 2 && !this.app.game?.pointerStatus) this.goto(clip, 1, false);
          if (f === 9 && this.app.game?.pointerStatus) this.goto(clip, 8, false);
          break;
        case 565:
          this.penguinFrame(clip, f);
          break;
        case 569:
          if (f === 33 && this.app.game) this.app.game.explDone = true;
          break;
      }
      this.playFrameSounds(clip);
    }

    turboButton(clip, f) {
      const g = this.app.game;
      if (f === 3) {
        if (!g || g.turbos < 1) this.goto(clip, 1, false);
        else if (g.firstTurbo) this.goto(this.child(clip, 544), 2, true);
      } else if (f === 15) {
        if (g && g.turbos >= 1) this.goto(clip, 14, false);
        else if (g && g.firstTurbo) {
          this.goto(this.child(clip, 544), 6, true);
          g.firstTurbo = false;
        }
      }
    }

    penguinFrame(clip, f) {
      // downfall2 / 5 / 8 / 14 loop until the next click, matching the original.
      if (f === 46) { this.goto(clip, 40, true); return; }
      if (f === 130) { this.goto(clip, 110, true); return; }
      if (f === 146) { this.goto(clip, 131, true); return; }
      if (f === 157) { this.goto(clip, 149, true); return; }
      if (f === 83 || f === 86 || f === 110 || f === 115) {
        const head = this.child(clip, 294);
        if (head) this.goto(head, 2, true);
      }
      if (f === 201 && this.app.game) {
        const g = this.app.game;
        g.explX = g.x;
        g.explY = g.y;
        g.explOn = true;
        this.requestPlay('root/sprite569#0', 2, true);
      }
    }

    advance() {
      // Frame scripts only mutate existing clips or queue pending requests; they
      // never add/delete entries here. Iterate the map directly to avoid an
      // array snapshot allocation on every timeline tick.
      for (const clip of this.clips.values()) {
        if (clip.id === 25) {
          if (clip.delay > 0 && --clip.delay === 0) {
            clip.playing = false;
            this.play(this.lookup(clip.parentPath));
          }
          continue;
        }
        if (!clip.playing || clip.length <= 1) continue;
        clip.frame = clip.frame === clip.length ? 1 : clip.frame + 1;
        this.onFrame(clip);
      }
    }
  }

  window.ClipTimelines = ClipTimelines;
})();
