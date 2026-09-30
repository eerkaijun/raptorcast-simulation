const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {execFileSync}=require('node:child_process');
const S=require('../src/engine.js'),topology=require('../src/topology.json');
const wasm=fs.readFileSync('codec/target/wasm32-unknown-unknown/release/raptorcast_browser_codec.wasm');
const codec=new S.Codec(wasm), nodes=new Map(topology.nodes.map(n=>[n.id,n]));
const key=p=>[p.kind,p.publisher,p.from,p.to,p.esi].join('/');
const cases=[], nativeLines=[], nativeExpected=new Map();

function invariants(r,nodeMap=nodes){
  const streams=new Map(r.streams.map(s=>[`${s.message}/${s.node}`,s]));
  const queues=new Map(),firstHops=new Map(),delivered=new Map();
  for(const p of r.packets){
    assert.ok(p.start>=p.ready && p.txEnd>p.start && p.arrive>=p.txEnd);
    assert.ok(Math.abs(p.txEnd-p.start-p.bytes*8/(r.config.uploadMbps*1000))<1e-9);
    if(!queues.has(p.from))queues.set(p.from,[]);queues.get(p.from).push(p);
    const m=r.messages[p.message];
    if(p.kind===0||p.kind===2){
      assert.equal(p.to,m.targets[p.esi]);assert.equal(p.from,m.publisher);
      if(!p.lost)firstHops.set(`${p.message}/${p.to}/${p.esi}`,p);
    }else{
      assert.equal(p.from,m.targets[p.esi]);assert.notEqual(p.to,p.from);assert.notEqual(p.to,m.publisher);
      const parent=firstHops.get(`${p.message}/${p.from}/${p.esi}`);assert.ok(parent,'no forwarding of lost first-hop packet');assert.ok(p.ready>=parent.arrive);
    }
    if(!p.lost){const k=`${p.message}/${p.to}`;if(!delivered.has(k))delivered.set(k,[]);delivered.get(k).push([p.arrive,p.esi]);}
  }
  for(const q of queues.values()){
    q.sort((a,b)=>a.start-b.start);for(let i=1;i<q.length;i++)assert.ok(q[i].start>=q[i-1].txEnd,'shared node upload has no overlap');
  }
  for(const s of r.streams){
    const expected=(delivered.get(`${s.message}/${s.node}`)||[]).sort((a,b)=>a[0]-b[0]);
    assert.deepEqual(s.arrivals.map(a=>[a.time,a.esi]),expected);
    assert.equal(new Set(s.arrivals.map(a=>a.esi)).size,s.arrivals.length);
    if(Number.isFinite(s.decodedAt)){assert.ok(s.arrivals.some(a=>a.time===s.decodedAt));assert.ok(s.arrivals.filter(a=>a.time<=s.decodedAt).length>=s.k);}
    if(!s.primary){assert.ok(s.arrivals.every(a=>a.time>=r.publications[s.publisher]));}
  }
  for(const m of r.messages){
    if(!m.primary){assert.ok(r.decoded[m.publisher]!==undefined);assert.ok(m.at>=r.decoded[m.publisher]+(m.publisher===r.config.leader?0:r.config.publicationDelayMs));}
    const symbolIds=new Set(r.packets.filter(p=>p.message===m.id&&(p.kind===0||p.kind===2)).map(p=>p.esi));
    assert.equal(symbolIds.size,m.targets.length);
    if(m.primary){
      const members=m.order.map(id=>nodeMap.get(id)),total=members.reduce((s,n)=>s+n.stake,0);
      for(const n of members)assert.equal(m.targets.filter(id=>id===n.id).length,Math.ceil(m.coding.scaled*n.stake/total));
    }else for(let i=0;i<m.targets.length;i++)assert.equal(m.targets[i],m.order[i%m.order.length]);
  }
  for(const n of topology.nodes){
    if(n.id===r.config.leader)continue;
    const times=r.streams.filter(s=>s.node===n.id&&Number.isFinite(s.decodedAt)).map(s=>s.decodedAt);
    assert.equal(r.decoded[n.id],times.length?Math.min(...times):undefined);
  }
  assert.equal(r.counters.verifiedReconstructions,r.streams.filter(s=>Number.isFinite(s.decodedAt)).length);
  assert.equal(r.failed,r.vTotal+r.fTotal-r.vds.length-r.fds.length);
}

