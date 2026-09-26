/*
 * Physics - faithful to original AS1/2 logic
 * Original values from frame_1 DoAction_4.as initialise()
 */
(() => {
  'use strict';

  const W = 620, H = 360;
  // All sprite509 bonus icons are centered at (662, 662) in the exported art;
  // drawTiles() places the sprite at scale 0.05 using b.x/b.y as its origin.
  const BONUS_CENTER_OFFSET = 662 * 0.05;
  const rand = n => Math.floor(Math.random() * Math.max(1, n));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const CONFIG = Object.freeze({
    screenWidth: 620,
    screenHeight: 360,
    tileWidth: 630,
    cliffWidth: 79,
    cliffTileHeight: 445,
    farBgTileHeight: 725,
    parallaxRate: 0.75,
    maxCliffTiles: 28,
    defaultGravity: 0.6,
    softGravity: 0.2,
    minSpeed: -12,
    defaultHitSpeed: -4,
    turboDoneSpeed: -25,
    defaultScreenMove: 5.5,
    screenMoveChange: 0.75,
    screenMoveSlowdown: 2,
    screenXMoveRate: 5,
    maxPenguinDropSpeed: 12.5,
    boosterY: 10,
    penguinMaxRot: 20,
    rotSlowDown: 1.05,
    maxTurboSpeed: -40,
    blurSpeed: -35,
    turboSpeedUpRate: 0.75,
    turboSlowDownRate: 0.7,
    sustainPerTurbo: 4,
    gameOverLineY: 415.05,
    penguinHalfHeight: 37,
    turboMaxLineY: 282.05,
    sustainMinLineY: 57.5,
    speedUpMinLineY: -68,
    regMinLineY: -60
  });

  const PATH = Object.freeze({
    penguin: 'root/sprite568#0/sprite565#0',
    head: 'root/sprite568#0/sprite565#0/sprite294#0',
    wall: 'root/sprite5#0',
    pop: 'root/sprite7#0',
    snds: 'root/sprite382#0',
    expl: 'root/sprite569#0',
    pointer: 'root/sprite555#0',
    dummies: 'root/sprite579#0',
    dontFall: 'root/sprite578#0',
    turbos: 'root/sprite553#0',
    turboDisplay: 'root/sprite553#0/sprite550#0',
    best: 'root/sprite424#0/sprite423#0'
  });
  const cue = (g, item) => { (g.cues || (g.cues = [])).push(item); };
  const play = (g, path, frame = null, playing = true) => cue(g, {op: 'play', path, frame, playing});

  class Physics {
    static createInitialGame(selected) {
      return {
        x: 250 + (selected - 1) * 55,
        y: -70,
        vx: 0,
        vy: -2,
        rotation: 0,
        rotVelocity: 0,
        bgX: -10,
        bgY: -80,
        farX: 0,
        farY: 420,
        screenMove: CONFIG.defaultScreenMove,
        booster: 0,
        hit: false,
        regularSustained: false,
        turboSustained: false,
        turbo: false,
        turboDuration: 0,
        turboExit: 0,
        turbos: 0,
        turboClickedToggle: false,
        clickedBonus: false,
        score: 0,
        cm: 0,
        started: false,
        finalScore: '',
        tiles: new Map(),
        anim: null,
        animTicks: 0,
        pengFrame: 0,
        firstTurbo: true,
        pointerStatus: false,
        dontfallToggle: false,
        bestToggle: false,
        dummyX: 250 + (selected - 1) * 55 + 40,
        dummyY: -70,
        explX: null,
        explY: null,
        explOn: false,
        cues: []
      };
    }

    static ensureTiles(g) {
      const bottom = Math.floor(g.bgY / CONFIG.cliffTileHeight);
      for (let n = bottom; n <= bottom+1; n++) {
        if (g.tiles.has(n)) continue;
        const tile = {bonuses: []};
        g.tiles.set(n,tile);
        if (n > CONFIG.maxCliffTiles && !g.dontfallToggle) {
          g.dontfallToggle = true;
          play(g, PATH.dontFall, 2, true);
        }
        if (n <= 2) continue;
        let y = rand(300);
        while (y < CONFIG.cliffTileHeight) {
          let chance = 65;
          if (g.bgY > 20000) chance += (g.bgY-20000)/1000;
          if (rand(100) > chance) {
            let type = 1;
            if (rand(100)>92 && g.turbos >= 1) {
              const roll=rand(100);
              type=roll>96?5:roll>90?4:roll>70?3:2;
            }
            tile.bonuses.push({x:CONFIG.cliffWidth+rand(CONFIG.screenWidth-CONFIG.cliffWidth*2),y,type,collected:0});
          }
          y += 100 + rand(300);
        }
      }
      for (const n of g.tiles.keys())
        if (n < bottom-1 || n > bottom+2) g.tiles.delete(n);
    }

    static applyGravity(g) {
      let grav;
      if (!g.hit) {
        grav = CONFIG.softGravity;
        g.dummyX = g.x + 40;
        g.dummyY = g.y;
      } else {
        const minusGrav = (g.bgY - 10000) / 100000;
        grav = minusGrav <= 0 ? CONFIG.defaultGravity : Math.max(0.1, CONFIG.defaultGravity - g.bgY/100000);
      }
      if (!g.turbo) g.vy += grav;
      else if (g.turbo === 'speedup') {
        g.vy -= CONFIG.turboSpeedUpRate;
        if (g.vy <= CONFIG.maxTurboSpeed) { g.vy=CONFIG.maxTurboSpeed; g.turbo='sustain'; }
      } else if (g.turbo === 'sustain') {
        g.turboDuration--;
        if (g.turboDuration <= 0) { g.vx=0; g.turbo='slowdown'; }
      } else if (g.turbo === 'slowdown') {
        g.vy += CONFIG.turboSlowDownRate;
        if (g.vy > CONFIG.minSpeed + CONFIG.defaultHitSpeed) {
          g.vy=CONFIG.turboDoneSpeed; g.turbo=false;
        }
      }
    }

    static bonusStageCenter(g, n, b) {
      return {
        x: g.bgX + b.x + BONUS_CENTER_OFFSET,
        y: g.bgY - n * CONFIG.cliffTileHeight + b.y + BONUS_CENTER_OFFSET
      };
    }

    static hitTests(g, audio) {
      const inCliff = Math.floor((g.bgY - g.y) / CONFIG.cliffTileHeight) <= CONFIG.maxCliffTiles;
      // A wall hit plays sound 3 now and sound 4 seven frames later.
      if (inCliff && g.x < 54 && g.vx < 0) {
        g.x=54; g.vx=-g.vx*2;
        play(g, PATH.wall, 2, true);
      }
      if (inCliff && g.x > W-54 && g.vx > 0) {
        g.x=W-54; g.vx=-g.vx*2;
        play(g, PATH.wall, 2, true);
      }
      for (const [n,tile] of g.tiles) {
        const nTileY = g.bgY - n * CONFIG.cliffTileHeight;
        for (const b of tile.bonuses) {
          if (b.collected) continue;
          const bx = g.bgX + b.x + BONUS_CENTER_OFFSET;
          const by = nTileY + b.y + BONUS_CENTER_OFFSET;
          const dx=(g.x-bx)/36, dy=(g.y-by)/48;
          if (g.y>-10 && dx*dx+dy*dy<1) {
            Physics.collectBonus(b, g, audio);
          }
        }
      }
    }

    static collectBonus(b, g, audio, now=0) {
      if (b.collected) return;
      b.collected=now || performance.now();
      g.clickedBonus=true;
      if (!g.turboClickedToggle) g.turboClickedToggle=true;
      g.turbos = b.type === 1 ? g.turbos+1 : g.turbos*b.type;
      play(g, PATH.turbos, null, true);
      play(g, PATH.turboDisplay, null, true);
      if (b.visualPath) play(g, b.visualPath, null, true);
      if (b.clickmePath) play(g, b.clickmePath, null, true);
      if (b.buttPath) play(g, b.buttPath, 2, false);
      // Multiplier bonuses keep their collect sound on a child that leaves
      // the stage when the burst starts, so the chime is played directly.
      // Type 1's burst also carries sound 300; the direct play covers both.
      if (audio) audio.effect(300, 0.7);
    }

    static movePenguin(g) {
      g.vy=Math.min(g.vy,CONFIG.maxPenguinDropSpeed);
      if (g.booster>0) {g.y -= g.booster; g.booster=Math.max(0,g.booster-0.25);}
      if (g.turbo === 'sustain') g.vx=(Physics._pointerX-g.x)/10;
      g.x+=g.vx;
      g.y+=g.vy;

      let minPoint=false, maxPoint=false;
      if (g.turbo) {
        maxPoint=CONFIG.turboMaxLineY;
        if (g.turbo==='sustain' && !g.turboSustained && g.y>CONFIG.sustainMinLineY)
          g.turboSustained=true;
        if (g.turbo==='speedup') {g.screenMove+=CONFIG.screenMoveChange;minPoint=CONFIG.speedUpMinLineY;}
        else if (g.turbo==='sustain') {
          if (g.turboSustained) minPoint=CONFIG.sustainMinLineY;
          else {g.screenMove+=CONFIG.screenMoveChange;minPoint=CONFIG.speedUpMinLineY;}
        } else if (g.turbo==='slowdown') {
          g.screenMove=Math.max(CONFIG.defaultScreenMove,g.screenMove-CONFIG.screenMoveSlowdown);
          if (!g.turboSustained) g.screenMove+=CONFIG.screenMoveChange;
        }
      } else {
        if (g.regularSustained) minPoint=CONFIG.regMinLineY;
        else if (g.y>CONFIG.sustainMinLineY) g.regularSustained=true;
        g.screenMove=CONFIG.defaultScreenMove;
      }
      g.y+=g.screenMove;
      g.bgY+=g.screenMove;
      g.farY+=g.screenMove*CONFIG.parallaxRate;
      const newCm=Math.round(g.bgY-g.y)+500;
      g.cm=Math.max(500,g.cm,newCm);
      let adjust=0;
      if (minPoint!==false && g.y<minPoint) {
        adjust=minPoint-g.y;
        g.screenMove=-g.vy+CONFIG.screenMoveChange*4;
      } else if (maxPoint!==false && g.y>maxPoint) {
        adjust=maxPoint-g.y;
        g.screenMove=-g.vy-CONFIG.screenMoveChange*4;
      }
      if (adjust) {g.y+=adjust;g.bgY+=adjust;g.farY+=adjust*CONFIG.parallaxRate;}
      let aim=-g.vx;
      if (g.bgX+aim>0) aim=-g.bgX;
      if (g.bgX+aim<W-CONFIG.tileWidth) aim=W-CONFIG.tileWidth-g.bgX;
      const move=aim/CONFIG.screenXMoveRate;
      g.x+=move;g.bgX+=move;g.farX+=move*CONFIG.parallaxRate;
      if (!g.turbo) {g.rotVelocity/=CONFIG.rotSlowDown;g.rotation+=g.rotVelocity;}

      if (g.y < -30 && !g.pointerStatus) {
        g.pointerStatus = true;
        play(g, PATH.pointer, null, true);
      } else if (g.pointerStatus && g.y > 0) {
        g.pointerStatus = false;
        play(g, PATH.pointer, null, true);
      }
      const best = window.TurboPenguins?.storedBest ?? 0;
      if (g.cm > best && !g.bestToggle) {
        g.bestToggle = true;
        play(g, PATH.best, 2, true);
      } else if (best > 0 && g.cm < best && g.bestToggle) {
        g.bestToggle = false;
        play(g, PATH.best, 6, true);
      }
    }

    static checkEnd(g) {
      if (!g.started && g.y-CONFIG.penguinHalfHeight < H) g.started=true;
      if (g.started && (g.y-CONFIG.penguinHalfHeight > CONFIG.gameOverLineY || g.x < -30 || g.x > W+30))
        return true;
      return false;
    }

    static clickPenguin(g, clickX, clickY, audio) {
      if (!g) return;
      // Button always squeaks, even in turbo. The bounce itself does not.
      if (!g.hitWas) {
        g.hitWas = true;
        play(g, PATH.dummies, 5, true);
      }
      g.hit = true;
      play(g, PATH.head, 2, true);
      // One of 11 squeaks, chosen at random. Each frame stops, so this is a single hit.
      play(g, PATH.snds, 2 + rand(11), true);
      play(g, PATH.pop, 2, true);
      if (g.turbo) return;
      // penguin._height is the visible clip (~74), not the hit shape.
      // The 10% stays on this divisor only; missed clicks were the hit rect.
      const h=Math.hypot(g.x-clickX,g.y-clickY), pct=h/(74/2*1.1);
      g.vy=CONFIG.minSpeed + pct*CONFIG.defaultHitSpeed;
      g.booster=CONFIG.boosterY;
      const randomness=30+Math.round(g.bgY/750);
      const sensitivity=Math.max(1,5-Math.round(g.bgY/750)/10);
      const maxX=randomness/10;
      g.vx=clamp((g.x-clickX)/sensitivity+(rand(randomness)-randomness/2)/10,-maxX,maxX);
      g.rotVelocity=CONFIG.penguinMaxRot*(g.vx/3);
      if (g.anim == null || Math.random() * 100 > 50) g.anim = rand(12) + 1;
      g.animTicks = 0;
      const label = window.PENGUIN_LABEL_FRAME?.[g.anim] || 1;
      play(g, PATH.penguin, label, true);
    }

    static useTurbos(g, audio) {
      if (!g || g.turbos<=0) return false;
      g.vy=CONFIG.minSpeed + CONFIG.defaultHitSpeed;
      if (g.turbos>1) {
        g.booster=CONFIG.boosterY;
        g.turbo='speedup';
        g.anim='blur';
        g.animTicks=0;
        g.turboDuration=g.turbos*2*CONFIG.sustainPerTurbo;
        g.rotation=0;g.vx=0;
        g.turboSustained=false;g.regularSustained=false;
        // blur frame 201 places and plays the explosion; its own frames carry 308/417/315/401.
        play(g, PATH.penguin, 201, true);
      } else {
        g.vy*=2;
      }
      g.turbos=0;g.turboExit=12;
      play(g, PATH.turbos, null, true);
      play(g, PATH.turboDisplay, null, true);
      return true;
    }
  }

  Physics.CONFIG = CONFIG;
  Physics._pointerX = W/2;
  window.Physics = Physics;
})();
