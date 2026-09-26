/*
 * Turbocharged Penguins
 */
(() => {
  'use strict';

  const W = 620, H = 360, FPS = 36, FRAME_MS = 1000 / FPS, PHYS_MS = 12;
  const PENGUIN_ANIMS = Object.freeze({
    1: [1, 39], 2: [40, 46], 3: [47, 82], 4: [83, 109],
    5: [110, 130], 6: [147, 147], 7: [148, 148], 8: [149, 157],
    9: [158, 166], 10: [167, 183], 11: [184, 190], 12: [191, 200],
    blur: [201, 218], spin: [219, 219]
  });
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const scoreString = cm => (Math.max(0, cm) / 100).toFixed(2) + 'm';
  const SINGLE_CUE_IDS = Object.freeze(new Set([5, 7, 294, 382, 402, 403, 418, 423, 550, 553, 555, 565, 569, 578, 579]));

  class TurboPenguins {
    constructor() {
      this.canvas = document.getElementById('game');
      this.audio = new window.GameAudio();
      this.rootFrame = 1;
      this.rootTime = 0;
      this.rootContinue = false;
      this.panelFrame = 1;
      this.mode = 'intro';
      this.chooseTime = 0;
      this.transitionTick = 0;
      this.tickNumber = 0;
      this.game = null;
      this.resultTarget = 0;
      this.panelPhase = '';
      this.panelStop = 0;
      this.panelJump = 0;
      this.panelGoto = 0;
      this.selected = 1;
      this.storedBest = this.readBest();
      this.beatenBest = this.storedBest;
      this.lastTime = 0;
      this.frameAcc = 0;
      this.physAcc = 0;
      this.now = performance.now();
      this.pointer = {x: W/2, y: H/2};
      this.pressed = null;
      // Reuse two snapshots instead of allocating/joining a large stamp string
      // on every display refresh.
      this.visualParts = [[], []];
      this.visualPartIndex = 0;
      this.forceRender = false;
      this.timeline = new window.ClipTimelines(this);
      this.renderer = new window.OriginalArtRenderer(this);
      this.launchReady = false;
      this.launchDx = 0;
      this.displayCm = 0;
      this.charging = 0;
      this.hovered = 0;
      this.introWait = 0;
      this.canvas.style.cursor = 'pointer';
      this.bindInputs();
      requestAnimationFrame(t => this.loop(t));
    }
    readBest() {
      try { return Math.max(0, Number(localStorage.getItem('turbo-penguins-best-cm')) || 0); }
      catch (_) { return 0; }
    }
    saveBest(value) {
      this.storedBest = Math.max(this.storedBest, value);
      try { localStorage.setItem('turbo-penguins-best-cm', String(this.storedBest)); }
      catch (_) {}
    }
    setFrame(n) {
      if (this.rootFrame === n) this.rootTime++;
      else { this.rootFrame = n; this.rootTime = 0; }
    }
    continueIntro() {
      if (this.mode === 'intro' && (this.rootFrame === 50 || this.rootFrame === 51))
        this.rootContinue = true;
    }
    advanceIntro() {
      if (!this.audio.unlocked) {
        this.setFrame(1);
        return;
      }
      if (this.rootFrame < 50) {
        this.setFrame(this.rootFrame + 1);
      } else if (this.rootFrame <= 51) {
        if (!this.rootContinue) {
          this.setFrame(this.rootFrame);
          return;
        }
        this.rootContinue = false;
        this.setFrame(this.rootFrame + 1);
        if (this.rootFrame === 52) this.panelFrame = 44;
      } else {
        this.setFrame(53);
        this.mode = 'menuIn';
      }
    }

    flushCues() {
      const g = this.game;
      if (!g || !g.cues || !g.cues.length) return;
      const cues = g.cues;
      const clen = cues.length;
      for (let i = 0; i < clen; i++) {
        const cue = cues[i];
        if (cue.op === 'play') {
          let path = cue.path;
          let id = 0;
          if (path) {
            const idx = path.lastIndexOf('sprite');
            if (idx !== -1) {
              id = parseInt(path.slice(idx + 6), 10) || 0;
            }
          }
          const ref = SINGLE_CUE_IDS.has(id) ? this.timeline.byId.get(id) : null;
          if (ref && this.timeline.clips.has(ref.path)) path = ref.path;
          this.timeline.requestPlay(path, cue.frame, cue.playing !== false);
        } else if (cue.op === 'sound') this.audio.effect(cue.id, cue.volume ?? 0.75);
      }
      cues.length = 0;
    }

    penguinClip(n) {
      const attached = this.timeline.penguins.get('p' + n);
      if (attached && this.timeline.clips.has(attached.path)) return attached;
      const flock = this.timeline.lookup('root/sprite380#0/sprite379#0');
      return flock && this.timeline.lookup(`${flock.path}/sprite378#p${n}`);
    }

    ensureSelectPose() {
      const peng = this.timeline.lookup('root/sprite380#0/sprite379#0');
      if (!peng) this.timeline.requestPlay('root/sprite380#0/sprite379#0', 5, true);
      else if (peng.frame < 5) this.timeline.goto(peng, 5, true);
    }

    loop(now) {
      if (document.hidden) {
        this.lastTime = now;
        requestAnimationFrame(t => this.loop(t));
        return;
      }
      let dt = this.lastTime ? clamp(now-this.lastTime, 0, 80) : FRAME_MS;
      this.lastTime = now;
      this.now = now;
      window.Physics._pointerX = this.pointer.x;
      this.audio.update(dt, this.mode === 'playing');
      this.frameAcc += dt;
      let frames = 0;
      while (this.frameAcc >= FRAME_MS && frames++ < 4) {
        this.frameAcc -= FRAME_MS;
        this.advanceFrame();
      }
      if (frames > 4) this.frameAcc = 0;
      if (this.mode === 'playing') {
        this.physAcc += dt;
        let steps = 0;
        while (this.physAcc >= PHYS_MS && steps++ < 7 && this.mode === 'playing') {
          this.physAcc -= PHYS_MS;
          this.advancePhysics();
        }
        if (steps > 7) this.physAcc = 0;
      } else this.physAcc = 0;
      // Always refresh the snapshot, even on forced frames: skipping the
      // call would leave the next comparison against a stale state.
      const changed = this.forceRender || this.visualStateChanged();
      this.forceRender = false;
      if (changed) {
        this.renderer.render();
        // Rendering creates clips the pre-render state did not yet include.
        this.visualStateChanged();
      }
      requestAnimationFrame(t => this.loop(t));
    }

    // Idle screens (tap-to-start, how-to, result) redraw only when a clip, the
    // camera, or a fading bonus changes. Compare into reusable arrays instead
    // of allocating a parts array and joining a potentially large string on
    // every display refresh.
    visualStateChanged() {
      const previous = this.visualParts[this.visualPartIndex];
      const current = this.visualParts[this.visualPartIndex ^ 1];
      const g = this.game;
      current.length = 0;
      current.push(this.rootFrame, this.panelFrame, this.mode, this.audio.muted ? 1 : 0,
        this.displayCm, this.launchDx || 0);
      if (g) {
        current.push(g.x, g.y, g.bgX, g.bgY, g.farX, g.farY, g.rotation, g.cm, g.vy, g.turbos,
          g.anim, g.pengFrame, g.explX, g.explY, g.dummyX, g.dummyY,
          g.pointerStatus ? 1 : 0, g.turboClickedToggle ? 1 : 0);
        if (g.tiles) {
          for (const tile of g.tiles.values()) {
            for (const b of tile.bonuses) {
              if (b.collected && this.now - b.collected < 600)
                current.push('f', b.x, (this.now - b.collected) | 0);
            }
          }
        }
      }
      for (const clip of this.timeline.clips.values())
        current.push(clip.id, clip.frame, clip.playing ? 1 : 0);

      let changed = current.length !== previous.length;
      if (!changed) {
        for (let i = 0; i < current.length; i++) {
          if (current[i] !== previous[i]) { changed = true; break; }
        }
      }
      this.visualPartIndex ^= 1;
      return changed;
    }

    advanceFrame() {
      this.tickNumber++;
      if (this.mode === 'intro' && !this.audio.unlocked) {
        this.setFrame(1);
        return;
      }
      this.timeline.advance();
      const g = this.game;
      if (g) {
        g.animTicks++;
        const [lo,hi] = PENGUIN_ANIMS[g.anim] || PENGUIN_ANIMS[1];
        g.pengFrame = Math.min(hi, lo + g.animTicks - 1) - 1;
        if (g.turboExit) g.turboExit--;
      }
      switch (this.mode) {
        case 'intro': this.advanceIntro(); break;
        case 'menuIn':
          this.setFrame(53);
          this.panelFrame = Math.min(65, this.panelFrame + 1);
          if (this.panelFrame === 65) this.mode = 'menu';
          break;
        case 'menu': this.setFrame(53); break;
        case 'menuOut':
          this.setFrame(53);
          this.panelFrame++;
          if (this.panelFrame >= 71) {
            this.panelFrame = 1;
            this.chooseTime = 0;
            this.mode = 'select';
            this.setFrame(55);
          }
          break;
        case 'select':
          this.setFrame(55);
          this.chooseTime++;
          this.ensureSelectPose();
          break;
        case 'launching':
          this.transitionTick++;
          if (this.rootFrame === 55) {
            if (!this.launchReady && this.transitionTick < 25) {
              this.setFrame(55);
              break;
            }
            this.launchReady=false;
            this.setFrame(57);
            this.displayCm = 0;
          } else {
            if (this.displayCm < 500) this.displayCm = Math.min(500, this.displayCm + 24);
            this.setFrame(Math.min(114,this.rootFrame+1));
            if (this.rootFrame >= 114) this.beginPlaying();
          }
          break;
        case 'playing': this.setFrame(115); break;
        case 'ending':
          this.setFrame(Math.min(127,this.rootFrame+1));
          this.advanceEndingPanel();
          if (this.rootFrame === 127 && this.panelPhase === 'dest' && this.panelFrame >= this.resultTarget) {
            this.mode = 'result';
            this.panelFrame = this.resultTarget;
            this.transitionTick = 0;
          }
          break;
        case 'result':
          this.setFrame(127);
          if (this.panelFrame===140 && ++this.transitionTick>105) this.panelFrame=160;
          break;
        case 'restarting':
          if (this.rootFrame < 193) this.setFrame(this.rootFrame + 1);
          else {
            this.game = null;
            this.panelFrame = 1;
            this.chooseTime = 0;
            this.mode = 'select';
            this.setFrame(55);
          }
          break;
      }
    }

    beginPlaying() {
      this.game = window.Physics.createInitialGame(this.selected);
      this.mode = 'playing';
      this.panelFrame = 1;
      this.setFrame(115);
      this.timeline.requestPlay('root/sprite568#0/sprite565#0', 1, true);
      window.Physics.ensureTiles(this.game);
      this.physAcc = 0;
    }

    advancePhysics() {
      const g = this.game;
      if (!g) return;
      window.Physics.applyGravity(g);
      window.Physics.hitTests(g, this.audio);
      if (this.mode !== 'playing') { this.flushCues(); return; }
      window.Physics.movePenguin(g);
      window.Physics.ensureTiles(g);
      this.flushCues();
      if (window.Physics.checkEnd(g)) this.endGame();
    }

    endGame() {
      const g=this.game;
      if (!g || this.mode!=='playing') return;
      const previous=this.storedBest;
      // Captured before saveBest. The Awesome panel's leaderboard shows this,
      // not the record this run just wrote.
      this.beatenBest = previous;
      g.finalScore=scoreString(g.cm);
      g.turbos=0;
      this.timeline.requestPlay('root/sprite553#0', null, true);
      if (g.cm>previous) this.saveBest(g.cm);
      // Root frame 117 sets panels.goto, then plays gameover (or didntclick if
      // cm==500). Both stop on the continue button; the click resumes, and the
      // next goto script jumps to tryagain / entryform / already.
      if (g.cm === 500) {
        this.panelFrame = 20;
        this.panelStop = 33;
        this.panelJump = 43;
        this.panelGoto = 273;
        this.resultTarget = 297;
      } else {
        this.panelFrame = 3;
        this.panelStop = 12;
        this.panelJump = 18;
        this.panelGoto = g.cm <= 12000 ? 273 : (g.cm > previous ? 72 : 151);
        this.resultTarget = g.cm <= 12000 ? 297 : (g.cm > previous ? 103 : 160);
      }
      this.panelPhase = 'in';
      // Clear the sounded marker so a second visit to that panel frame still plays.
      const panel = this.timeline.byId.get(257) || this.timeline.lookup('root/sprite257#0');
      if (panel) panel.soundedFrame = 0;
      this.mode='ending';
      this.setFrame(116);
      this.transitionTick=0;
    }

    advanceEndingPanel() {
      if (this.panelPhase === 'hold') return;
      if (this.panelPhase === 'in') {
        if (this.panelFrame < this.panelStop) this.panelFrame++;
        if (this.panelFrame >= this.panelStop) {
          this.panelFrame = this.panelStop;
          this.panelPhase = 'hold';
        }
        return;
      }
      if (this.panelPhase === 'out') {
        this.panelFrame++;
        if (this.panelFrame >= this.panelJump) {
          this.panelFrame = this.panelGoto;
          this.panelPhase = 'dest';
        }
        return;
      }
      if (this.panelPhase === 'dest' && this.panelFrame < this.resultTarget) this.panelFrame++;
    }

    continuePanel() {
      if (this.mode !== 'ending' || this.panelPhase !== 'hold') return;
      this.panelPhase = 'out';
      this.panelFrame++;
      const panel = this.timeline.byId.get(257) || this.timeline.lookup('root/sprite257#0');
      if (panel) panel.soundedFrame = this.panelFrame;
      this.audio.effect(96, 0.7);
    }

    hoverPenguin(n) {
      if (this.mode !== 'select' || this.charging) return;
      if (!n) {
        this.hovered = 0;
        return;
      }
      const clip = this.penguinClip(n);
      if (!clip) return;
      // Stay-over must not restart the over clip. Leave + re-enter does,
      // unless that clip is still playing (frames 2–6; frame 7 is its stop).
      if (this.hovered === n) return;
      if (clip.frame > 1 && clip.frame < 7 && clip.playing) {
        this.hovered = n;
        return;
      }
      this.hovered = n;
      this.timeline.goto(clip, 2, true);
    }
    chargePenguin(n) {
      if (this.mode !== 'select') return;
      this.charging = n;
      const clip = this.penguinClip(n);
      if (clip) this.timeline.goto(clip, 19, true);
      const blurs = this.timeline.lookup('root/sprite403#0');
      if (blurs) this.timeline.goto(blurs, n, false);
    }
    cancelCharge() {
      if (!this.charging) return;
      const clip = this.penguinClip(this.charging);
      if (clip) this.timeline.goto(clip, 8, true);
      this.charging = 0;
    }
    choosePenguin(n) {
      if (this.mode!=='select') return;
      this.selected=clamp(n,1,3);
      this.charging = 0;
      this.mode='launching';
      this.transitionTick=0;
      this.launchReady=false;
      this.displayCm = 0;
      this.launchDx = this.selected === 3 ? 120 : this.selected === 2 ? 40 : 0;
      const chosen = this.penguinClip(this.selected);
      if (chosen) this.timeline.goto(chosen, 24, true);
      else this.timeline.requestPlay(`root/sprite380#0/sprite379#0/sprite378#p${this.selected}`, 24, true);
      // launch.play() — stopped on frame 1, so the next tick enters frame 2 (417+308).
      this.timeline.requestPlay('root/sprite418#0', null, true);
    }
    clickPenguin(x,y) {
      const g=this.game;
      if (!g || this.mode!=='playing') return;
      window.Physics.clickPenguin(g, x, y, this.audio);
      this.flushCues();
    }
    collectBonus(b) {
      const g=this.game;
      if (!g || b.collected) return;
      window.Physics.collectBonus(b, g, this.audio, this.now);
      this.flushCues();
    }
    useTurbos() {
      const g=this.game;
      if (this.mode!=='playing' || !g || g.turbos<=0) return;
      window.Physics.useTurbos(g, this.audio);
      this.flushCues();
    }
    startMenu() {
      if (this.mode!=='menu') return;
      this.audio.unlock();
      this.mode='menuOut';
      this.panelFrame=65;
    }
    restart() {
      if (this.mode!=='result') return;
      this.audio.effect(96,0.65);
      this.mode='restarting';
      this.rootTime=0;
      this.panelFrame=1;
      this.setFrame(128);
    }
    submitScore() {
      if (this.mode!=='result') return;
      this.audio.effect(96,0.55);
      this.panelFrame=140;
      this.transitionTick=0;
    }

    stagePoint(event) {
      const r=this.canvas.getBoundingClientRect();
      return {x:(event.clientX-r.left)*W/r.width,y:(event.clientY-r.top)*H/r.height};
    }
    hitArea(x,y) {
      if (x>563 && y<57) return 'sound';
      if (this.mode==='menu')
        return Math.hypot(x-101,y-116)<52 ? 'play' : null;
      if (this.mode==='select') {
        if (y>200 && y<340) {
          if (x>190 && x<268) return 'penguin1';
          if (x>=268 && x<330) return 'penguin2';
          if (x>=330 && x<430) return 'penguin3';
        }
        return null;
      }
      if (this.mode==='playing') {
        const g=this.game;
        if (g.turbos>0 && x>470 && y>300) return 'turbo';
        for (const [n,tile] of g.tiles) {
          for (const b of tile.bonuses) {
            if (b.collected) continue;
            const center = window.Physics.bonusStageCenter(g, n, b);
            if (Math.hypot(x-center.x, y-center.y) < 36) return b;
          }
        }
        // button567 is hit-only (shape 566). Its stage rect, from the exported
        // matrices, is about 142×182 around the registration — not the 66×108
        // visual box. Clicks in that padding were misses, so the penguin fell.
        const dx=x-g.x, dy=y-g.y;
        if (dx>-68.32 && dx<73.33 && dy>-92.85 && dy<89.46) return 'penguin';
        return null;
      }
      if (this.mode==='ending' && this.panelPhase==='hold') {
        // continue > on the score popup (frame 12) and the didn't-click popup (33).
        // Stage box is the button text after the 0.05 panel scale, with padding.
        if (this.panelFrame===12 && x>220 && x<400 && y>185 && y<250) return 'continue';
        if (this.panelFrame===33 && x>220 && x<400 && y>198 && y<262) return 'continue';
      }
      if (this.mode==='result') {
        // tryagain PLAY is button163: stage origin ~(310, 225), hit ±44 x ±45.
        // The old (310, 306) disc was the blank area under the button.
        if ((this.panelFrame===273 || this.panelFrame===297) &&
            x>262 && x<358 && y>178 && y<272) return 'restart';
        if (this.panelFrame===151 && Math.hypot(x-310,y-218)<58) return 'restart';
        if (this.panelFrame===160 && Math.hypot(x-310,y-218)<58) return 'restart';
        if (this.panelFrame===72 && x>170 && x<455 && y>192 && y<243) return 'submit';
        if (this.panelFrame===140 && x>170 && x<455 && y>192 && y<243) return 'submit';
        // New-record footer used to be Back to game | Submit. Only Submit remains.
        if (this.panelFrame===103 && x>140 && x<500 && y>224 && y<271) return 'submit';
        if (this.panelFrame===179 && x>170 && x<455 && y>192 && y<243) return 'submit';
      }
      return null;
    }
    activate(target,x,y) {
      if (target==='sound') this.audio.toggle();
      else if (target==='play') this.startMenu();
      else if (/^penguin[123]$/.test(target)) this.choosePenguin(+target.slice(-1));
      else if (target==='penguin') this.clickPenguin(x,y);
      else if (target==='turbo') this.useTurbos();
      else if (target==='continue') this.continuePanel();
      else if (target==='restart') this.restart();
      else if (target==='submit') this.submitScore();
      else if (target && typeof target==='object' && target.type) this.collectBonus(target);
    }
    bindInputs() {
      this.canvas.addEventListener('pointermove', e => {
        const p=this.stagePoint(e);this.pointer=p;
        const area=this.hitArea(p.x,p.y);
        this.canvas.style.cursor = !this.audio.unlocked || area ? 'pointer' : 'default';
        if (this.mode==='select') this.hoverPenguin(/^penguin[123]$/.test(area||'') ? +area.slice(-1) : 0);
      });
      this.canvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        this.canvas.focus({preventScroll:true});
        if (!this.audio.unlocked) {
          this.audio.unlock();
          this.pressed = null;
          return;
        }
        const p=this.stagePoint(e);this.pointer=p;
        const area=this.hitArea(p.x,p.y);
        if (area==='penguin') {
          this.activate(area,p.x,p.y);
          this.pressed=null;
        } else if (typeof area==='string' && /^penguin[123]$/.test(area)) {
          this.chargePenguin(+area.slice(-1));
          this.pressed=area;
        } else this.pressed=area;
        try {this.canvas.setPointerCapture(e.pointerId);} catch (_) {}
      });
      this.canvas.addEventListener('pointerup', e => {
        e.preventDefault();
        const p=this.stagePoint(e);this.pointer=p;
        const hit=this.hitArea(p.x,p.y);
        const same=hit && hit===this.pressed;
        const wasCharge=this.charging;
        this.pressed=null;
        if (wasCharge) {
          if (same) this.choosePenguin(wasCharge);
          else this.cancelCharge();
        } else if (same) this.activate(hit,p.x,p.y);
      });
      this.canvas.addEventListener('pointercancel', () => {
        this.pressed=null;
        this.cancelCharge();
      });
      document.addEventListener('keydown', e => {
        if (e.repeat) return;
        if (['Space','Enter','Digit1','Digit2','Digit3','KeyM'].includes(e.code))
          e.preventDefault();
        if (!this.audio.unlocked) {
          this.audio.unlock();
          return;
        }
        if (e.code==='KeyM') this.activate('sound',0,0);
        else if (this.mode==='menu' && (e.code==='Space' || e.code==='Enter')) this.startMenu();
        else if (this.mode==='select' && /^Digit[123]$/.test(e.code))
          this.choosePenguin(Number(e.code.slice(-1)));
        else if (this.mode==='playing' && e.code==='Space') this.useTurbos();
        else if (this.mode==='ending' && this.panelPhase==='hold' && (e.code==='Enter' || e.code==='Space'))
          this.continuePanel();
        else if (this.mode==='result' && (e.code==='Enter' || e.code==='Space')) {
          if (this.panelFrame === 103) this.submitScore();
          else this.restart();
        }
      });
    }
  }

  window.addEventListener('load', () => {
    const pictures=Object.keys(window).filter(k=>/^imageObj\d+$/.test(k))
      .map(k=>window[k]).filter(x=>x instanceof HTMLImageElement);
    Promise.all(pictures.map(img => img.decode ? img.decode().catch(()=>{}) :
      new Promise(resolve => {if(img.complete)resolve();else img.onload=img.onerror=resolve;})))
      .then(() => { window.TurboPenguins = new TurboPenguins(); })
      .catch(err => {console.error('Unable to initialise artwork',err);});
  });
})();
