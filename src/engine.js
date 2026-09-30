(function (root) {
  'use strict';
  const PROTOCOL = Object.freeze({ mtu: 1500, ipUdpBytes: 28, authBytes: 32,
    segmentBytes: 1440, headerBytes: 117, chunkHeaderBytes: 4, merkleHashBytes: 20,
    minDepth: 3, maxDepth: 15, redundancy: 2.5, round: 1, timestamp: 1735689600000 });
  const DEFAULTS = Object.freeze({ leader: 0, loss: 0, proposalBytes: 65536, uploadMbps: 1000,
    seed: 1, latencyScale: 1, publicationDelayMs: 0, withholdingValidator: null });

  function mix(x) { x = Math.imul(x ^ x >>> 16, 0x21f0aaad); x = Math.imul(x ^ x >>> 15, 0x735a2d97); return (x ^ x >>> 15) >>> 0; }
  // Keyed draws keep packet loss stable when event order changes.
  function random(seed, domain, ...keys) {
    let h = mix((seed >>> 0) ^ domain);
    for (const key of keys) h = mix(h ^ mix(key >>> 0));
    return h / 4294967296;
  }
  function distance(a, b) {
    const r = Math.PI / 180, dlat = (b.lat - a.lat) * r, dlon = (b.lon - a.lon) * r;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.lat*r) * Math.cos(b.lat*r) * Math.sin(dlon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
  }
  // Synthetic latency bands: [maximum distance in km, minimum ms, maximum ms].
  const LATENCY_BANDS = [[500, 2, 5], [2000, 8, 18], [5000, 25, 45], [9000, 50, 80], [14000, 80, 115], [Infinity, 115, 160]];
  function latency(a, b, seed, scale = 1) {
    const band = LATENCY_BANDS.find(band => distance(a, b) <= band[0]);
    return scale * (band[1] + (band[2] - band[1]) * random(seed, 0x1a7, a.id, b.id));
  }
  function layout(bytes, members, primary) {
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 262144) throw new Error('Proposal must be 1–262144 serialized bytes');
    if (!Number.isInteger(members) || members < 1) throw new Error('Empty recipient group');
    for (let depth = PROTOCOL.minDepth; depth <= PROTOCOL.maxDepth; depth++) {
      const symbolBytes = PROTOCOL.segmentBytes - PROTOCOL.headerBytes - PROTOCOL.chunkHeaderBytes - (depth - 1) * PROTOCOL.merkleHashBytes;
      const k = Math.ceil(bytes / symbolBytes), scaled = Math.ceil(k * PROTOCOL.redundancy);
      // StakePartition's hint includes one potential rounding chunk per recipient.
      if (scaled + (primary ? members : 0) <= 2 ** (depth - 1)) return { bytes, depth, symbolBytes, k, scaled };
    }
    throw new Error('Message exceeds deterministic layout limits');
  }

  class Codec {
    constructor(bytes) {
      const module = new WebAssembly.Module(bytes);
      if (WebAssembly.Module.imports(module).length) throw new Error('Codec must be self-contained');
      this.api = new WebAssembly.Instance(module).exports;
    }
    reset() { this.api.reset(); }
    message(layout, n, salt) { return this.api.message_new(layout.bytes, layout.symbolBytes, n, salt); }
    receiver(message) { return this.api.decoder_new(message); }
    receive(receiver, esi) { return this.api.receive(receiver, esi); }
    shuffled(nodes, publisher, time) {
      const seed = new Uint8Array(32), view = new DataView(seed.buffer);
      view.setBigUint64(0, BigInt(PROTOCOL.round), true);
      view.setBigUint64(8, BigInt(Math.floor((PROTOCOL.timestamp + time) / 2048)), true);
      seed.set(Uint8Array.from(publisher.pubkey.match(/../g).slice(1, 17), h => parseInt(h, 16)), 16);
      for (let i = 0; i < 8; i++) this.api.seed_word(i, view.getUint32(i * 4, true));
      // Match the NodeId order used by the Rust partition before shuffling.
      const sorted = nodes.slice().sort((a,b) => a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0);
      this.api.shuffle(sorted.length);
      return sorted.map((_, i) => sorted[this.api.shuffled_at(i)]);
    }
  }
  function assign(codec, nodes, publisher, time, coding, primary) {
    const order = codec.shuffled(nodes, publisher, time);
    const targets = [];
    if (primary) {
      const totalStake = order.reduce((s, n) => s + n.stake, 0);
      if (!totalStake || order.some(n => !Number.isInteger(n.stake) || n.stake <= 0)) throw new Error('Invalid stake');
      const remaining = order.map(n => Math.ceil(coding.scaled * n.stake / totalStake));
      while (remaining.some(n => n > 0)) for (let i = 0; i < order.length; i++) {
        if (remaining[i] > 0) { targets.push(order[i].id); remaining[i]--; }
      }
    } else {
      for (let i = 0; i < coding.scaled; i++) targets.push(order[i % order.length].id);
    }
    return { order: order.map(n => n.id), targets };
  }

  class Heap {
    constructor() { this.items = []; this.seq = 0; }
    push(time, data) {
      const a = this.items, x = { time, data, seq: this.seq++ }; let i = a.length; a.push(x);
      while (i > 0) { const p = (i - 1) >> 1; if (!this.less(x, a[p])) break; a[i] = a[p]; i = p; } a[i] = x;
    }
    less(a, b) { return a.time < b.time || (a.time === b.time && a.seq < b.seq); }
    pop() {
      const a = this.items, out = a[0], x = a.pop(); if (!a.length) return out;
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let j = i * 2 + 1; if (j + 1 < a.length && this.less(a[j + 1], a[j])) j++;
        if (!this.less(a[j], x)) break; a[i] = a[j]; i = j;
      }
      a[i] = x; return out;
    }
  }
  function defaultGroups(nodes) {
    const full = nodes.filter(n => n.role === 'fullnode').slice().sort((a,b) => random(7, 0x670, a.id) - random(7, 0x670, b.id));
    return nodes.filter(n => n.role === 'validator').map((n, i) => ({ publisher: n.id,
      members: Array.from({length:4}, (_,j) => full[(i * 3 + j) % full.length].id) }));
  }

  function simulate(codec, topology, options = {}) {
    const config = { ...DEFAULTS, ...options };
    if (!(config.loss >= 0 && config.loss <= 1) || !Number.isFinite(config.loss)) throw new Error('Invalid loss');
    if (!(config.uploadMbps > 0 && config.uploadMbps <= 100000)) throw new Error('Invalid upload capacity');
    if (!Number.isFinite(config.latencyScale) || config.latencyScale < 0 || !Number.isFinite(config.publicationDelayMs) || config.publicationDelayMs < 0) throw new Error('Invalid delay');
    const nodes = topology.nodes, byId = new Map(nodes.map(n=>[n.id,n]));
    const validators = nodes.filter(n=>n.role==='validator'), fullnodes = nodes.filter(n=>n.role==='fullnode');
    const leader = byId.get(config.leader);
    if (!leader || leader.role !== 'validator') throw new Error('Leader must be a validator');
    if (config.withholdingValidator !== null && (byId.get(config.withholdingValidator)?.role !== 'validator' || config.withholdingValidator === leader.id)) throw new Error('Withholding requires a non-leader validator');
    const groups = options.groups || defaultGroups(nodes);
    for (const g of groups) {
      if (byId.get(g.publisher)?.role !== 'validator' || new Set(g.members).size !== g.members.length || g.members.some(id=>byId.get(id)?.role !== 'fullnode')) throw new Error('Invalid group snapshot');
    }
    if (new Set(groups.map(g=>g.publisher)).size !== groups.length) throw new Error('Only one active group per publisher');
    codec.reset();
    const heap = new Heap(), packets = [], messages = [], withheld = [], streams = new Map(), outgoing = new Map();
    const decoded = new Map([[leader.id, 0]]), publications = new Map(), codecMessages = new Map();
    const counters = { verifiedReconstructions: 0, duplicateDrops: 0 };
    function makeMessage(publisher, at, recipients, primary) {
      const coding = layout(config.proposalBytes, recipients.length, primary);
      const assignment = assign(codec, recipients, publisher, at, coding, primary);
      const ck = `${coding.symbolBytes}/${assignment.targets.length}`;
      if (!codecMessages.has(ck)) codecMessages.set(ck, codec.message(coding, assignment.targets.length, config.seed));
      const m = { id: messages.length, publisher: publisher.id, at, primary, coding, ...assignment,
        codecMessage: codecMessages.get(ck) };
      messages.push(m);
      for (const n of recipients) {
        const s = { node: n.id, publisher: publisher.id, primary, message: m.id, k: coding.k,
          n: assignment.targets.length, decoder: codec.receiver(m.codecMessage), arrivals: [], decodedAt: Infinity };
        streams.set(`${m.id}/${n.id}`, s);
      }
      for (let esi = 0; esi < m.targets.length; esi++) send(m, publisher.id, m.targets[esi], esi, at, primary ? 0 : 2);
      return m;
    }
    function publish(node, time) {
      const group = groups.find(g=>g.publisher===node);
      if (!group || !group.members.length || publications.has(node)) return;
      publications.set(node, time);
      makeMessage(byId.get(node), time, group.members.map(id=>byId.get(id)), false);
    }
    function send(m, from, to, esi, ready, kind) {
      const draw = random(config.seed, 0x1055, m.primary ? 0 : 1, m.publisher, from, to, esi);
      // lib.rs::rebroadcast_packet uses High; ordinary publication uses Regular.
      const priority = kind === 1 || kind === 3 ? 0 : 1;
      const packet = { from, to, esi, message: m.id, publisher: m.publisher, kind, ready, priority,
        bytes: PROTOCOL.segmentBytes + PROTOCOL.authBytes, lost: draw < config.loss };
      packets.push(packet);
      if (!outgoing.has(from)) outgoing.set(from, { queues: [[], []], active: false });
      const q = outgoing.get(from); q.queues[priority].push(packet);
      if (!q.active) { q.active = true; heap.push(ready, { type: 'transmit', from }); }
    }
    function transmit(from, time) {
      const q = outgoing.get(from), packet = q.queues[0].shift() || q.queues[1].shift();
      if (!packet) { q.active = false; return; }
      packet.start = time;
      packet.txEnd = time + packet.bytes * 8 / (config.uploadMbps * 1000);
      packet.arrive = packet.txEnd + latency(byId.get(from), byId.get(packet.to), config.seed, config.latencyScale);
      packet.lossTime = packet.lost ? packet.txEnd + (packet.arrive - packet.txEnd) * (0.3 + 0.5 * random(config.seed, 0xfade, from,packet.to,packet.esi,packet.publisher)) : -1;
      if (!packet.lost) heap.push(packet.arrive, { type: 'receive', m: messages[packet.message], packet });
      heap.push(packet.txEnd, { type: 'transmit', from });
    }
    makeMessage(leader, 0, validators.filter(n=>n!==leader), true);
    publish(leader.id, 0);
    while (heap.items.length) {
      const event = heap.pop(), {time, data} = event;
      if (data.type === 'publish') { publish(data.node, time); continue; }
      if (data.type === 'transmit') { transmit(data.from, time); continue; }
      const {m, packet} = data, s = streams.get(`${m.id}/${packet.to}`);
      const result = codec.receive(s.decoder, packet.esi);
      if (result === 2) { counters.duplicateDrops++; continue; }
      if (result < 0) throw new Error('Codec rejected generated symbol');
      s.arrivals.push({ time, esi: packet.esi });
      // Continue forwarding assigned symbols after local decoding completes.
      if (m.targets[packet.esi] === packet.to) {
        if (m.primary && packet.to === config.withholdingValidator) {
          withheld.push({time, node:packet.to, message:m.id, esi:packet.esi});
        } else {
          for (const target of m.order) if (target !== packet.to) send(m, packet.to, target, packet.esi, time, m.primary ? 1 : 3);
        }
      }
      if (result === 1) {
        s.decodedAt = time; counters.verifiedReconstructions++;
        if (!decoded.has(packet.to)) decoded.set(packet.to, time);
        if (m.primary) heap.push(time + config.publicationDelayMs, { type: 'publish', node: packet.to });
      }
    }
    const vds = validators.filter(n=>n!==leader && decoded.has(n.id)).map(n=>decoded.get(n.id)).sort((a,b)=>a-b);
    const fds = fullnodes.filter(n=>decoded.has(n.id)).map(n=>decoded.get(n.id)).sort((a,b)=>a-b);
    const sendTimes = packets.map(p=>p.start).sort((a,b)=>a-b), lossTimes = packets.filter(p=>p.lost).map(p=>p.lossTime).sort((a,b)=>a-b);
    const lastDecode = Math.max(0, ...vds, ...fds);
    const end = packets.reduce((t,p)=>Math.max(t, p.lost ? p.lossTime + 15 : p.arrive), lastDecode) + 1;
    const streamList = [...streams.values()].map(({decoder, ...s})=>s);
    const result = { config, groups, messages: messages.map(({codecMessage,...m})=>m), packets, withheld, streams: streamList,
      decoded: Object.fromEntries(decoded), publications: Object.fromEntries(publications), vds, fds,
      vTotal: validators.length-1, fTotal: fullnodes.length, sendTimes, lossTimes, lastDecode, end,
      failed: validators.length-1-vds.length+fullnodes.length-fds.length, counters };
    codec.reset();
    return result;
  }
  const api = { PROTOCOL, DEFAULTS, LATENCY_BANDS, Codec, layout, assign, simulate, defaultGroups, latency, random };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RaptorSim = api;
})(globalThis);
