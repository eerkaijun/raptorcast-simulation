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
const data={topology:JSON.parse(read('src/topology.json')),wasm:wasm.toString('base64')};
let html=read('src/page.html');
for(const file of fs.readdirSync('src/assets')){
  const mime=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'font/otf';
  html=html.replaceAll('{{'+file+'}}','data:'+mime+';base64,'+fs.readFileSync('src/assets/'+file).toString('base64'));
}
const values={DATA:JSON.stringify(data),ENGINE:read('src/engine.js'),UI:read('src/ui.js')};
html=html.replace(/\{\{(DATA|ENGINE|UI)\}\}/g,(_,name)=>values[name].replace(/<\/script/gi,'<\\/script'));
if(/\{\{\w+\}\}/.test(html))throw new Error('Unexpanded template marker');
fs.writeFileSync('RaptorCast Simulation.html',html);
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=['src/engine.js','codec/lib.rs','../monad-bft/monad-raptorcast/src/packet/assigner.rs','../monad-bft/monad-raptorcast/src/packet/deterministic.rs','../monad-bft/monad-raptorcast/src/decoding.rs'];
function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);if(fs.statSync(p).isDirectory())walk(p);else if(p.endsWith('.rs'))files.push(p);}}
walk('../monad-bft/monad-raptor/src');
const manifest={monadCommit:execFileSync('git',['-C','../monad-bft','rev-parse','HEAD'],{encoding:'utf8'}).trim(),wasmSha256:hash(wasm),htmlSha256:hash(html),sources:Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(f))]))};
fs.writeFileSync('src/build-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(`Built standalone HTML (${Math.round(Buffer.byteLength(html)/1024)} KiB), embedded WASM (${Math.round(wasm.length/1024)} KiB).`);
