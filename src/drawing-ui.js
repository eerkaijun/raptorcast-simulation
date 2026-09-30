(function() {
  'use strict';
  const $ = id => document.getElementById(id);
  const {DrawingCodec, SIZE, CHUNK_COUNT} = RaptorDrawing;
  const canvas = $('drawing'), ctx = canvas.getContext('2d', {willReadFrequently:true});
  const state = {encoded:null, snapshot:null, states:[], order:[], seed:1, unique:0, done:false, timer:null, busy:false, ink:'#ff5500', pointer:null, latest:null};
  let codec;

  function stop() { clearInterval(state.timer); state.timer = null; $('play').textContent = 'Auto play'; }
  function controls() {
    const ready = !!state.encoded && !state.busy;
    for (const id of ['next','play','skip']) $(id).disabled = !ready || state.done || !state.states.includes('available');
    $('shuffle').disabled = !ready;
    for (const id of ['encode','clear','example']) $(id).disabled = state.busy || !codec;
    $('play').textContent = state.timer ? 'Pause' : 'Auto play';
  }
  function error(e) { stop(); state.busy = false; $('error').hidden = false; $('error').textContent = e.message; controls(); console.error(e); }
  function guarded(fn) { return (...args) => { try { return fn(...args); } catch(e) { error(e); } }; }
  function clearRecovery() {
    $('recovered').getContext('2d').clearRect(0,0,SIZE,SIZE);
    $('recovery-placeholder').hidden = false;
    $('received-count').textContent = '0 unique chunks received';
    $('received-progress').value = 0;
    $('verified').textContent = '';
    $('recovery-note').textContent = '64 source chunks';
  }
  function invalidate() {
    stop(); state.encoded = null; state.done = false; state.unique = 0; state.latest = null;
    state.states = []; state.order = [];
    clearRecovery(); $('payload-placeholder').hidden = false;
    $('chunk-label').textContent = 'No encoded chunks yet';
    const hint = document.createElement('div'); hint.className = 'empty-bank'; hint.textContent = 'Encode a drawing to explore its chunks.';
    $('chunk-grid').replaceChildren(hint);
    controls();
  }
  function blank() { ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,SIZE,SIZE); }
  function example() {
    invalidate(); blank();
    ctx.strokeStyle = '#ff5500'; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(64,64,44,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle = '#101010';
    for (const x of [48,80]) { ctx.beginPath(); ctx.arc(x,53,4,0,Math.PI*2); ctx.fill(); }
    ctx.strokeStyle = '#101010'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(64,65,23,.2,Math.PI-.2); ctx.stroke();
  }
  function point(e) {
    const box = canvas.getBoundingClientRect();
    return {x:Math.max(0,Math.min(SIZE,(e.clientX-box.left)*SIZE/box.width)),y:Math.max(0,Math.min(SIZE,(e.clientY-box.top)*SIZE/box.height))};
  }
  function stroke(a,b) {
    ctx.strokeStyle = state.ink; ctx.fillStyle = state.ink; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(b.x,b.y,ctx.lineWidth/2,0,Math.PI*2); ctx.fill();
  }
  canvas.addEventListener('pointerdown', e => {
    if (state.busy || state.pointer || (e.pointerType === 'mouse' && e.button !== 0)) return;
    invalidate(); const p = point(e); state.pointer = {id:e.pointerId,point:p}; canvas.setPointerCapture(e.pointerId); stroke(p,p);
  });
  canvas.addEventListener('pointermove', e => {
    if (state.busy || state.pointer?.id !== e.pointerId) return;
    const p = point(e); stroke(state.pointer.point,p); state.pointer.point = p;
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(type,e => { if (state.pointer?.id === e.pointerId) state.pointer = null; });
  document.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => {
    state.ink = b.dataset.color;
    document.querySelectorAll('[data-color]').forEach(x => x.setAttribute('aria-pressed',x === b));
  }));
  $('clear').addEventListener('click', () => { invalidate(); blank(); });
  $('example').addEventListener('click', example);

  function bytesView(target, bytes) {
    const c = target.getContext('2d'), pixels = c.createImageData(32,32);
    for (let i=0;i<bytes.length;i++) { pixels.data[i*4] = pixels.data[i*4+1] = pixels.data[i*4+2] = bytes[i]; pixels.data[i*4+3] = 255; }
    c.putImageData(pixels,0,0);
  }
  function preview(id) {
    if (state.latest !== null) $('chunk-'+state.latest).classList.remove('latest');
    state.latest = id; $('chunk-'+id).classList.add('latest');
    bytesView($('payload'),state.encoded.chunks[id]); $('payload-placeholder').hidden = true;
    $('chunk-label').textContent = `Chunk #${id}`;
  }
  function updateChunk(id) {
    const b = $('chunk-'+id); b.classList.toggle('received',state.states[id] === 'received'); b.classList.toggle('skipped',state.states[id] === 'skipped');
    b.setAttribute('aria-label',`Chunk ${id}, ${state.states[id]}. ${state.done?'Inspect':'Send to decoder'}.`);
  }
  function shuffleOrder() {
    state.order = Array.from({length:CHUNK_COUNT},(_,i)=>i);
    let seed = state.seed;
    for (let i=state.order.length-1;i>0;i--) { seed = (Math.imul(seed,1664525)+1013904223)>>>0; const j = seed%(i+1); [state.order[i],state.order[j]] = [state.order[j],state.order[i]]; }
  }
  function restart(shuffle = false) {
    stop(); codec.restart(); if (shuffle) state.seed++;
    state.states = Array(CHUNK_COUNT).fill('available'); state.unique = 0; state.done = false;
    shuffleOrder(); clearRecovery();
    for (let id=0;id<CHUNK_COUNT;id++) updateChunk(id);
    preview(state.order[0]); controls();
  }
  function deliver(id) {
    if (!state.encoded || state.busy) return;
    preview(id);
    if (state.done) return;
    const result = codec.receive(id,state.encoded.chunks[id]);
    if (result === 2) return;
    state.states[id] = 'received'; state.unique++;
    $('received-count').textContent = `${state.unique} unique chunks received`;
    $('received-progress').value = state.unique;
    if (result === 1) {
      const pixels = codec.recovered();
      if (!pixels || pixels.length !== state.snapshot.length || !pixels.every((v,i)=>v===state.snapshot[i])) throw new Error('Reconstructed pixels do not match the drawing');
      $('recovered').getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels),SIZE,SIZE),0,0);
      $('recovery-placeholder').hidden = true; state.done = true; stop();
      $('verified').textContent = 'Pixel-for-pixel match verified';
      $('recovery-note').textContent = `Recovered from ${state.unique} of ${CHUNK_COUNT} chunks.`;
    }
    updateChunk(id); controls();
    if (!state.done && !state.states.includes('available')) { stop(); }
  }
  function next() { const id = state.order.find(id=>state.states[id]==='available'); if (id !== undefined) deliver(id); }
  $('encode').addEventListener('click', () => {
    stop(); state.pointer = null; state.busy = true; controls();
    const snapshot = new Uint8Array(ctx.getImageData(0,0,SIZE,SIZE).data);
    setTimeout(guarded(() => {
      state.encoded = codec.encode(snapshot); state.snapshot = snapshot; state.seed = 1;
      $('chunk-grid').replaceChildren();
      state.encoded.chunks.forEach((bytes,id) => {
        const button = document.createElement('button'); button.id = 'chunk-'+id; button.className = 'chunk';
        const tile = document.createElement('canvas'); tile.width = tile.height = 32; tile.setAttribute('aria-hidden','true'); bytesView(tile,bytes);
        const label = document.createElement('span'); label.textContent = id;
        button.append(tile,label); button.addEventListener('click',guarded(() => deliver(id))); $('chunk-grid').append(button);
      });
      state.latest = null; state.busy = false; $('error').hidden = true; restart();
    }),20);
  });
  $('next').addEventListener('click',guarded(next));
  $('skip').addEventListener('click', () => {
    const id = state.order.find(id=>state.states[id]==='available'); if (id === undefined) return;
    state.states[id] = 'skipped'; updateChunk(id); preview(id);
    if (!state.states.includes('available')) stop(); controls();
  });
  $('play').addEventListener('click', () => { if (state.timer) stop(); else state.timer = setInterval(guarded(next),120); controls(); });
  $('shuffle').addEventListener('click',guarded(() => restart(true)));
  window.drawingSimulation = {get state(){return {encoded:!!state.encoded,unique:state.unique,done:state.done,order:[...state.order],states:[...state.states],latest:state.latest,playing:state.timer!==null};}};
  try { codec = new DrawingCodec(Uint8Array.from(atob(window.DRAWING_WASM),c=>c.charCodeAt(0))); example(); controls(); } catch(e) { error(e); }
})();
