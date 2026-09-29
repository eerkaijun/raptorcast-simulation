(function () {
  'use strict';
  const $ = id => document.getElementById(id), W = 1300, H = 473, SLOW = 12;
  const topology = window.RAPTOR_DATA.topology, nodes = topology.nodes;
  const nodeById = new Map(nodes.map(n=>[n.id,n]));
  const map = $('map'), chart = $('chart'), ctx = map.getContext('2d'), cc = chart.getContext('2d');
  const state = { config: {...RaptorSim.DEFAULTS}, run:null, previous:null, time:0, paused:false, last:0, ui:0, busy:false, revision:0 };
  let codec;
  const background = document.createElement('canvas'); background.width = 2600; background.height = 946;
  const bg = background.getContext('2d'); bg.scale(2,2); bg.fillStyle='#d4d4d4';
  const land=atob(topology.land);
  for(let r=0;r<59;r++) for(let c=0;c<162;c++) if((land.charCodeAt((r*162+c)>>3)>>(7-((r*162+c)&7)))&1){bg.beginPath();bg.arc((c+.5)*8,(r+.5)*8,1.5,0,Math.PI*2);bg.fill();}
  function ub(a,t){let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>1;if(a[m]<=t)lo=m+1;else hi=m;}return lo;}
  function label(r){const c=r.config;return `${nodeById.get(c.leader).name} · ${Math.round(c.loss*100)}%`;}
  function fail(error){$('error').hidden=false;$('error').textContent='Unable to run the simulation: '+error.message;state.paused=true;$('caption').textContent='Simulation stopped';console.error(error);}
  function controls(){
    document.querySelectorAll('[data-loss]').forEach(b=>b.setAttribute('aria-pressed',Number(b.dataset.loss)===state.config.loss));
    document.querySelectorAll('[data-leader]').forEach(b=>b.setAttribute('aria-pressed',Number(b.dataset.leader)===state.config.leader));
    document.querySelectorAll('button,select,input').forEach(e=>e.disabled=state.busy);
    $('pause').textContent=state.paused?'Play':'Pause';$('pause').setAttribute('aria-label',state.paused?'Play animation':'Pause animation');
  }
  function geometry(run){
    for(const p of run.packets){const a=nodeById.get(p.from),b=nodeById.get(p.to);let dx=b.x-a.x;if(dx>W/2)dx-=W;else if(dx<-W/2)dx+=W;const dy=b.y-a.y,len=Math.hypot(dx,dy)||1,bend=Math.min(.12*len,40);p.g=[a.x,a.y,dx,dy,-dy/len*bend,dx/len*bend,Math.min(1,14/len)];}
    run.nodeStreams=new Map(nodes.map(n=>[n.id,run.streams.filter(s=>s.node===n.id).map(s=>({...s,times:s.arrivals.map(a=>a.time)}))]));
  }
  function rerun(patch={}){
    if(state.busy)return;
    const next={...state.config,...patch};
    state.busy=true;controls();$('caption').textContent='Calculating packet arrivals and decoding…';
    // Allow a paint before the synchronous simulation.
    setTimeout(()=>{
      try{
        const run=RaptorSim.simulate(codec,topology,next);geometry(run);
        state.previous=state.run;state.run=run;state.config=next;state.time=0;state.paused=false;state.last=performance.now();state.revision++;
        $('error').hidden=true;
        $('previous').hidden=!state.previous;
        if(state.previous){$('previous').replaceChildren();const dash=document.createElement('i');dash.className='dash';$('previous').append(dash,document.createTextNode('Previous · '+label(state.previous)));}
        draw();pushUi();
      }catch(e){fail(e);}finally{state.busy=false;controls();}
    },20);
  }
  function pushUi(){
    const r=state.run;if(!r)return;const t=state.time,finished=t>=r.end;
    function completionTime(times,total){return times.length===total&&t>=times[total-1]?`${times[total-1].toFixed(1)} ms`:finished?'Incomplete':'In progress';}
    $('validator-time').textContent=completionTime(r.vds,r.vTotal);$('fullnode-time').textContent=completionTime(r.fds,r.fTotal);
    $('validators').textContent=`${ub(r.vds,t)} / ${r.vTotal}`;$('fullnodes').textContent=`${ub(r.fds,t)} / ${r.fTotal}`;
    $('lost').textContent=`${ub(r.lossTimes,t).toLocaleString()} of ${ub(r.sendTimes,t).toLocaleString()}`;
    $('caption').textContent=finished?'':`Animation${state.paused?' paused':''} · ${SLOW}× slower`;
  }
  const wrap=x=>(x+W)%W;
  function point(g,f){const s=Math.sin(Math.PI*f);return[g[0]+g[2]*f+g[4]*s,g[1]+g[3]*f+g[5]*s];}
  function draw(){
    const r=state.run;if(!r)return;const t=state.time;ctx.setTransform(2,0,0,2,0,0);ctx.clearRect(0,0,W,H);ctx.drawImage(background,0,0,W,H);
    ctx.lineCap='round';
    for(const [kind,color,width] of [[1,'rgba(14,14,14,.30)',1.3],[3,'rgba(92,92,92,.34)',1.2],[2,'rgba(92,92,92,.65)',1.7],[0,'#ff5500',2.2]]){
      ctx.beginPath();for(const p of r.packets){if(p.kind!==kind||t<p.txEnd||t>=(p.lost?p.lossTime:p.arrive))continue;const f=(t-p.txEnd)/(p.arrive-p.txEnd),head=point(p.g,f),tail=point(p.g,Math.max(0,f-p.g[6])),hx=wrap(head[0]),tx=wrap(tail[0]);if(Math.abs(hx-tx)>W/2)continue;ctx.moveTo(tx,tail[1]);ctx.lineTo(hx,head[1]);}ctx.strokeStyle=color;ctx.lineWidth=width;ctx.stroke();
    }
    ctx.strokeStyle='#dc2626';ctx.lineWidth=1.7;
    for(const p of r.packets){if(!p.lost||t<p.lossTime||t>=p.lossTime+15)continue;const f=p.arrive===p.txEnd?0:(p.lossTime-p.txEnd)/(p.arrive-p.txEnd),pt=point(p.g,f),x=wrap(pt[0]),y=pt[1];ctx.globalAlpha=1-(t-p.lossTime)/15;ctx.beginPath();ctx.moveTo(x-3,y-3);ctx.lineTo(x+3,y+3);ctx.moveTo(x+3,y-3);ctx.lineTo(x-3,y+3);ctx.stroke();}ctx.globalAlpha=1;
    for(const n of nodes){
      if(n.id===r.config.leader)continue;
      const decoded=r.decoded[n.id]!==undefined&&r.decoded[n.id]<=t;
      let fraction=0;for(const s of r.nodeStreams.get(n.id))fraction=Math.max(fraction,Math.min(.92,ub(s.times,t)/s.k*.92));if(decoded)fraction=1;
      const radius=n.r,color=n.role==='validator'?'#0e0e0e':'#8a8a8a';ctx.beginPath();ctx.arc(n.x,n.y,radius,0,Math.PI*2);ctx.fillStyle='white';ctx.fill();
      if(fraction){ctx.beginPath();if(decoded)ctx.arc(n.x,n.y,radius,0,Math.PI*2);else{ctx.moveTo(n.x,n.y);ctx.arc(n.x,n.y,radius,-Math.PI/2,-Math.PI/2+fraction*Math.PI*2);ctx.closePath();}ctx.fillStyle=color;ctx.fill();}
      ctx.beginPath();ctx.arc(n.x,n.y,radius,0,Math.PI*2);ctx.strokeStyle=t>=r.end&&!decoded?'#dc2626':color;ctx.lineWidth=n.role==='validator'?2:1.4;ctx.stroke();
    }
    const leader=nodeById.get(r.config.leader);ctx.beginPath();ctx.arc(leader.x,leader.y,leader.r+3,0,Math.PI*2);ctx.fillStyle='#ff5500';ctx.fill();ctx.font='500 19px Satoshi, sans-serif';ctx.textAlign='center';ctx.lineJoin='round';ctx.lineWidth=5;ctx.strokeStyle='white';ctx.strokeText('LEADER · '+leader.name,leader.x,leader.y-leader.r-13);ctx.fillStyle='#b83700';ctx.fillText('LEADER · '+leader.name,leader.x,leader.y-leader.r-13);
    drawChart();
  }
  function drawChart(){
    const r=state.run,t=state.time,A=Math.ceil(Math.max(r.end,state.previous?.end||0)/100)*100,top=15,bot=103;
    const CW=Math.max(280,chart.clientWidth),dpr=Math.min(window.devicePixelRatio||1,2);
    if(chart.width!==Math.round(CW*dpr)||chart.height!==Math.round(150*dpr)){chart.width=Math.round(CW*dpr);chart.height=Math.round(150*dpr);}
    cc.setTransform(dpr,0,0,dpr,0,0);cc.clearRect(0,0,CW,150);const X=ms=>40+ms/A*(CW-48),Y=f=>bot-f*(bot-top);
    cc.font='400 12px Supply, monospace';cc.fillStyle='#8a8a8a';cc.textAlign='left';cc.fillText('100%',0,top+5);cc.fillText('0%',10,bot+5);
    cc.lineWidth=1;cc.strokeStyle='#e6e6e6';cc.beginPath();cc.moveTo(40,top);cc.lineTo(CW,top);cc.moveTo(40,bot);cc.lineTo(CW,bot);cc.stroke();
    const step=Math.max(50,Math.ceil(A/(CW<500?4:8)/50)*50);cc.textBaseline='alphabetic';for(let ms=0;ms<=A;ms+=step){const x=X(ms);cc.beginPath();cc.moveTo(x,bot);cc.lineTo(x,bot+7);cc.stroke();cc.textAlign=ms===0?'left':ms===A?'right':'center';cc.fillText(String(ms),x,135);}cc.textAlign='right';cc.fillText('ms',CW,150);
    function curve(ds,total,until,color){cc.strokeStyle=color;cc.beginPath();cc.moveTo(X(0),Y(0));let count=0;for(const d of ds){if(d>until)break;cc.lineTo(X(d),Y(count/total));count++;cc.lineTo(X(d),Y(count/total));}cc.lineTo(X(until),Y(count/total));cc.stroke();}
    if(state.previous){cc.setLineDash([6,6]);cc.lineWidth=2;curve(state.previous.vds,state.previous.vTotal,A,'#b0b0b0');curve(state.previous.fds,state.previous.fTotal,A,'#c8c8c8');cc.setLineDash([]);}
    cc.lineWidth=3;curve(r.fds,r.fTotal,t,'#8a8a8a');curve(r.vds,r.vTotal,t,'#0e0e0e');cc.lineWidth=1;cc.strokeStyle='#b0b0b0';cc.beginPath();cc.moveTo(X(t),top-4);cc.lineTo(X(t),bot);cc.stroke();
  }
  function frame(now){
    if(state.run&&!state.busy&&!state.paused&&state.time<state.run.end){state.time=Math.min(state.run.end,state.time+Math.min(100,now-state.last)/SLOW);draw();if(now-state.ui>80||state.time===state.run.end){pushUi();state.ui=now;}}
    state.last=now;requestAnimationFrame(frame);
  }
  document.querySelectorAll('[data-loss]').forEach(b=>b.addEventListener('click',()=>{if(Number(b.dataset.loss)!==state.config.loss)rerun({loss:Number(b.dataset.loss)});}));
  document.querySelectorAll('[data-leader]').forEach(b=>b.addEventListener('click',()=>{if(Number(b.dataset.leader)!==state.config.leader)rerun({leader:Number(b.dataset.leader)});}));
  $('replay').addEventListener('click',()=>{if(!state.run)return;state.time=0;state.paused=false;state.last=performance.now();controls();draw();pushUi();});
  $('pause').addEventListener('click',()=>{state.paused=!state.paused;controls();pushUi();});
  window.addEventListener('resize',()=>{if(state.run)draw();});
  window.raptorSimulation={get run(){return state.run;},get revision(){return state.revision;},get time(){return state.time;},get paused(){return state.paused;}};
  try{codec=new RaptorSim.Codec(Uint8Array.from(atob(window.RAPTOR_DATA.wasm),c=>c.charCodeAt(0)));rerun();state.last=performance.now();requestAnimationFrame(frame);}catch(e){fail(e);}
})();