test('all 108 UI parameter combinations: recovery, routing, loss and shared queues',()=>{
  for(const proposalBytes of [32768,65536,131072])for(const uploadMbps of [20,100,1000])for(const leader of [0,6,14])for(const loss of [0,.1,.2,.3]){
    const r=S.simulate(codec,topology,{proposalBytes,uploadMbps,leader,loss});invariants(r);
    if(loss===0){assert.equal(r.vds.length,15);assert.equal(r.fds.length,48);assert.equal(r.lossTimes.length,0);}
    cases.push({proposalBytes,uploadMbps,leader,loss,validators:r.vds.length,fullnodes:r.fds.length,lastDecode:r.lastDecode,packets:r.packets.length});
    if(uploadMbps===100)for(const s of r.streams){
      const name=`${proposalBytes}/${leader}/${loss}/${s.message}/${s.node}`,m=r.messages[s.message];
      nativeLines.push([name,proposalBytes,m.coding.symbolBytes,s.n,r.config.seed,...s.arrivals.map(a=>a.esi)].join(' '));
      nativeExpected.set(name,Number.isFinite(s.decodedAt)?s.arrivals.findIndex(a=>a.time===s.decodedAt)+1:0);
    }
  }
  fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/scenarios.json',JSON.stringify(cases,null,2));
});

test('native Rust and WASM agree on every replayed decode and reconstructed bytes',()=>{
  const output=execFileSync('cargo',['+1.97.1','run','--locked','--quiet','--release','--manifest-path','codec/Cargo.toml','--bin','native-check'],{input:nativeLines.join('\n')+'\n',encoding:'utf8',maxBuffer:16*1024*1024});
  let count=0;for(const line of output.trim().split('\n')){const [name,at]=line.split(' ');assert.equal(Number(at),nativeExpected.get(name),name);count++;}
  assert.equal(count,nativeExpected.size);assert.ok(count>1500);
  fs.writeFileSync('test-results/native-replay.txt',`${count} streams: exact native/WASM agreement, every successful recovery byte-verified.\n`);
});

test('audited false-success regression, duplicate rejection, and stream isolation',()=>{
  codec.reset();const m=codec.message({bytes:768,symbolBytes:32},72,0),a=codec.receiver(m),b=codec.receiver(m);
  const ids=[4,17,0,30,1,2,9,7,10,12,50,20,26,18,24,22,27,29,31,32,67,35,39,45,52,56,60,57,63,62,64,68,70];
  for(const id of ids){assert.equal(codec.receive(a,id),0);assert.equal(codec.receive(a,id),2);}
  assert.equal(codec.api.received_count(a),33);assert.equal(codec.api.received_count(b),0);assert.equal(codec.receive(a,72),-1);
  let done=false;for(let i=0;i<72;i++)done=codec.receive(a,i)===1||done;assert.ok(done);codec.reset();
});

test('loss endpoints, empty secondary groups, and explicit publication delay',()=>{
  const total=S.simulate(codec,topology,{loss:1});invariants(total);assert.equal(total.vds.length,0);assert.equal(total.fds.length,0);assert.equal(total.messages.length,2);
  const noSecondary=S.simulate(codec,topology,{groups:[]});assert.equal(noSecondary.vds.length,15);assert.equal(noSecondary.fds.length,0);assert.equal(noSecondary.messages.length,1);
  const delayed=S.simulate(codec,topology,{publicationDelayMs:17});invariants(delayed);
  for(const [node,at] of Object.entries(delayed.publications))if(Number(node)!==delayed.config.leader)assert.equal(at,delayed.decoded[node]+17);
});

test('deterministic replay; condition changes preserve corresponding loss draws',()=>{
  const a=S.simulate(codec,topology,{loss:.1}),b=S.simulate(codec,topology,{loss:.1});assert.deepEqual(a,b);
  const higher=S.simulate(codec,topology,{loss:.3}),mask=new Map(higher.packets.map(p=>[key(p),p.lost]));
  for(const p of a.packets)if(p.lost&&mask.has(key(p)))assert.equal(mask.get(key(p)),true);
  const slower=S.simulate(codec,topology,{loss:.1,uploadMbps:20});
  assert.deepEqual(a.packets.filter(p=>p.kind===0).map(p=>p.lost),slower.packets.filter(p=>p.kind===0).map(p=>p.lost));
  const next=S.simulate(codec,topology,{loss:.1,seed:2});assert.notDeepEqual(a.packets.filter(p=>p.kind===0).map(p=>p.lost),next.packets.filter(p=>p.kind===0).map(p=>p.lost));
});

test('size, bandwidth and geographic delay determine completion time',()=>{
  const slow=S.simulate(codec,topology,{uploadMbps:20,proposalBytes:131072}),fast=S.simulate(codec,topology,{uploadMbps:1000,proposalBytes:131072});assert.ok(slow.lastDecode>fast.lastDecode);
  const small=S.simulate(codec,topology,{uploadMbps:20,proposalBytes:32768});assert.ok(small.packets.length<slow.packets.length);assert.ok(small.lastDecode<slow.lastDecode);
  const normal=S.simulate(codec,topology),zero=S.simulate(codec,topology,{latencyScale:0}),doubled=S.simulate(codec,topology,{latencyScale:2});assert.ok(zero.lastDecode<normal.lastDecode&&doubled.lastDecode>normal.lastDecode);
  for(const a of topology.nodes)for(const b of topology.nodes)if(a!==b)assert.ok(S.latency(a,b,1)>=2&&S.latency(a,b,1)<160);
});

