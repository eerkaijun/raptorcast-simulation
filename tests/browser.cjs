const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
  fs.mkdirSync('test-results',{recursive:true});
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100},offline:true});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
    await page.clock.install();
    await page.goto(pathToFileURL(path.resolve('simulation.html')).href);
    await page.clock.runFor(100);
    await page.waitForFunction(()=>window.raptorSimulation?.run);
    assert.equal(await page.locator('#error').isVisible(),false);
    assert.equal(await page.getByText('Uniform',{exact:false}).count(),0);
    assert.equal(await page.locator('#size, #bandwidth, #coding, #assumptions, #node-details, #clock, #seed, #new-sample').count(),0);
    assert.equal(await page.evaluate(()=>raptorSimulation.run.config.uploadMbps),1000);
    assert.equal(await page.evaluate(()=>raptorSimulation.run.config.proposalBytes),65536);
    assert.equal(await page.evaluate(()=>document.fonts.check('16px Satoshi')),true);
    const baseline=await page.evaluate(()=>({last:raptorSimulation.run.lastDecode,packets:raptorSimulation.run.packets.length,decoded:raptorSimulation.run.decoded}));
    async function assertCompletionTimes(finished){
      const expected=await page.evaluate(finished=>{
        const r=raptorSimulation.run,t=raptorSimulation.time;
        return [[r.vds,r.vTotal],[r.fds,r.fTotal]].map(([times,total])=>times.length===total&&times.at(-1)<=t?`${times.at(-1).toFixed(1)} ms`:finished?'Incomplete':'In progress');
      },finished);
      assert.equal(await page.locator('#validator-time').innerText(),expected[0]);
      assert.equal(await page.locator('#fullnode-time').innerText(),expected[1]);
    }
    assert.equal(await page.locator('#validator-time').innerText(),'In progress');
    assert.equal(await page.locator('#fullnode-time').innerText(),'In progress');
    const midway=await page.evaluate(()=>{
      const r=raptorSimulation.run;
      return (r.vds.at(-1)+r.fds.at(-1))/2;
    });
    await page.clock.runFor(Math.ceil(await page.evaluate(midway=>(midway-raptorSimulation.time)*12,midway)));
    await assertCompletionTimes(false);
    assert.match(await page.locator('#validator-time').innerText(),/ ms$/);
    assert.equal(await page.locator('#fullnode-time').innerText(),'In progress');
    await page.clock.runFor(8000);
    assert.equal(await page.locator('#validators').innerText(),'15 / 15');assert.equal(await page.locator('#fullnodes').innerText(),'48 / 48');
    await assertCompletionTimes(true);
    assert.equal(await page.locator('#caption').innerText(),'');
    await page.screenshot({path:'test-results/desktop.png',fullPage:true});
    await page.locator('#replay').click();await page.clock.runFor(100);
    assert.ok(await page.evaluate(()=>raptorSimulation.time<20));
    assert.equal(await page.locator('#validator-time').innerText(),'In progress');
    assert.equal(await page.locator('#fullnode-time').innerText(),'In progress');
    assert.deepEqual(await page.evaluate(()=>({last:raptorSimulation.run.lastDecode,packets:raptorSimulation.run.packets.length,decoded:raptorSimulation.run.decoded})),baseline);
    await page.locator('#pause').click();const paused=await page.evaluate(()=>raptorSimulation.time);await page.clock.runFor(1000);assert.equal(await page.evaluate(()=>raptorSimulation.time),paused);
    await page.locator('#pause').click();await page.clock.runFor(200);assert.ok(await page.evaluate(()=>raptorSimulation.time)>paused);
    async function change(action){const rev=await page.evaluate(()=>raptorSimulation.revision);await action();await page.clock.runFor(100);await page.waitForFunction(rev=>raptorSimulation.revision>rev,rev);}
    const results=[];
    for(const leader of [0,6,14])for(const loss of [0,.1,.2,.3]){
      if(await page.locator(`[data-leader="${leader}"]`).getAttribute('aria-pressed')!=='true')await change(()=>page.locator(`[data-leader="${leader}"]`).click());
      if(await page.locator(`[data-loss="${loss}"]`).getAttribute('aria-pressed')!=='true')await change(()=>page.locator(`[data-loss="${loss}"]`).click());
      const r=await page.evaluate(()=>({leader:raptorSimulation.run.config.leader,loss:raptorSimulation.run.config.loss,v:raptorSimulation.run.vds.length,f:raptorSimulation.run.fds.length,end:raptorSimulation.run.end}));
      assert.equal(r.leader,leader);assert.equal(r.loss,loss);assert.equal(await page.evaluate(()=>raptorSimulation.run.config.seed),1);if(loss===0){assert.equal(r.v,15);assert.equal(r.f,48);}
      await page.clock.runFor(Math.ceil(r.end*12+100));
      assert.equal(await page.locator('#validators').innerText(),`${r.v} / 15`);assert.equal(await page.locator('#fullnodes').innerText(),`${r.f} / 48`);
      await assertCompletionTimes(true);
      results.push(r);
    }
    assert.equal(await page.locator('#previous').isVisible(),true);
    await page.screenshot({path:'test-results/loss.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/mobile.png',fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile has no horizontal overflow');
    assert.equal(errors.length,0,errors.join('\n'));assert.deepEqual(requests,[],'standalone page makes no network requests');
    fs.writeFileSync('test-results/browser.json',JSON.stringify({cases:results,errors,networkRequests:requests,checks:['offline file load','all 12 leader/loss choices','animation completion','independent group reconstruction times','incomplete group status','replay','pause','ghost comparison','fixed 1000 Mbps and 64 KiB','removed controls and details','removed animation clock','fixed seed','mobile overflow']},null,2));
    console.log('PASS: offline Chromium; all remaining controls, fixed settings, 12 scenarios, group reconstruction times, completion counters, replay/pause, desktop/mobile screenshots; no JS errors or network requests.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
