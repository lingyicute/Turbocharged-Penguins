const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
function renderer(window={}) {
 vm.runInNewContext(source('src/renderer.js'),{window});
 return {window,r:Object.create(window.OriginalArtRenderer.prototype)};
}
test('backing store follows display size and uncapped DPR, invalidating only on resize',()=>{
 const {window,r}=renderer({devicePixelRatio:3});
 r.canvas={width:620,height:360,getBoundingClientRect:()=>({width:1240,height:720})};
 r.rasters=new Map([['old',{}]]);r.rasterPixels=20;r.app={};
 r.handleResize();
 assert.equal(r.canvas.width,3720);assert.equal(r.canvas.height,2160);
 assert.equal(r.rasters.size,0);assert.equal(r.rasterPixels,0);assert.equal(r.app.forceRender,true);
 r.rasters.set('keep',{});r.handleResize();assert.equal(r.rasters.size,1);
 // Even large displays and high DPR must retain native backing resolution.
 window.devicePixelRatio=4;
 r.canvas.getBoundingClientRect=()=>({width:2480,height:1440});r.handleResize();
 assert.equal(r.canvas.width,9920);assert.equal(r.canvas.height,5760);
 window.devicePixelRatio=1.25;
 r.canvas.getBoundingClientRect=()=>({width:620,height:360});r.handleResize();
 assert.equal(r.canvas.width,775);assert.equal(r.canvas.height,450);
 window.devicePixelRatio=1;r.canvas.getBoundingClientRect=()=>({width:310,height:180});r.handleResize();
 assert.equal(r.canvas.width,310);assert.equal(r.canvas.height,180);
});
test('static raster keys ignore placement frame/ratio but morph keys retain their ratio',()=>{
 const {r,window}=renderer();const keys=[];
 r.strokes=()=>false;r.imagesReady=()=>true;r.getDeviceScale=()=>1;r.cxKey=()=>0;
 r.rasters={get:key=>{keys.push(key);return {c:{},minX:0,minY:0,w:1,h:1};}};
 const ctx={globalCompositeOperation:'source-over',save(){},restore(){},transform(){},drawImage(){}};
 for(const name of ['shape359','image33','morphshape1']) {
  window[name]=()=>{};
  r.tryBlit(name,ctx,[1,0,0,1,0,0],{},1,1,100);
  r.tryBlit(name,ctx,[1,0,0,1,0,0],{},1,2,200);
 }
 assert.equal(keys[0],keys[1]);assert.equal(keys[2],keys[3]);assert.notEqual(keys[4],keys[5]);
 ctx._floeMaskPathOnly=true;assert.equal(r.tryBlit('shape359',ctx,[],{},1,0,0),false);
});
const art=source('assets/f-art.js');
test('static export assumption used by raster keys remains valid',()=>{
 const matches=art.matchAll(/function ((?:shape|image)\d+)\(ctx,ctrans,frame,ratio,time\)\{([\s\S]*?)(?=\nfunction |$)/g);
 let count=0;for(const [,name,body] of matches){count++;assert.ok(!/\b(frame|ratio|time)\b/.test(body),name);}
 assert.ok(count>100);
});
test('all 38 floe frames traverse mask and content without full-stage scratch canvases',()=>{
 const start=art.indexOf('function sprite379');const end=art.indexOf('\nfunction ',start+10);
 let stack=0,clips=0,masks=0;
 const ctx={save(){stack++;},restore(){stack--;assert.ok(stack>=0);},clip(rule){assert.equal(rule,'evenodd');clips++;}};
 const scope={canvas:{},place(name,canvas,ctx){if(name==='sprite361'){assert.equal(ctx._floeMaskPathOnly,true);masks++;}else assert.ok(!ctx._floeMaskPathOnly);},createCanvas(){throw Error('full-stage mask allocation');}};
 vm.runInNewContext(art.slice(start,end),scope);
 const cx={merge(){return this;}};
 for(let frame=0;frame<38;frame++){scope.sprite379(ctx,cx,frame,0,0);assert.equal(stack,0);}
 assert.equal(clips,38);assert.equal(masks,38);
});

test("imagesReady caches completion on shape function once all referenced images are loaded", () => {
  const {r, window} = renderer();
  let completeReads = 0;
  window.imageObj1 = {
    get complete() { completeReads++; return true; },
    naturalWidth: 16
  };
  window.shapeWithImg = function() { return imageObj1; };
  assert.equal(r.imagesReady("shapeWithImg"), true);
  assert.equal(completeReads, 1);
  assert.equal(r.imagesReady("shapeWithImg"), true);
  assert.equal(completeReads, 1, "subsequent checks use cached _imgsReady flag");
});

test("localBounds stubs meter paint operations and passes identity cxform", () => {
  let fills = 0, tints = 0;
  const meterCtx = {
    _matrix: [1, 0, 0, 1, 0, 0],
    setTransform() {},
    fill() { fills++; },
    stroke() { fills++; },
    clip() { fills++; },
    fillRect() { fills++; }
  };
  const window = {ctrans: {isEmpty: () => true}, enhanceContext: c => c};
  const document = {createElement: () => ({width: 0, height: 0, getContext: () => meterCtx})};
  vm.runInNewContext(source("src/renderer.js"), {window, document});
  const r = Object.create(window.OriginalArtRenderer.prototype);
  window.shapeMeterTest = (ctx, cx) => {
    if (!cx.isEmpty()) tints++;
    ctx._localBox = {minX: 0, minY: 0, maxX: 10, maxY: 20, n: 2};
    ctx.fill();
    ctx.fillRect(-16384, -16384, 32768, 32768);
  };
  const b = r.localBounds("shapeMeterTest", 0, 0, {isEmpty: () => false});
  assert.equal(b.maxX, 10);
  assert.equal(fills, 0, "meter pass does not rasterize fills");
  assert.equal(tints, 0, "meter pass uses identity cxform");
  assert.equal(r.strokes("morphshape487"), true, "morphshape is excluded from static raster cache");
});
