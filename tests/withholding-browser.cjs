const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const S=require('../src/engine.js');
const scenario=require('../src/withholding-scenario.cjs').create(require('../src/topology.json'));
const codec=new S.Codec(fs.readFileSync('codec/target/wasm32-unknown-unknown/release/raptorcast_browser_codec.wasm'));

(async()=>{
  fs.mkdirSync('test-results',{recursive:true});
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100},offline:true});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
    await page.clock.install();
    await page.goto(pathToFileURL(path.resolve('withholding.html')).href);
    await page.clock.runFor(100);
    await page.waitForFunction(()=>window.raptorSimulation?.run);
    assert.equal(await page.locator('#error').isVisible(),false);
    assert.equal(await page.locator('#loss-controls, #lost, #seed, #clock').count(),0);
    assert.equal(await page.getByText('Lost packet',{exact:true}).count(),0);
    assert.equal(await page.locator('#withheld-chunks').innerText(),'0');
    assert.equal(await page.locator('[data-withholding="true"]').getAttribute('aria-pressed'),'true');
    async function change(action){
      const revision=await page.evaluate(()=>raptorSimulation.revision);
      await action();await page.clock.runFor(100);
      await page.waitForFunction(rev=>raptorSimulation.revision>rev,revision);
      assert.equal(await page.locator('#withheld-chunks').innerText(),'0');
    }
    const results=[];
    for(const leader of [0,6,14])for(const withholding of [true,false]){
      if(await page.locator(`[data-leader="${leader}"]`).getAttribute('aria-pressed')!=='true')await change(()=>page.locator(`[data-leader="${leader}"]`).click());
      const toggle=page.locator(`[data-withholding="${withholding}"]`);
      if(await toggle.getAttribute('aria-pressed')!=='true')await change(()=>toggle.click());
      const options={leader,withholdingValidator:withholding?scenario.validator:null};
      const expected=S.simulate(codec,scenario.topology,options);
      const actual=await page.evaluate(()=>({config:raptorSimulation.run.config,decoded:raptorSimulation.run.decoded,withheld:raptorSimulation.run.withheld}));
      assert.equal(actual.config.loss,0);
      assert.equal(actual.config.withholdingValidator,options.withholdingValidator);
      assert.deepEqual(actual.decoded,expected.decoded);
      assert.deepEqual(actual.withheld,expected.withheld);
      assert.equal(await page.locator('#previous').isVisible(),withholding);
      if(withholding){
        const baseline=S.simulate(codec,scenario.topology,{leader});
        assert.deepEqual(await page.evaluate(()=>raptorSimulation.comparison.decoded),baseline.decoded);
        assert.match(await page.locator('#previous').innerText(),/Forwarding baseline/);
      }
      await page.clock.runFor(Math.ceil(expected.end*12+100));
      assert.equal(await page.locator('#validators').innerText(),'15 / 15');
      assert.equal(await page.locator('#fullnodes').innerText(),'48 / 48');
      assert.equal(await page.locator('#validator-time').innerText(),`${expected.vds.at(-1).toFixed(1)} ms`);
      assert.equal(await page.locator('#fullnode-time').innerText(),`${expected.fds.at(-1).toFixed(1)} ms`);
      assert.equal(await page.locator('#withheld-chunks').innerText(),String(expected.withheld.length));
      const assigned=expected.messages[0].targets.filter(id=>id===scenario.validator).length;
      assert.equal(await page.locator('#assigned-chunks').innerText(),`${assigned} / ${expected.messages[0].targets.length}`);
      results.push({leader,withholding,validators:expected.vds.at(-1),fullnodes:expected.fds.at(-1),withheld:expected.withheld.length});
      if(leader===0&&withholding){
        await page.screenshot({path:'test-results/withholding-desktop.png',fullPage:true});
        await page.locator('#replay').click();await page.clock.runFor(100);
        assert.equal(await page.locator('#withheld-chunks').innerText(),'0');
        assert.equal(await page.locator('#validator-time').innerText(),'In progress');
        await page.locator('#pause').click();
        const time=await page.evaluate(()=>raptorSimulation.time);
        await page.clock.runFor(1000);assert.equal(await page.evaluate(()=>raptorSimulation.time),time);
        await page.locator('#pause').click();
      }
    }
    await change(()=>page.locator('[data-withholding="true"]').click());
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'test-results/withholding-mobile.png',fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    fs.writeFileSync('test-results/withholding-browser.json',JSON.stringify({cases:results,errors,networkRequests:requests},null,2));
    console.log('PASS: withholding page; six leader/behavior combinations, matched baselines, fixed zero loss, counters, replay/pause, offline and mobile.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