test('packet layout boundaries and invalid inputs',()=>{
  assert.deepEqual(S.layout(65536,15,true),{bytes:65536,depth:9,symbolBytes:1159,k:57,scaled:143});
  assert.equal(S.PROTOCOL.segmentBytes+S.PROTOCOL.authBytes+S.PROTOCOL.ipUdpBytes,1500);
  for(const bytes of [1,1159,1160,32768,65536,131072,262144])for(const primary of [false,true]){const l=S.layout(bytes,primary?15:4,primary);assert.ok(l.scaled+(primary?15:0)<=2**(l.depth-1));assert.ok(l.k*l.symbolBytes>=bytes);}
  for(const options of [{loss:-1},{loss:NaN},{uploadMbps:0},{leader:19},{proposalBytes:0},{proposalBytes:262145},{latencyScale:-1}])assert.throws(()=>S.simulate(codec,topology,options));
});

test('stake chunk order matches the actual upstream assign_round_robin method',()=>{
  const reference=require('./assignment-reference.cjs'),inputs=[];
  for(const k of [1,24,28,57,117,239])for(const stakes of [[1],[1,1,1],[100,1,1],[1,5,2,9,4],[14,6,5,7,3,9,12,4,3,3,4,8,5,4,10,3]])inputs.push({k,stakes});
  const expected=reference(inputs);
  inputs.forEach(({k,stakes},i)=>{
    const ns=stakes.map((stake,id)=>({id,stake}));
    const actual=S.assign({shuffled:n=>n},ns,{},0,{scaled:Math.ceil(k*2.5)},true).targets;
    assert.deepEqual(actual,expected[i]);
  });
});

test('rebroadcast priority preempts queued publications at the next packet boundary',()=>{
  const r=S.simulate(codec,topology,{proposalBytes:131072,uploadMbps:1});invariants(r);
  let bypassed=0;
  for(const n of topology.nodes){
    const ps=r.packets.filter(p=>p.from===n.id),high=ps.filter(p=>p.priority===0),regular=ps.filter(p=>p.priority===1);
    for(const p of regular)assert.ok(!high.some(h=>h.ready<p.start-1e-9&&h.start>p.start),'regular send must not bypass ready rebroadcast');
    for(const h of high)if(regular.some(p=>p.ready<h.ready&&p.start>h.start))bypassed++;
  }
  assert.ok(bypassed>0,'stress case actually exercises publication/rebroadcast contention');
});

test('20% stake withholding suppresses primary relays while receiving and secondary publication continue',()=>{
  const scenario=require('../src/withholding-scenario.cjs').create(topology);
  const ns=new Map(scenario.topology.nodes.map(n=>[n.id,n]));
  const total=scenario.topology.nodes.filter(n=>n.role==='validator').reduce((sum,n)=>sum+n.stake,0);
  assert.equal(ns.get(scenario.validator).stake/total,.2);
  assert.equal(nodes.get(scenario.validator).stake,9,'scenario must not mutate the original topology');
  for(const leader of [0,6,14])for(const loss of [0,.1,.2,.3]){
    const normal=S.simulate(codec,scenario.topology,{leader,loss});
    const r=S.simulate(codec,scenario.topology,{leader,loss,withholdingValidator:scenario.validator});
    invariants(r,ns);
    assert.deepEqual(r.messages[0].targets,normal.messages[0].targets);
    assert.deepEqual(r.packets.filter(p=>p.kind===0).map(p=>[p.to,p.esi,p.lost]),normal.packets.filter(p=>p.kind===0).map(p=>[p.to,p.esi,p.lost]));
    const received=r.packets.filter(p=>p.kind===0&&p.to===scenario.validator&&!p.lost);
    assert.deepEqual(r.withheld.map(w=>w.esi).sort((a,b)=>a-b),received.map(p=>p.esi).sort((a,b)=>a-b));
    assert.ok(r.packets.every(p=>!(p.kind===1&&p.from===scenario.validator)));
    const assigned=new Set(r.messages[0].targets.flatMap((id,esi)=>id===scenario.validator?[esi]:[]));
    assert.ok(r.streams.filter(s=>s.primary&&s.node!==scenario.validator).every(s=>s.arrivals.every(a=>!assigned.has(a.esi))));
    if(loss===0){
      assert.equal(r.vds.length,15);assert.equal(r.fds.length,48);assert.equal(r.lossTimes.length,0);
      assert.equal(r.withheld.length,assigned.size);
      assert.equal(r.streams.find(s=>s.primary&&s.node===scenario.validator).arrivals.length,r.messages[0].targets.length);
      assert.ok(r.messages.some(m=>!m.primary&&m.publisher===scenario.validator));
      assert.ok(r.streams.filter(s=>s.primary&&s.node!==scenario.validator).every(s=>s.arrivals.length===r.messages[0].targets.length-assigned.size));
    }
  }
  for(const withholdingValidator of [0,16,999])assert.throws(()=>S.simulate(codec,scenario.topology,{withholdingValidator}));
});
