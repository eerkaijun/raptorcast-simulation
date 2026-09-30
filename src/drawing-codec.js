(function(root) {
  'use strict';
  const SIZE = 128, TILE = 16, SYMBOL_BYTES = TILE * TILE * 4, SOURCE_COUNT = (SIZE / TILE) ** 2, CHUNK_COUNT = SOURCE_COUNT * 2.5;

  function tileBytes(pixels, reverse = false) {
    if (pixels.length !== SIZE * SIZE * 4) throw new Error('Expected a 128 × 128 RGBA image');
    const result = new Uint8Array(pixels.length);
    let offset = 0;
    for (let ty = 0; ty < SIZE; ty += TILE) for (let tx = 0; tx < SIZE; tx += TILE) {
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const pixel = ((ty + y) * SIZE + tx + x) * 4;
        for (let channel = 0; channel < 4; channel++, offset++) {
          if (reverse) result[pixel + channel] = pixels[offset];
          else result[offset] = pixels[pixel + channel];
        }
      }
    }
    return result;
  }

  class DrawingCodec {
    constructor(wasm) {
      this.api = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports;
      this.receiver = null;
    }
    upload(bytes) {
      const ptr = this.api.input_buffer(bytes.length);
      new Uint8Array(this.api.memory.buffer, ptr, bytes.length).set(bytes);
    }
    encode(pixels) {
      const source = tileBytes(pixels);
      this.api.reset();
      this.upload(source);
      const message = this.api.message_from_input(SYMBOL_BYTES, CHUNK_COUNT);
      this.receiver = this.api.decoder_new(message);
      const chunks = Array.from({length:CHUNK_COUNT}, (_,id) => {
        const ptr = this.api.symbol_ptr(message, id);
        return new Uint8Array(this.api.memory.buffer, ptr, SYMBOL_BYTES).slice();
      });
      return {chunks, sourceCount:this.api.message_source_symbols(message), source};
    }
    restart() {
      if (this.receiver === null) throw new Error('Encode a drawing first');
      this.api.decoder_restart(this.receiver);
    }
    receive(id, bytes) {
      if (this.receiver === null) throw new Error('Encode a drawing first');
      if (!Number.isInteger(id) || id < 0 || id >= CHUNK_COUNT) throw new Error('Invalid chunk ID');
      if (bytes.length !== SYMBOL_BYTES) throw new Error('Invalid chunk size');
      this.upload(bytes);
      const result = this.api.receive_input(this.receiver, id);
      if (result < 0) throw new Error('Codec rejected the chunk');
      return result;
    }
    recovered() {
      if (this.receiver === null) return null;
      const len = this.api.recovered_len(this.receiver);
      if (!len) return null;
      const ptr = this.api.recovered_ptr(this.receiver);
      return tileBytes(new Uint8Array(this.api.memory.buffer, ptr, len).slice(), true);
    }
  }

  const api = {DrawingCodec, tileBytes, SIZE, TILE, SYMBOL_BYTES, SOURCE_COUNT, CHUNK_COUNT};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RaptorDrawing = api;
})(globalThis);
