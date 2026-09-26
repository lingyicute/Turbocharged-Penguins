// npm install --no-save playwright; npx playwright install chromium
// Serve parent directory on :8000; URL and output prefix are configurable.
const {chromium} = require('playwright');
const fs = require('node:fs');
(async () => {
 const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
 const page = await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:2});
 const errors=[]; page.on('pageerror', e=>errors.push(e.message));
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 await page.addInitScript(()=>{
   let seed=42; Math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
   window.bench={long:[],renders:[],first:0};
   new PerformanceObserver(l=>bench.long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
   let Renderer;
   Object.defineProperty(window,'OriginalArtRenderer',{configurable:true,get:()=>Renderer,set(C){
     Renderer=C; const render=C.prototype.render;
     C.prototype.render=function(...args){const t=performance.now();try{return render.apply(this,args);}finally{bench.renders.push({start:t,duration:performance.now()-t});if(!bench.first)bench.first=performance.now();}};
   }});
 });
 await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
 await page.goto(process.argv[2]||'http://localhost:8000/baseline/index.html');
 await page.waitForFunction(()=>!!window.TurboPenguins);
 await page.locator('canvas#game').click();
 await page.waitForTimeout(10000);
 const {profile}=await cdp.send('Profiler.stop');
 const result=await page.evaluate(()=>({...bench,mode:TurboPenguins.mode,frame:TurboPenguins.rootFrame,pixels:game.width*game.height,rasters:TurboPenguins.renderer.rasters.size}));
 result.long=result.long.filter(e=>e.start<10000);
 result.renders=result.renders.filter(e=>e.start<10000);
 const sorted=result.renders.map(e=>e.duration).sort((a,b)=>a-b);
 result.summary={firstRender:result.first,renders:sorted.length,renderTotal:sorted.reduce((a,b)=>a+b,0),renderP95:sorted[Math.floor(sorted.length*.95)],renderMax:sorted.at(-1),longTasks:result.long.length,blocking:result.long.reduce((a,b)=>a+Math.max(0,Math.min(b.duration,10000-b.start)-50),0),errors};
 const prefix=process.argv[3]||'/home/user/before';
 fs.writeFileSync(prefix+'.json',JSON.stringify(result,null,2));
 fs.writeFileSync(prefix+'-profile.json',JSON.stringify(profile));
 const counts={}; for(const id of profile.samples||[]) {const n=profile.nodes.find(n=>n.id===id);const k=n.callFrame.functionName||'(anonymous)';counts[k]=(counts[k]||0)+1;}
 console.log(result.summary, Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,25));
 await page.screenshot({path:prefix+'.png'}); await browser.close();
})();
