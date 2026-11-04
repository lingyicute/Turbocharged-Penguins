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
  const SKIP_TILE_SPRITES = new Set(['sprite510', 'sprite514', 'sprite520', 'sprite526']);
  const BOLT_PLACED = 0.572601318359375;
  const BOLT_UNIT = 1 / (0.05 * BOLT_PLACED);
  const BOLT_CX = 420 / BOLT_PLACED;
  const BOLT_CY = (662 - 154) / BOLT_PLACED;
  const BOLT_PTS = Object.freeze([
    [7.33, -16], [-12.67, 4], [-0.67, 4], [-6, 16],
    [12.67, 0], [0.67, 0], [8.67, -16]
  ].map(([x, y]) => Object.freeze([BOLT_CX + x * BOLT_UNIT, BOLT_CY + y * BOLT_UNIT])));
  const scaleMap = (fu, size) => {
    const out = {};
    for (const ch of Object.keys(fu)) out[ch] = fu[ch] * size;
    return Object.freeze(out);
  };
  const FONT89_ADV_105 = scaleMap(FONT89_ADV, 1.05);
  const FONT89_ADV_175 = scaleMap(FONT89_ADV, 1.75);
  const NO_RECORD_ADV = scaleMap({
    ' ':191.1, '-':328.2, 'A':519.7, 'L':440.9, 'N':566, 'R':530.1, 'Y':423.3,
    'a':436.9, 'c':395.9, 'd':440.9, 'e':436.9, 'g':454.6, 'h':450, 'i':230.4,
    'n':466.8, 'o':428.5, 'r':328.8, 's':401.8, 't':293.5, 'u':450, 'w':629.4
  }, 0.5);
  const AWESOME_SMALL_ADV = scaleMap({
    ' ':191.1, '!':250, 'A':519.7, 'Y':423.3, 'a':436.9, 'c':395.9, 'd':440.9,
    'e':436.9, 'h':450, 'i':230.4, 'j':240, 'm':688.6, 'o':428.5, 'r':328.8,
    's':401.8, 't':293.5, 'u':450, 'w':629.4
  }, 0.42);
  // Shapes whose scale or tint animates mint a bitmap per frame that is never
  // reused, costing a canvas allocation, a vector redraw, a blit and sometimes
  // a pixel readback. After this many back-to-back mints that nobody reused,
  // a shape is drawn live until the same raster key is requested twice.
  const CHURN_WASTE = 3;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const scoreString = cm => (Math.max(0, cm) / 100).toFixed(2) + 'm';
  // A fill with only a few path points and no bitmap costs the GPU one quad
  // whether it is drawn or blitted, so a large one is not worth caching: the
  // bitmap only adds an allocation and pushes other entries out of the budget.
  const SIMPLE_FILL_POINTS = 8;
  const SIMPLE_FILL_PIXELS = 250000;
  // Raster cache limits. Memory is bounded by the pixel budget; the entry cap
  // only bounds bookkeeping. At 140 entries the many small penguin/bonus
  // bitmaps evicted each other and were re-rasterized every few seconds.
  const MAX_RASTERS = 1024;
  const MAX_RASTER_PIXELS = 2e7;

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
      // Cache hits whose bounds miss the stage entirely are skipped. Such a
      // blit paints no pixel, so output is unchanged.
      this.cullEnabled = true;
      const self = this;
      window.place = function(obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time) {
        return self.place(obj, canvas, ctx, matrix, ctrans, blendMode, frame, ratio, time);
      };

      // Handle high DPI
      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => this.handleResize());
        this.resizeObserver.observe(this.canvas);
      }
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
      // Preserve native display resolution: never cap DPR or backing pixels.
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

      if (this.app) this.app.forceRender = true;
    }

    // Device pixels per local unit, after the current transform and this place.
    getDeviceScale(ctx, matrix) {
      const p = ctx._matrix;
      if (!p || !matrix) return 0;
      const dx = p[0] * matrix[0] + p[2] * matrix[1];
      const dy = p[1] * matrix[0] + p[3] * matrix[1];
      const ax = Math.hypot(dx, dy);
      if (ax <= 0.02) return 0;
      const ex = p[0] * matrix[2] + p[2] * matrix[3];
      const ey = p[1] * matrix[2] + p[3] * matrix[3];
      const ay = Math.hypot(ex, ey);
      if (ay <= 0.02) return 0;
      const maxA = ax > ay ? ax : ay;
      const minA = ax < ay ? ax : ay;
      if (maxA / minA > 1.15) return 0;
      return (ax + ay) * 0.5;
    }

    cxKey(ctrans) {
      if (!ctrans || ctrans.isEmpty()) return '0';
      if (ctrans._key) return ctrans._key;
      return (ctrans._key = ctrans.r_add + ',' + ctrans.g_add + ',' + ctrans.b_add + ',' + ctrans.a_add + ',' +
        ctrans.r_mult + ',' + ctrans.g_mult + ',' + ctrans.b_mult + ',' + ctrans.a_mult);
    }

    strokes(obj) {
      if (obj.startsWith('morphshape')) return true;
      const fn = window[obj];
      if (typeof fn !== 'function') return true;
      if (fn._strokes === undefined)
        fn._strokes = /drawPath\([^)]*,true|drawMorphPath\([^)]*,true/.test(Function.prototype.toString.call(fn));
      return fn._strokes;
    }

    imagesReady(obj) {
      const fn = window[obj];
      if (typeof fn !== 'function') return false;
      if (fn._imgsReady) return true;
      let ids = fn._imgIds;
      if (!ids) ids = fn._imgIds = Function.prototype.toString.call(fn).match(/imageObj\d+/g) || [];
      for (let i = 0; i < ids.length; i++) {
        const img = window[ids[i]];
        if (!img || !img.complete || !img.naturalWidth) return false;
      }
      fn._imgsReady = true;
      return true;
    }

    // Union of path points the shape draws before it scales into a bitmap fill.
    localBounds(obj, frame, ratio, ctrans) {
      const fn = window[obj];
      if (typeof fn !== 'function') return null;
      const ratioKey = ratio == null ? 0 : Math.round(ratio * 1000) / 1000;
      const bKey = (frame ?? 0) + '|' + ratioKey;
      if (fn._boundsCache && fn._boundsCache.has(bKey)) {
        return fn._boundsCache.get(bKey);
      }
      if (!this._meter) {
        const c = document.createElement('canvas');
        c.width = 2;
        c.height = 2;
        const m = c.getContext('2d');
        if (m) {
          if (window.enhanceContext) window.enhanceContext(m);
          const noop = () => {};
          m.fill = noop;
          m.stroke = noop;
          m.clip = noop;
          m.fillRect = noop;
        }
        this._meter = m;
      }
      const ctx = this._meter;
      if (!ctx) return null;
      // One fresh box per meter pass: add() accumulates into _localBox and
      // never resets it (it is the _pathBox sibling that resets on
      // beginPath), and every bounds entry below is stored by reference in
      // _boundsCache. Sharing a single box would therefore (a) union the
      // bounds of every shape ever metered and (b) alias one object across
      // all cache slots, silently ballooning later rasterizations past the
      // area cap. Per-pass allocation costs ~one object per shape per
      // session, which the hit path above already avoids.
      ctx._localBox = null;
      ctx._trackLocal = true;
      ctx._trackPad = 0;
      ctx._trackPadConst = 0;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.rasterizing = true;
      try {
        fn(ctx, window.ctrans || ctrans, frame, ratio, 0);
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
      if (!fn._boundsCache) fn._boundsCache = new Map();
      if (!b || !b.n) {
        fn._boundsCache.set(bKey, null);
        return null;
      }
      // Stroke padding recorded by drawPath/drawMorphPath during metering, so
      // stroked shapes can be cached without clipping the line. pad is in
      // local units (scale-independent); padConst is device-space and is
      // divided by the raster scale at cache time.
      b.pad = ctx._trackPad || 0;
      b.padConst = ctx._trackPadConst || 0;
      fn._boundsCache.set(bKey, b);
      return b;
    }

    // Same shape art is redrawn every physics frame (cliffs, sky, penguin
    // parts) and only the matrix changes. Rasterize it once at device scale
    // and blit. Skip non-uniform scales, blend modes, and destination-in:
    // a cached bitmap's transparent pad would erase mask pixels.
    tryBlit(obj, ctx, matrix, ctrans, blend, frame, ratio) {
      if (!ctx || this.rasterizing || ctx._floeMaskPathOnly) return false;
      if (!obj || (!obj.startsWith('shape') && !obj.startsWith('image')))
        return false;
      if (blend > 1) return false;
      if (!ctx || ctx.globalCompositeOperation !== 'source-over') return false;
      // NORMAL strokes are expanded by 20x lineWidth after the path is recorded.
      // Caching those clips the line, and any cached stroke blit resamples the
      // outline at fractional offsets, visibly softening it. Fills are the
      // expensive redraw.
      const fn = window[obj];
      if (this.strokes(obj) || fn._noRaster) return false;
      if (!this.imagesReady(obj)) return false;
      const scale = this.getDeviceScale(ctx, matrix);
      if (!scale) return false;
      // Exported shape/image functions do not read frame, ratio or time.
      // Placement ratios change each intro tick; including them duplicated
      // identical bitmaps and evicted useful entries during the first seconds.
      frame = 0; ratio = 0;
      const ratioKey = ratio == null ? 0 : Math.round(ratio * 1000) / 1000;
      const scaleKey = Math.round(scale * 1000) / 1000;
      const key = obj + '|' + (frame ?? 0) + '|' + ratioKey + '|' + this.cxKey(ctrans) + '|' + scaleKey;
      let entry = this.rasters.get(key);
      let minX, minY, w, h;
      if (entry) {
        // Frustum culling on the cached padded bounds (cheap: no bounds
        // lookup on the hit path). Frustum-culled blits are pixel-identical
        // no-ops. Misses still rasterize, so tiles are warm before they
        // scroll into view.
        minX = entry.minX; minY = entry.minY; w = entry.w; h = entry.h;
        entry.used = true;
        // LRU touch: stamp the render that blitted it. Re-inserting the key in
        // the Map on every hit (hundreds per frame) leaves tombstones and
        // forces periodic table rehashes; eviction scans for the stalest stamp
        // instead, which only happens when the cache is full. That keeps the
        // ever-present cliff/sky tiles hot when transient UI shapes churn the
        // cache during panel animations.
        // Stamp before culling so tiles waiting just off-stage stay cached.
        entry.seq = this.renderSeq | 0;
        if (this.culledOut(ctx, matrix, minX, minY, minX + w, minY + h)) return true;
      } else {
        // The previous raster minted for this shape paid off only if it has
        // been blitted again since; a static instance hitting every frame
        // must not hide an animated sibling that mints every frame.
        const prev = fn._rcPrev;
        let waste = fn._rcWaste || 0;
        if (prev !== undefined && prev.used) waste = 0;
        if (waste >= CHURN_WASTE && fn._rcLastKey !== key) {
          fn._rcLastKey = key;
          fn._rcWaste = waste;
          return false;
        }
        const bounds = this.localBounds(obj, frame ?? 0, ratioKey, ctrans);
        if (!bounds) {
          window[obj]._noRaster = true;
          return false;
        }
        const pad = 8 + 2 / scale + (bounds.pad || 0) + (bounds.padConst || 0) / scale;
        minX = bounds.minX - pad;
        minY = bounds.minY - pad;
        w = bounds.maxX - bounds.minX + pad * 2;
        h = bounds.maxY - bounds.minY + pad * 2;
        if (!(w > 0 && h > 0)) return false;
        // The sky gradient (shape431) is one rectangle whose colour transform
        // steps with the fader while climbing. Each step used to rasterize a
        // stage-sized bitmap and evict most of the cache, which then had to
        // be rebuilt. Draw such fills directly.
        if (bounds.n <= SIMPLE_FILL_POINTS && !(fn._imgIds && fn._imgIds.length) &&
            w * h * scale * scale > SIMPLE_FILL_PIXELS) {
          fn._noRaster = true;
          return false;
        }
        const cw = Math.ceil(w * scale);
        const ch = Math.ceil(h * scale);
        // Tall cliff art is a thin strip, so the limit is area, not the long side.
        if (cw < 1 || ch < 1 || cw > 8192 || ch > 8192 || cw * ch > 1200000) return false;
        while (this.rasters.size > MAX_RASTERS || this.rasterPixels + cw * ch > MAX_RASTER_PIXELS) {
          const oldest = this.leastRecentlyUsed();
          if (oldest === undefined) break;
          this.rasterPixels -= this.rasters.get(oldest).px;
          this.rasters.delete(oldest);
        }
        if (this.rasterPixels + cw * ch > MAX_RASTER_PIXELS) return false;
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
        entry = { c, minX, minY, w: cw / scale, h: ch / scale, px: cw * ch, used: false, seq: this.renderSeq | 0 };
        this.rasterPixels += entry.px;
        this.rasters.set(key, entry);
        fn._rcWaste = prev !== undefined && !prev.used ? waste + 1 : waste;
        fn._rcPrev = entry;
      }
      ctx.save();
      ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
      ctx.drawImage(entry.c, entry.minX, entry.minY, entry.w, entry.h);
      ctx.restore();
      return true;
    }

    // Key of the raster blitted longest ago; the earliest inserted wins ties.
    leastRecentlyUsed() {
      let key, best = Infinity;
      for (const [k, e] of this.rasters) {
        const seq = e.seq | 0;
        if (seq < best) { best = seq; key = k; }
      }
      return key;
    }

    // True when the device-space bounding box of [lx0,ly0]..[lx1,ly1] under
    // the current transform (ctx._matrix composed with the place matrix) misses
    // the canvas entirely. Drawing such a shape would produce no pixels.
    culledOut(ctx, matrix, lx0, ly0, lx1, ly1) {
      if (this.cullEnabled === false) return false;
      const pm = ctx._matrix;
      if (!pm || !matrix || !ctx.canvas) return false;
      const t0 = pm[0] * matrix[0] + pm[2] * matrix[1];
      const t1 = pm[1] * matrix[0] + pm[3] * matrix[1];
      const t2 = pm[0] * matrix[2] + pm[2] * matrix[3];
      const t3 = pm[1] * matrix[2] + pm[3] * matrix[3];
      const t4 = pm[0] * matrix[4] + pm[2] * matrix[5] + pm[4];
      const t5 = pm[1] * matrix[4] + pm[3] * matrix[5] + pm[5];
      let ddx, ddy, dx0, dy0, dx1, dy1;
      ddx = t0 * lx0 + t2 * ly0 + t4; ddy = t1 * lx0 + t3 * ly0 + t5;
      dx0 = dx1 = ddx; dy0 = dy1 = ddy;
      ddx = t0 * lx1 + t2 * ly1 + t4; ddy = t1 * lx1 + t3 * ly1 + t5;
      if (ddx < dx0) dx0 = ddx; if (ddx > dx1) dx1 = ddx;
      if (ddy < dy0) dy0 = ddy; if (ddy > dy1) dy1 = ddy;
      ddx = t0 * lx0 + t2 * ly1 + t4; ddy = t1 * lx0 + t3 * ly1 + t5;
      if (ddx < dx0) dx0 = ddx; if (ddx > dx1) dx1 = ddx;
      if (ddy < dy0) dy0 = ddy; if (ddy > dy1) dy1 = ddy;
      ddx = t0 * lx1 + t2 * ly0 + t4; ddy = t1 * lx1 + t3 * ly0 + t5;
      if (ddx < dx0) dx0 = ddx; if (ddx > dx1) dx1 = ddx;
      if (ddy < dy0) dy0 = ddy; if (ddy > dy1) dy1 = ddy;
      return dx1 <= 0 || dy1 <= 0 || dx0 >= ctx.canvas.width || dy0 >= ctx.canvas.height;
    }

    // Drawn in text484's space, where "x2" sits, so the bolt lands in the bubble.
    lightningLabel(ctx, ctrans) {
      const col = window.tocolor(ctrans.apply([252, 197, 0, 1]));
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(BOLT_PTS[0][0], BOLT_PTS[0][1]);
      for (let i = 1; i < BOLT_PTS.length; i++) {
        ctx.lineTo(BOLT_PTS[i][0], BOLT_PTS[i][1]);
      }
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    }

    placedGlyphs(ctx, font, rgba, glyphs) {
      window.drawPlacedGlyphs(ctx, font, rgba, glyphs);
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
    // Record, or the empty-state line, in the open area under the title.
    // sprite127 is on the menu and inside the Awesome panel (sprite189).
    // saveBest has already replaced storedBest, so that panel keeps the
    // record this run broke.
    leaderboardValue(ctx, ctrans) {
      const col = window.tocolor(ctrans.apply([145, 24, 118, 1]));
      const onAwesome = this.app.timeline.parent()?.id === 189;
      const best = (onAwesome ? this.app.beatenBest : this.app.storedBest) || 0;
      if (best > 12000) {
        if (this._bestGlyphsCm !== best) {
          const size = 1.05;
          const baseline = 150 + (735 * size) / 2;
          this._bestGlyphsCm = best;
          this._bestGlyphs = this.layoutTracked(
            scoreString(best), FONT89_ADV_105, size, baseline, 60, true
          );
        }
        this.placedGlyphs(ctx, window.font89, col, this._bestGlyphs);
        return;
      }
      if (!this._noRecordGlyphs) {
        this._noRecordGlyphs = this.layoutTracked(
          'No Record - Your Legend Awaits', NO_RECORD_ADV, 0.5, 150 + (728 * 0.5) / 2, 60, true
        );
      }
      this.placedGlyphs(ctx, window.font8, col, this._noRecordGlyphs);
    }
    // End panel only (sprite189). Two lines fill the card area above the bar.
    justReached(ctx, ctrans) {
      const cm = this.app.game?.cm ?? this.app.storedBest ?? 0;
      const score = this.app.game?.finalScore || scoreString(cm);
      const cx = -280;
      if (!this._awesomeGlyphs) {
        this._awesomeGlyphs = this.layoutTracked(
          'Awesome! You just reached', AWESOME_SMALL_ADV, 0.42, -2360, cx, true
        );
      }
      const teal = window.tocolor(ctrans.apply([13, 83, 114, 1]));
      this.placedGlyphs(ctx, window.font8, teal, this._awesomeGlyphs);
      if (this._scoreGlyphsText !== score) {
        this._scoreGlyphsText = score;
        this._scoreGlyphs = this.layoutTracked(
          score, FONT89_ADV_175, 1.75, -914, cx, true
        );
      }
      const magenta = window.tocolor(ctrans.apply([183, 0, 157, 1]));
      this.placedGlyphs(ctx, window.font89, magenta, this._scoreGlyphs);
    }
    place(obj, canvas, ctx, matrix, ctrans, blend, frame, ratio, time) {
      // Hot path: ~hundreds of place() calls per frame. Fast charCode prefix
      // check before any suffix scan or string allocation.
      const c0 = obj.charCodeAt(0);
      if ((c0 === 115 && obj.charCodeAt(1) === 104) || c0 === 105 || c0 === 109 || c0 === 116) {
        if (ctrans && ctrans.a_mult <= 0 && ctrans.a_add <= 0 && blend <= 1 && (!ctx || !ctx._floeMaskPathOnly)) return;
        if (c0 !== 116 && this.tryBlit(obj, ctx, matrix, ctrans, blend, frame, ratio)) return;
      }
      // sprite13 is the white corner cap (shape12), placed on all four corners.
      if (obj === 'sprite13') return;
      const a = this.app, g = a.game;
      // Opening mark. Not drawn on the lockup, the how-to panel, or the end panel.
      if (obj === 'sprite122') return;
      // The x1 pickup draws the same purple bubble as x2, with a bolt for the label.
      if (obj === 'sprite478') {
        const clip = a.timeline.enter(obj);
        if (this.currentBonus) {
          this.currentBonus.visualPath = clip.path;
          if (this.currentBonus.collected && clip.frame === 1 && !clip.playing) {
            a.timeline.play(clip);
          }
        }
        try {
          if (clip.frame === 1) {
            const aa = matrix[0], bb = matrix[1], cc = matrix[2], dd = matrix[3], tx = matrix[4], ty = matrix[5];
            // Reuse a scratch matrix instead of allocating a fresh array every
            // time the x1 bubble is rendered (once per placed bonus per frame).
            const mat = this._tmpMatA || (this._tmpMatA = [1,0,0,1,0,0]);
            mat[0]=aa; mat[1]=bb; mat[2]=cc; mat[3]=dd;
            mat[4] = tx + aa * 662; mat[5] = ty + bb * 662;
            this.skipBubbleLabel = true;
            try {
              return this.basePlace('sprite488', canvas, ctx, mat, ctrans, blend, 0, ratio, 0);
            } finally {
              this.skipBubbleLabel = false;
            }
          }
          return this.basePlace('sprite478', canvas, ctx, matrix, ctrans, blend, clip.frame - 1, ratio, 0);
        } finally {
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
            if (this.currentBonus.collected && clip.frame === 1 && !clip.playing) {
              a.timeline.play(clip);
            }
          }
        }
        if (fr !== undefined) {
          clip.frame=fr+1;
          clip.playing=false;
          const top = a.timeline.parent();
          if (top && top.path === clip.path) top.frame = clip.frame;
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
        if (SKIP_TILE_SPRITES.has(obj)) return;
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
        // Reuse a single scratch matrix for every in-place position override
        // below; avoids allocating a fresh 6-element array per sprite per frame.
        const sm = this._tmpMatA || (this._tmpMatA = [1,0,0,1,0,0]);
        if (obj === 'sprite568') {
          sm[0]=matrix[0]; sm[1]=matrix[1]; sm[2]=matrix[2]; sm[3]=matrix[3];
          sm[4]=g.x; sm[5]=g.y;
          return draw(obj, sm);
        }
        if (obj === 'sprite565') {
          if (!g.rotation) return draw(obj, matrix);
          const r = g.rotation * Math.PI / 180, co = Math.cos(r), si = Math.sin(r);
          const aa=matrix[0], bb=matrix[1], cc=matrix[2], dd=matrix[3];
          sm[0]=aa*co-cc*si; sm[1]=bb*co-dd*si; sm[2]=aa*si+cc*co; sm[3]=bb*si+dd*co;
          sm[4]=matrix[4]; sm[5]=matrix[5];
          return draw(obj, sm);
        }
        if (obj === 'sprite555') {
          sm[0]=matrix[0]; sm[1]=matrix[1]; sm[2]=matrix[2]; sm[3]=matrix[3];
          sm[4]=g.x; sm[5]=matrix[5];
          return draw(obj, sm);
        }
        if (obj === 'sprite579') {
          sm[0]=matrix[0]; sm[1]=matrix[1]; sm[2]=matrix[2]; sm[3]=matrix[3];
          sm[4]=g.dummyX ?? g.x + 40; sm[5]=g.dummyY ?? g.y;
          return draw(obj, sm);
        }
        if (obj === 'sprite569' && g.explX != null) {
          sm[0]=matrix[0]; sm[1]=matrix[1]; sm[2]=matrix[2]; sm[3]=matrix[3];
          sm[4]=g.explX; sm[5]=g.explY;
          return draw(obj, sm);
        }
      }
      if (obj === 'sprite418' && a.launchDx) {
        const sm = this._tmpMatA || (this._tmpMatA = [1,0,0,1,0,0]);
        sm[0]=matrix[0]; sm[1]=matrix[1]; sm[2]=matrix[2]; sm[3]=matrix[3];
        sm[4]=matrix[4] + a.launchDx; sm[5]=matrix[5];
        return draw(obj, sm);
      }
      return draw(obj, matrix);
    }

    drawFar(canvas, ctx, ctrans, blend) {
      const g = this.app.game;
      const bottom = Math.floor(g.farY / 725);
      if (!this._farMat) this._farMat = [0.05, 0, 0, 0.05, 0, 0];
      const mat = this._farMat;
      mat[4] = g.farX;
      for (let n = bottom; n <= bottom + 1; n++) {
        const f = clamp(n - 1, 0, 25);
        mat[5] = g.farY - (n - 1) * 725;
        this.basePlace('sprite460', canvas, ctx, mat, ctrans, blend, f, 0, 0);
      }
    }
    drawTiles(canvas, ctx, ctrans, blend) {
      const g = this.app.game;
      const bottom = Math.floor(g.bgY / 445);
      if (!this._tileMat) this._tileMat = [0.05, 0, 0, 0.05, 0, 0];
      if (!this._bonusMat) this._bonusMat = [0.05, 0, 0, 0.05, 0, 0];
      if (!this._floeMat) this._floeMat = [0.05, 0, 0, 0.05, 0, 0];
      if (!this._markerMat) this._markerMat = [0.05, 0, 0, 0.05, 0, 0];
      const tileMat = this._tileMat;
      const bonusMat = this._bonusMat;
      tileMat[4] = g.bgX;
      bonusMat[4] = g.bgX;
      for (let n = bottom; n <= bottom + 1; n++) {
        const f = n === 0 ? 1 : n < 28 ? 2 : n === 28 ? 3 : 0;
        this.drawingTile = true;
        tileMat[5] = g.bgY - n * 445;
        try {
          this.basePlace('sprite537', canvas, ctx, tileMat, ctrans, blend, f, 0, 0);
        } finally { this.drawingTile = false; }
        if (n === 28) {
          this._floeMat[4] = g.bgX + 39.1;
          this._floeMat[5] = g.bgY - n * 445 + 388.1;
          this.basePlace('sprite514', canvas, ctx, this._floeMat, ctrans, blend, 1, 0, 0);
        }
        const tile = g.tiles.get(n);
        if (!tile) continue;
        for (let bi = 0; bi < tile.bonuses.length; bi++) {
          const b = tile.bonuses[bi];
          if (b.collected && this.app.now - b.collected > 560) continue;
          ctx.save();
          if (b.collected) ctx.globalAlpha *= clamp(1-(this.app.now-b.collected)/560,0,1);
          this.currentBonus = b;
          this.drawingTile = true;
          bonusMat[4] = g.bgX + b.x;
          bonusMat[5] = g.bgY - n * 445 + b.y;
          this.app.timeline.enter('sprite509', `t${n}_${bi}`);
          try {
            this.basePlace('sprite509', canvas, ctx, bonusMat, ctrans, blend, b.type, 0, 0);
          } finally {
            this.app.timeline.leave();
            this.drawingTile = false;
            this.currentBonus = null;
          }
          ctx.restore();
        }
        const best = (this.app.mode === 'playing' ? this.app.storedBest : (this.app.beatenBest ?? this.app.storedBest)) || 0;
        const minScore = (n-1)*445 + 500;
        if (best > 12000 && best >= minScore && best < minScore+445) {
          const markerY = 445-(best-minScore);
          this._markerMat[4] = g.bgX + 39;
          this._markerMat[5] = g.bgY - n * 445 + markerY;
          this.basePlace('sprite520', canvas, ctx, this._markerMat, ctrans, blend, n>28?2:1, 0, 0);
        }
      }
    }
    render() {
      this.renderSeq = (this.renderSeq | 0) + 1;
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
