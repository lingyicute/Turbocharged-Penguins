// Compare deterministic frames to an unmodified checkout, at equal resolution.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 const pages=[];
 for(const url of process.argv.slice(2)) {
  const page=await browser.newPage({viewport:{width:620,height:360}});
  await page.addInitScript(()=>{window.requestAnimationFrame=()=>0; let seed=42; Math.random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);});
  await page.goto(url); await page.waitForFunction(()=>!!window.TurboPenguins);
  await page.evaluate(()=>{const a=TurboPenguins;a.audio.unlocked=true;a.audio.update=()=>{};a.audio.effect=()=>{};a.audio.playIntroSting=()=>{};});
  pages.push(page);
 }
 assert.equal(pages.length,2,'pass baseline URL and optimized URL');
 for(let tick=0;tick<240;tick++) {
  const states=[];
  for(const page of pages) states.push(await page.evaluate(tick=>{
   const a=TurboPenguins;
   if(tick===75) a.continueIntro();
   a.now=tick*1000/36; a.advanceFrame(); a.renderer.render();
   return {root:a.rootFrame,mode:a.mode,clips:[...a.timeline.clips.values()].map(c=>[c.path,c.frame,c.playing]),stack:a.renderer.ctx._savedMatrices.length};
  },tick));
  assert.deepEqual(states[0],states[1],`timeline/stack tick ${tick}`);
  if([0,15,35,60,90,120,180,239].includes(tick)) {
   const images=[];
   for(const page of pages) images.push(await page.evaluate(()=>Array.from(TurboPenguins.renderer.ctx.getImageData(0,0,620,360).data)));
   let sum=0,big=0; for(let i=0;i<images[0].length;i++){const d=Math.abs(images[0][i]-images[1][i]);sum+=d;if(d>16)big++;}
   const mean=sum/images[0].length, fraction=big/images[0].length;
   console.log({tick,root:states[0].root,meanAbsoluteChannelError:mean,largeErrorFraction:fraction});
   assert.ok(mean<1 && fraction<0.01,'only minor mask-edge antialiasing differences allowed');
  }
 }
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
