const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');

(async()=>{
  fs.mkdirSync('test-results',{recursive:true});
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1440,height:1100},hasTouch:true,offline:true});
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
    await page.clock.install();
    await page.goto(pathToFileURL(path.resolve('drawing.html')).href);
    await page.clock.runFor(100);
    assert.equal(await page.locator('#error').isVisible(),false);
    assert.equal(await page.locator('#next').isDisabled(),true);
    assert.equal(await page.locator('#loss-controls, #map').count(),0);
    await page.locator('#clear').click();
    await page.getByRole('button',{name:'Purple',exact:true}).click();
    const box=await page.locator('#drawing').boundingBox();
    await page.mouse.move(box.x+box.width*.2,box.y+box.height*.8);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.5,box.y+box.height*.2,{steps:12});
    await page.mouse.move(box.x+box.width*.8,box.y+box.height*.8,{steps:12});
    await page.mouse.move(box.x+box.width*.2,box.y+box.height*.8,{steps:12});await page.mouse.up();
    const pixels=()=>page.evaluate(()=>Array.from(document.getElementById('drawing').getContext('2d').getImageData(0,0,128,128).data));
    const original=await pixels();assert.ok(original.some(v=>v!==255));
    async function encode(){await page.locator('#encode').click();await page.clock.runFor(100);assert.equal(await page.locator('.chunk').count(),160);}
    async function verifyRecovery(){
      assert.equal(await page.evaluate(()=>drawingSimulation.state.done),true);
      assert.equal(await page.locator('#recovery-placeholder').isVisible(),false);
      assert.equal(await page.locator('#verified').innerText(),'Pixel-for-pixel match verified');
      assert.equal(await page.evaluate(()=>{
        const source=document.getElementById('drawing').getContext('2d').getImageData(0,0,128,128).data;
        const result=document.getElementById('recovered').getContext('2d').getImageData(0,0,128,128).data;
        return source.every((v,i)=>v===result[i]);
      }),true);
      assert.ok(await page.evaluate(()=>drawingSimulation.state.unique<160));
    }
    await encode();
    await page.locator('#drawing').scrollIntoViewIfNeeded();
    const activeBox=await page.locator('#drawing').boundingBox();
    await page.mouse.move(activeBox.x+30,activeBox.y+30);await page.mouse.down();
    const encodedSnapshot=await pixels();
    await page.locator('#encode').evaluate(button=>button.click());await page.clock.runFor(100);
    await page.mouse.move(activeBox.x+100,activeBox.y+30,{steps:5});await page.mouse.up();
    assert.deepEqual(await pixels(),encodedSnapshot,'an active stroke must not change an encoded snapshot');
    const order=await page.evaluate(()=>drawingSimulation.state.order);
    await page.locator('#skip').click();
    assert.equal(await page.evaluate(id=>drawingSimulation.state.states[id],order[0]),'skipped');
    assert.equal(await page.evaluate(()=>drawingSimulation.state.unique),0);
    await page.locator('#chunk-'+order[1]).click();
    assert.equal(await page.evaluate(()=>drawingSimulation.state.unique),1);
    await page.locator('#chunk-'+order[1]).click();
    assert.equal(await page.evaluate(()=>drawingSimulation.state.unique),1);
    await page.locator('#play').click();await page.clock.runFor(600);await page.locator('#play').click();
    const paused=await page.evaluate(()=>drawingSimulation.state.unique);
    await page.clock.runFor(1000);assert.equal(await page.evaluate(()=>drawingSimulation.state.unique),paused);
    await page.locator('#play').click();await page.clock.runFor(30000);
    await verifyRecovery();
    assert.equal(await page.evaluate(id=>drawingSimulation.state.states[id],order[0]),'skipped');
    assert.equal(await page.locator('#restart, #status').count(),0);
    assert.doesNotMatch(await page.locator('main').innerText(),/encoded bytes|KiB|Brightness shows/);
    for(const [width,height] of [[1440,900],[1366,768],[1280,720],[1024,600]]){
      await page.setViewportSize({width,height});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight),'outer page fits viewport');
      assert.ok(await page.locator('.pipeline').evaluate(el=>el.scrollHeight<=el.clientHeight),'desktop controls fit without scrolling');
    }
    await page.setViewportSize({width:1366,height:768});
    await page.screenshot({path:'test-results/drawing-desktop.png',fullPage:true});
    await encode();
    assert.equal(await page.evaluate(()=>drawingSimulation.state.unique),0);
    assert.equal(await page.locator('#recovery-placeholder').isVisible(),true);
    assert.deepEqual(await page.evaluate(()=>drawingSimulation.state.order),order);
    await page.locator('#shuffle').click();
    assert.notDeepEqual(await page.evaluate(()=>drawingSimulation.state.order),order);
    await page.locator('#play').click();await page.clock.runFor(30000);await verifyRecovery();
    await page.locator('#drawing').scrollIntoViewIfNeeded();
    const editBox=await page.locator('#drawing').boundingBox();
    await page.mouse.click(editBox.x+editBox.width*.5,editBox.y+editBox.height*.5);
    assert.equal(await page.evaluate(()=>drawingSimulation.state.encoded),false);
    assert.equal(await page.locator('#recovery-placeholder').isVisible(),true);
    assert.equal(await page.locator('.chunk').count(),0);
    await encode();await page.locator('#play').click();await page.clock.runFor(30000);await verifyRecovery();
    await page.setViewportSize({width:390,height:844});
    await page.locator('#clear').click();
    await page.locator('#drawing').scrollIntoViewIfNeeded();
    const mobileBox=await page.locator('#drawing').boundingBox();
    await page.touchscreen.tap(mobileBox.x+mobileBox.width/2,mobileBox.y+mobileBox.height/2);
    assert.ok((await pixels()).some(v=>v!==255));
    await page.locator('#example').click();
    await encode();await page.locator('#play').click();await page.clock.runFor(30000);await verifyRecovery();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight));
    await page.screenshot({path:'test-results/drawing-mobile.png',fullPage:true});
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    fs.writeFileSync('test-results/drawing-browser.json',JSON.stringify({errors,networkRequests:requests,checks:['mouse and touch drawing','160 real encoded chunks','skip and duplicate delivery','automatic delivery and pause','pixel-exact reconstruction','decoder reset','shuffled delivery','editing invalidates recovery','offline desktop and mobile']},null,2));
    console.log('PASS: drawing page; real pixel recovery, mouse/touch, skips, duplicates, shuffle/reset, pause, editing, offline desktop/mobile.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
