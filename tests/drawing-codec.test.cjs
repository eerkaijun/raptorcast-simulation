const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {DrawingCodec,tileBytes,SIZE,SYMBOL_BYTES,CHUNK_COUNT}=require('../src/drawing-codec.js');
const wasm=fs.readFileSync('codec/target/wasm32-unknown-unknown/release/raptorcast_browser_codec.wasm');
const pixels=Uint8Array.from({length:SIZE*SIZE*4},(_,i)=>i%4===3?255:(i*37+Math.floor(i/11))%256);

test('source tiles preserve the exact positions and bytes of the RGBA image',()=>{
  const tiled=tileBytes(pixels);
  assert.deepEqual(tileBytes(tiled,true),pixels);
  assert.deepEqual(tiled.slice(SYMBOL_BYTES,SYMBOL_BYTES+4),pixels.slice(16*4,16*4+4));
  assert.deepEqual(tiled.slice(16*4,17*4),pixels.slice(SIZE*4,SIZE*4+4));
});

test('real drawing bytes recover from distinct partial chunk sets; duplicates do not advance decoding',()=>{
  const codec=new DrawingCodec(wasm),encoded=codec.encode(pixels);
  assert.equal(encoded.sourceCount,64);assert.equal(encoded.chunks.length,160);
  const orders=[Array.from({length:120},(_,i)=>i+40),Array.from({length:120},(_,i)=>119-i)];
  for(const order of orders){
    codec.restart();assert.equal(codec.recovered(),null);
    let count=0,done=false;
    for(const id of order){
      const status=codec.receive(id,encoded.chunks[id]);count++;
      assert.equal(codec.receive(id,encoded.chunks[id]),2);
      assert.equal(codec.api.received_count(codec.receiver),count);
      if(status===1){done=true;break;}
      assert.equal(codec.recovered(),null);
    }
    assert.ok(done);assert.ok(count>=64&&count<CHUNK_COUNT);
    assert.deepEqual(codec.recovered(),pixels);
  }
});

test('editing the drawing changes encoded bytes and replaces the prior message',()=>{
  const codec=new DrawingCodec(wasm),first=codec.encode(pixels);
  const edited=pixels.slice();edited.fill(12,0,16384);
  const second=codec.encode(edited);
  assert.ok(second.chunks.some((chunk,i)=>!Buffer.from(chunk).equals(Buffer.from(first.chunks[i]))));
  assert.equal(codec.recovered(),null);
  for(let id=0;id<CHUNK_COUNT;id++)if(codec.receive(id,second.chunks[id])===1)break;
  assert.deepEqual(codec.recovered(),edited);
  assert.throws(()=>codec.receive(160,second.chunks[0]));
  assert.throws(()=>codec.receive(0,new Uint8Array(3)));
});
