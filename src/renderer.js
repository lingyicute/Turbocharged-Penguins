/*
 * Renderer - draws the exported canvas art
 * Improvements:
 * - Handles explosion (sprite569)
 * - Handles clickme hints for bonuses (sprite469)
 * - Better fader calculation
 * - Handles pointer, dummies, dontFall, best markers
 * - High DPI support
 */
(() => {
  'use strict';

  const W = 620, H = 360;
  const FONT89_ADV = Object.freeze({'.': 190, 'm': 606,
    '0': 381, '1': 381, '2': 381, '3': 381, '4': 381,
    '5': 381, '6': 381, '7': 381, '8': 381, '9': 381});
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const scoreString = cm => (Math.max(0, cm) / 100).toFixed(2) + 'm';

  class OriginalArtRenderer {
    constructor(app) {
      this.app = app;
      this.canvas = document.getElementById('game');
      // Opaque backing store. The stage is filled every frame, and the rounded
      // corners are clipped by CSS, so the page never needs canvas transparency.
      // f-art.js creates this context first; the flag has to be set there too.
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this.basePlace = window.place;
      this.drawingTile = false;
      this.rasters = new Map();
      this.rasterPixels = 0;
      this.rasterizing = false;
      const self = this;
      window.place = function(obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time) {
        return self.place(obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time);
      };

      // Handle high DPI
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.canvas);
      window.addEventListener('resize', () => this.handleResize());
      this.watchDpr();
      this.handleResize();
    }

    watchDpr() {
      if (!window.matchMedia) return;
      const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener('change', () => {
        this.handleResize();
        this.watchDpr();
      }, { once: true });
    }

    handleResize() {
      const canvas = this.canvas;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      if (window.enhanceContext) window.enhanceContext(this.ctx);
      if (this.rasters) {
        this.rasters.clear();
        this.rasterPixels = 0;
      }
      if (this.app) this.app.lastStamp = '';
    }

    // Device pixels per local unit, after the current transform and this place.
    deviceAxes(ctx, matrix) {
      const p = ctx._matrix;
      if (!p || !matrix) return null;
      const dx = p[0] * matrix[0] + p[2] * matrix[1];
      const dy = p[1] * matrix[0] + p[3] * matrix[1];
      const ex = p[0] * matrix[2] + p[2] * matrix[3];
      const ey = p[1] * matrix[2] + p[3] * matrix[3];
      return [Math.hypot(dx, dy), Math.hypot(ex, ey)];
    }

    cxKey(ctrans) {
      if (!ctrans || ctrans.isEmpty()) return '0';
      return ctrans.r_add + ',' + ctrans.g_add + ',' + ctrans.b_add + ',' + ctrans.a_add + ',' +
        ctrans.r_mult + ',' + ctrans.g_mult + ',' + ctrans.b_mult + ',' + ctrans.a_mult;
    }

    strokes(obj) {
      const fn = window[obj];
      if (typeof fn !== 'function') return true;
      if (fn._strokes === undefined)
        fn._strokes = /drawPath\([^)]*,true|drawMorphPath\([^)]*,true/.test(Function.prototype.toString.call(fn));
      return fn._strokes;
    }

    imagesReady(obj) {
      const fn = window[obj];
      if (typeof fn !== 'function') return false;
      let ids = fn._imgIds;
      if (!ids) ids = fn._imgIds = Function.prototype.toString.call(fn).match(/imageObj\d+/g) || [];
      for (const id of ids) {
        const img = window[id];
        if (!img || !img.complete || !img.naturalWidth) return false;
      }
      return true;
    }

    // Union of path points the shape draws before it scales into a bitmap fill.
    localBounds(obj, frame, ratio, ctrans) {
      if (!this._meter) {
        const c = document.createElement('canvas');
        c.width = 2;
        c.height = 2;
        this._meter = c.getContext('2d');
        if (window.enhanceContext) window.enhanceContext(this._meter);
      }
      const ctx = this._meter;
      if (!ctx) return null;
      ctx._localBox = null;
      ctx._trackLocal = true;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.rasterizing = true;
      try {
        window[obj](ctx, ctrans, frame, ratio, 0);
      } catch (e) {
        return null;
      } finally {
        this.rasterizing = false;
        ctx._trackLocal = false;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      const b = ctx._localBox;
      if (!b || !b.n) return null;
      return b;
    }

    // Same shape art is redrawn every physics frame (cliffs, sky, penguin
    // parts) and only the matrix changes. Rasterize it once at device scale
    // and blit. Skip non-uniform scales, blend modes, and destination-in:
    // a cached bitmap's transparent pad would erase mask pixels.
    tryBlit(obj, ctx, matrix, ctrans, blend, frame, ratio) {
      if (this.rasterizing) return false;
      if (!obj || (!obj.startsWith('shape') && !obj.startsWith('image') && !obj.startsWith('morphshape')))
        return false;
      if (blend > 1) return false;
      if (!ctx || ctx.globalCompositeOperation !== 'source-over') return false;
      // NORMAL strokes are expanded by 20x lineWidth after the path is recorded.
      // Caching those clips the line. Fills are the expensive redraw.
      if (this.strokes(obj) || window[obj]._noRaster) return false;
      if (!this.imagesReady(obj)) return false;
      const axes = this.deviceAxes(ctx, matrix);
      if (!axes) return false;
      const [ax, ay] = axes;
      if (!(ax > 0.02 && ay > 0.02)) return false;
      if (Math.max(ax, ay) / Math.min(ax, ay) > 1.15) return false;
      const scale = (ax + ay) * 0.5;
      const scaleKey = Math.round(scale * 1000) / 1000;
      const ratioKey = ratio == null ? 0 : Math.round(ratio * 1000) / 1000;
      const key = obj + '|' + (frame ?? 0) + '|' + ratioKey + '|' + this.cxKey(ctrans) + '|' + scaleKey;
      let entry = this.rasters.get(key);
      if (entry) {
        this.rasters.delete(key);
        this.rasters.set(key, entry);
      } else {
        const bounds = this.localBounds(obj, frame ?? 0, ratioKey, ctrans);
        if (!bounds) {
          window[obj]._noRaster = true;
          return false;
        }
        const pad = 8 + 2 / scale;
        const minX = bounds.minX - pad;
        const minY = bounds.minY - pad;
        const w = bounds.maxX - bounds.minX + pad * 2;
        const h = bounds.maxY - bounds.minY + pad * 2;
        if (!(w > 0 && h > 0)) return false;
        const cw = Math.ceil(w * scale);
        const ch = Math.ceil(h * scale);
        // Tall cliff art is a thin strip, so the limit is area, not the long side.
        if (cw < 1 || ch < 1 || cw > 8192 || ch > 8192 || cw * ch > 1200000) return false;
        while (this.rasters.size > 140 || this.rasterPixels + cw * ch > 2e7) {
          const oldest = this.rasters.keys().next().value;
          if (oldest === undefined) break;
          this.rasterPixels -= this.rasters.get(oldest).px;
          this.rasters.delete(oldest);
        }
        if (this.rasterPixels + cw * ch > 2e7) return false;
        let c;
        try {
          c = document.createElement('canvas');
          c.width = cw;
          c.height = ch;
        } catch (e) {
          return false;
        }
        if (c.width !== cw || c.height !== ch) return false;
        const octx = c.getContext('2d');
        if (!octx || !window.enhanceContext) return false;
        window.enhanceContext(octx);
        octx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
        this.rasterizing = true;
        try {
          window[obj](octx, ctrans, frame ?? 0, ratioKey, 0);
        } catch (e) {
          return false;
        } finally {
          this.rasterizing = false;
        }
        if (window[obj]._imgIds && window[obj]._imgIds.length) {
          try {
            const px = Math.min(16, cw), py = Math.min(16, ch);
            const sx0 = Math.max(0, (cw - px) >> 1), sy0 = Math.max(0, (ch - py) >> 1);
            const data = octx.getImageData(sx0, sy0, px, py).data;
            let painted = false;
            for (let i = 3; i < data.length; i += 4) if (data[i]) { painted = true; break; }
            if (!painted) {
              window[obj]._noRaster = true;
              return false;
            }
          } catch (e) {
            window[obj]._noRaster = true;
            return false;
          }
        }
        entry = { c, minX, minY, w: cw / scale, h: ch / scale, px: cw * ch };
        this.rasterPixels += entry.px;
        this.rasters.set(key, entry);
      }
      ctx.save();
      ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
      ctx.drawImage(entry.c, entry.minX, entry.minY, entry.w, entry.h);
      ctx.restore();
      return true;
    }

    // Drawn in text484's space, where "x2" sits, so the bolt lands in the bubble.
    lightningLabel(ctx, ctrans) {
      const col = window.tocolor(ctrans.apply([252, 197, 0, 1]));
      // text484 is scaled by 0.5726, then the bonus by 0.05. Points below are
      // stage pixels from the bubble center, then mapped into this space.
      const placed = 0.572601318359375;
      const unit = 1 / (0.05 * placed);
      const cx = 420 / placed;
      const cy = (662 - 154) / placed;
      // Standard bolt, about 32px tall on the 620 stage. Thick, but still a bolt.
      const bolt = [
        [7.33, -16], [-12.67, 4], [-0.67, 4], [-6, 16],
        [12.67, 0], [0.67, 0], [8.67, -16]
      ];
      ctx.save();
      ctx.beginPath();
      bolt.forEach(([x, y], i) => {
        const px = cx + x * unit, py = cy + y * unit;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    }

    placedGlyphs(ctx, font, rgba, glyphs) {
      for (const [ch, size, x, y] of glyphs) {
        ctx.save();
        ctx.transform(size, 0, 0, size, x, y);
        font(ctx, ch, rgba);
        ctx.restore();
      }
    }
    // advances are already in the text field's translation units, not font units.
    layoutTracked(phrase, advances, size, y, anchor, centered) {
      const step = ch => {
        const v = advances[ch];
        return Number.isFinite(v) ? v : 0;
      };
      let width = 0;
      for (const ch of phrase) width += step(ch);
      let x = centered ? anchor - width / 2 : anchor;
      const glyphs = [];
      for (const ch of phrase) {
        glyphs.push([ch, size, x, y]);
        x += step(ch);
      }
      return glyphs;
    }
    scaledAdv(fu, size) {
      const adv = {};
      for (const ch of Object.keys(fu)) adv[ch] = fu[ch] * size;
      return adv;
    }
    // Record, or the empty-state line, in the open area under the title.
    leaderboardValue(ctx, ctrans) {
      const col = window.tocolor(ctrans.apply([145, 24, 118, 1]));
      const best = this.app.storedBest || 0;
      if (best > 12000) {
        const size = 1.05;
        const adv = this.scaledAdv(FONT89_ADV, size);
        const baseline = 150 + (735 * size) / 2;
        this.placedGlyphs(ctx, window.font89, col, this.layoutTracked(
          scoreString(best), adv, size, baseline, 60, true
        ));
        return;
      }
      const size = 0.5;
      const adv = this.scaledAdv({
        ' ':191.1, '-':328.2, 'A':519.7, 'L':440.9, 'N':566, 'R':530.1, 'Y':423.3,
        'a':436.9, 'c':395.9, 'd':440.9, 'e':436.9, 'g':454.6, 'h':450, 'i':230.4,
        'n':466.8, 'o':428.5, 'r':328.8, 's':401.8, 't':293.5, 'u':450, 'w':629.4
      }, size);
      const baseline = 150 + (728 * size) / 2;
      this.placedGlyphs(ctx, window.font8, col, this.layoutTracked(
        'No Record - Your Legend Awaits', adv, size, baseline, 60, true
      ));
    }
    // End panel only (sprite189). Two lines fill the card area above the bar.
    justReached(ctx, ctrans) {
      const cm = this.app.game?.cm ?? this.app.storedBest ?? 0;
      const score = this.app.game?.finalScore || scoreString(cm);
      const cx = -280;
      const small = 0.42;
      const smallAdv = this.scaledAdv({
        ' ':191.1, '!':250, 'A':519.7, 'Y':423.3, 'a':436.9, 'c':395.9, 'd':440.9,
        'e':436.9, 'h':450, 'i':230.4, 'j':240, 'm':688.6, 'o':428.5, 'r':328.8,
        's':401.8, 't':293.5, 'u':450, 'w':629.4
      }, small);
      const teal = window.tocolor(ctrans.apply([13, 83, 114, 1]));
      this.placedGlyphs(ctx, window.font8, teal, this.layoutTracked(
        'Awesome! You just reached', smallAdv, small, -2360, cx, true
      ));
      const big = 1.75;
      const magenta = window.tocolor(ctrans.apply([183, 0, 157, 1]));
      this.placedGlyphs(ctx, window.font89, magenta, this.layoutTracked(
        score, this.scaledAdv(FONT89_ADV, big), big, -914, cx, true
      ));
    }
    place(obj, canvas, ctx, matrix, ctrans, blend, frame, ratio, time) {
      if (this.tryBlit(obj, ctx, matrix, ctrans, blend, frame, ratio)) return;
      // sprite13 is the white corner cap (shape12), placed on all four corners.
      if (obj === 'sprite13') return;
      const a = this.app, g = a.game;
      // Opening mark. Not drawn on the lockup, the how-to panel, or the end panel.
      if (obj === 'sprite122') return;
      // The x1 pickup draws the same purple bubble as x2, with a bolt for the label.
      if (obj === 'sprite478') {
        const clip = a.timeline.enter(obj);
        if (this.currentBonus) this.currentBonus.visualPath = clip.path;
        const [aa, bb, cc, dd, tx, ty] = matrix;
        const mat = [aa, bb, cc, dd, tx + aa * 662, ty + bb * 662];
        this.skipBubbleLabel = true;
        try {
          return this.basePlace('sprite488', canvas, ctx, mat, ctrans, blend, clip.frame - 1, ratio, 0);
        } finally {
          this.skipBubbleLabel = false;
          a.timeline.playFrameSounds(clip);
          a.timeline.leave();
        }
      }
      const activeStage = g && a.rootFrame >= 114 && a.rootFrame <= 127;

      const draw = (name, mat, fr, rt = ratio) => {
        if (!name.startsWith('sprite') && !name.startsWith('button'))
          return this.basePlace(name, canvas, ctx, mat, ctrans, blend, fr ?? frame, rt, 0);
        const clip=a.timeline.enter(name);
        if (name === 'sprite379' && a.mode === 'restarting' && a.rootFrame >= 160 && clip.frame < 5) {
          a.timeline.goto(clip,5,true);
        }
        if (this.currentBonus) {
          if (name === 'sprite469') this.currentBonus.clickmePath = clip.path;
          if (name === 'sprite482') {
            this.currentBonus.buttPath = clip.path;
            if (this.currentBonus.collected) {
              clip.frame = 2;
              clip.playing = false;
            }
          }
          if (name === 'sprite478' || name === 'sprite492' || name === 'sprite498' ||
              name === 'sprite503' || name === 'sprite508') {
            this.currentBonus.visualPath = clip.path;
          }
        }
        if (fr !== undefined) {
          clip.frame=fr+1;
          clip.playing=false;
        }
        try {
          return this.basePlace(name, canvas, ctx, mat, ctrans, blend, fr ?? clip.frame-1, rt, 0);
        } finally {
          a.timeline.playFrameSounds(clip);
          a.timeline.leave();
        }
      };

      if (obj === 'sprite127') {
        draw(obj, matrix);
        ctx.save();
        ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        this.leaderboardValue(ctx, ctrans);
        ctx.restore();
        return;
      }
      if (obj === 'sprite189') {
        draw(obj, matrix);
        ctx.save();
        ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        this.justReached(ctx, ctrans);
        ctx.restore();
        return;
      }
      if (obj === 'sprite257')
        return draw(obj, matrix, Math.max(0, a.panelFrame - 1));
      if (obj === 'sprite389') return draw(obj, matrix, a.audio.muted ? 1 : 0);
      // sprite380 stays on its exported matrix. The floe looked submerged because
      // its clip mask (shape359) was composited at half alpha, not because of Y.

      if (this.drawingTile) {
        if (['sprite510', 'sprite514', 'sprite520', 'sprite526'].includes(obj)) return;
        if (obj === 'sprite534' || obj === 'sprite536')
          return draw(obj, matrix, g && g.vy < -35 ? 1 : 0);
        // Handle bonus clickme hint - set based on turboClickedToggle and position
        if (obj === 'sprite469') {
          // Original compares the bonus's tile-local _x, and points the hint
          // back toward center: right side shows "onleft", left side "onright".
          const bonus = this.currentBonus;
          if (bonus && bonus.collected) return draw(obj, matrix);
          if (g && !g.turboClickedToggle && bonus) {
            const pointLeft = bonus.x > 310;
            return draw(obj, matrix, pointLeft ? 9 : 2);
          }
          return draw(obj, matrix, 0);
        }
      }
      if (activeStage) {
        if (obj === 'sprite436') {
          // fader - original: framePos = Math.round(bg._y / 40), clamped to totalframes
          const n = clamp(Math.round(g.bgY / 40), 1, 500) - 1;
          return draw(obj, matrix, n);
        }
        if (obj === 'sprite461' || obj === 'sprite538') {
          a.timeline.enter(obj);
          try {
            if (obj === 'sprite461') this.drawFar(canvas, ctx, ctrans, blend);
            else this.drawTiles(canvas, ctx, ctrans, blend);
          } finally { a.timeline.leave(); }
          return;
        }
        if (obj === 'sprite568') {
          return draw(obj, [matrix[0],matrix[1],matrix[2],matrix[3],g.x,g.y]);
        }
        if (obj === 'sprite565') {
          if (!g.rotation) return draw(obj, matrix);
          const r = g.rotation * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
          const [aa,bb,cc,dd,tx,ty] = matrix;
          return draw(obj, [aa*co-cc*si,bb*co-dd*si,aa*si+cc*co,bb*si+dd*co,tx,ty]);
        }
        if (obj === 'sprite555') {
          return draw(obj, [matrix[0],matrix[1],matrix[2],matrix[3], g.x, matrix[5]]);
        }
        if (obj === 'sprite579') {
          const x = g.dummyX ?? g.x + 40;
          const y = g.dummyY ?? g.y;
          return draw(obj, [matrix[0],matrix[1],matrix[2],matrix[3], x, y]);
        }
        if (obj === 'sprite569' && g.explX != null) {
          return draw(obj, [matrix[0],matrix[1],matrix[2],matrix[3], g.explX, g.explY]);
        }
        if (obj === 'sprite418' && a.launchDx) {
          return draw(obj, [matrix[0],matrix[1],matrix[2],matrix[3], matrix[4] + a.launchDx, matrix[5]]);
        }
      }
      return draw(obj, matrix);
    }

    drawFar(canvas, ctx, ctrans, blend) {
      const g = this.app.game;
      const bottom = Math.floor(g.farY / 725);
      for (let n = bottom; n <= bottom + 1; n++) {
        const f = clamp(n - 1, 0, 25);
        this.basePlace('sprite460', canvas, ctx,
          [0.05,0,0,0.05,g.farX,g.farY-(n-1)*725], ctrans, blend, f, 0, 0);
      }
    }
    drawTiles(canvas, ctx, ctrans, blend) {
      const g = this.app.game;
      const bottom = Math.floor(g.bgY / 445);
      for (let n = bottom; n <= bottom + 1; n++) {
        const f = n === 0 ? 1 : n < 28 ? 2 : n === 28 ? 3 : 0;
        this.drawingTile = true;
        try {
          this.basePlace('sprite537', canvas, ctx,
            [0.05,0,0,0.05,g.bgX,g.bgY-n*445], ctrans, blend, f, 0, 0);
        } finally { this.drawingTile = false; }
        if (n === 28) {
          this.basePlace('sprite514', canvas, ctx,
            [0.05,0,0,0.05,g.bgX+39.1,g.bgY-n*445+388.1],
            ctrans, blend, 1, 0, 0);
        }
        const tile = g.tiles.get(n);
        if (!tile) continue;
        for (const b of tile.bonuses) {
          if (b.collected && this.app.now - b.collected > 560) continue;
          ctx.save();
          if (b.collected) ctx.globalAlpha *= clamp(1-(this.app.now-b.collected)/560,0,1);
          this.currentBonus = b;
          this.drawingTile = true;
          try {
            this.basePlace('sprite509', canvas, ctx,
              [0.05,0,0,0.05,g.bgX+b.x,g.bgY-n*445+b.y],
              ctrans, blend, b.type, 0, 0);
          } finally {
            this.drawingTile = false;
            this.currentBonus = null;
          }
          ctx.restore();
        }
        const best = this.app.storedBest;
        const minScore = (n-1)*445 + 500;
        if (best > 12000 && best > minScore && best < minScore+445) {
          const markerY = 445-(best-minScore);
          this.basePlace('sprite520', canvas, ctx,
            [0.05,0,0,0.05,g.bgX+39,g.bgY-n*445+markerY],
            ctrans, blend, n>28?2:1, 0, 0);
        }
      }
    }
    render() {
      if (window.beginCanvasPool) window.beginCanvasPool();
      const ctx = this.ctx;
      ctx.save();
      const sx = this.canvas.width / W;
      const sy = this.canvas.height / H;
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      this.app.timeline.begin();
      try {
        window.main(ctx, window.ctrans, this.app.rootFrame - 1, 0, 0);
      } finally {
        this.app.timeline.end();
        ctx.restore();
      }
    }
  }

  window.OriginalArtRenderer = OriginalArtRenderer;
})();
