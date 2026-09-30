const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');process.chdir(root);
const lock=JSON.parse(fs.readFileSync('codec/upstream-lock.json','utf8'));
for(const [file,expected] of Object.entries(lock.files)){
  const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join('../monad-bft',file))).digest('hex');
  if(actual!==expected)throw new Error(`Upstream changed: ${file}. Review the protocol model and differential checks before updating codec/upstream-lock.json.`);
}
execFileSync('cargo',['+1.97.1','build','--locked','--lib','--release','--target','wasm32-unknown-unknown','--manifest-path','codec/Cargo.toml'],{stdio:'inherit'});
const read=p=>fs.readFileSync(p,'utf8');
const wasm=fs.readFileSync('codec/target/wasm32-unknown-unknown/release/raptorcast_browser_codec.wasm');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const topology=JSON.parse(read('src/topology.json'));
const scenario=require('../src/withholding-scenario.cjs').create(topology);
const outputs={};
function embedAssets(html){
  for(const file of fs.readdirSync('src/assets')){
    const mime=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'font/otf';
    html=html.replaceAll('{{'+file+'}}','data:'+mime+';base64,'+fs.readFileSync('src/assets/'+file).toString('base64'));
  }
  return html;
}
for(const withholding of [false,true]){
  const data={topology:withholding?scenario.topology:topology,wasm:wasm.toString('base64')};
  if(withholding)data.withholding={validator:scenario.validator,stakePercent:scenario.stakePercent};
  let html=embedAssets(read('src/page.html')).replace(/\{\{#NETWORK\}\}([\s\S]*?)\{\{\/NETWORK\}\}/g,(_,content)=>withholding?'':content);
  const values={DATA:JSON.stringify(data),ENGINE:read('src/engine.js'),UI:read('src/ui.js'),
    TITLE:withholding?'Validator withholding simulation':'Network topology simulation',
    SCENARIO_STYLE:withholding?read('src/withholding.css'):'',
    SCENARIO_CONTROLS:withholding?read('src/withholding-controls.html'):'',
    SCENARIO_LEGEND:withholding?'<span><i class="withholding-ring"></i>London · 20% stake</span>':''};
  html=html.replace(/\{\{(\w+)\}\}/g,(_,name)=>{
    if(!(name in values))throw new Error('Unknown template marker: '+name);
    return values[name].replace(/<\/script/gi,'<\\/script');
  });
  const filename=withholding?'withholding.html':'simulation.html';
  fs.writeFileSync(filename,html);outputs[filename]=hash(html);
  console.log(`Built ${filename} (${Math.round(Buffer.byteLength(html)/1024)} KiB).`);
}
const drawingValues={WASM:JSON.stringify(wasm.toString('base64')),DRAWING_CODEC:read('src/drawing-codec.js'),DRAWING_UI:read('src/drawing-ui.js')};
const drawingHtml=embedAssets(read('src/drawing-page.html')).replace(/\{\{(\w+)\}\}/g,(_,name)=>{
  if(!(name in drawingValues))throw new Error('Unknown template marker: '+name);
  return drawingValues[name].replace(/<\/script/gi,'<\\/script');
});
fs.writeFileSync('drawing.html',drawingHtml);outputs['drawing.html']=hash(drawingHtml);
console.log(`Built drawing.html (${Math.round(Buffer.byteLength(drawingHtml)/1024)} KiB).`);
const files=['src/engine.js','src/ui.js','src/page.html','src/withholding-scenario.cjs','src/withholding-controls.html','src/withholding.css','src/drawing-codec.js','src/drawing-ui.js','src/drawing-page.html','codec/lib.rs','../monad-bft/monad-raptorcast/src/packet/assigner.rs','../monad-bft/monad-raptorcast/src/packet/deterministic.rs','../monad-bft/monad-raptorcast/src/decoding.rs'];
function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);if(fs.statSync(p).isDirectory())walk(p);else if(p.endsWith('.rs'))files.push(p);}}
walk('../monad-bft/monad-raptor/src');
const manifest={monadCommit:execFileSync('git',['-C','../monad-bft','rev-parse','HEAD'],{encoding:'utf8'}).trim(),wasmSha256:hash(wasm),htmlSha256:outputs['simulation.html'],outputs,sources:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(f))]))};
fs.writeFileSync('src/build-manifest.json',JSON.stringify(manifest,null,2)+'\n');
