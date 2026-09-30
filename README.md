# Raptorcast Simulation

Open [simulation.html](<simulation.html>) directly in a modern browser. It is a standalone, offline page: the map, fonts, and Rust WebAssembly codec are embedded. No server or network access is needed to run it.

[withholding.html](<withholding.html>) shows London holding 20% of total validator stake and selectively withholding primary rebroadcasts. Toggle Forwarding / Withholding to compare behavior. The other validators' stakes are scaled proportionally, and the dashed curves show a forwarding baseline with the same stake distribution and leader, with network packet loss fixed at zero. London still receives and decodes chunks and publishes to its full-node group. The counter tracks received chunks that London refuses to relay. `npm run build` generates all three pages.

[drawing.html](<drawing.html>) encodes a hand-drawn image with the actual Monad Raptor codec. Deliver, skip, or shuffle its 160 encoded chunks and reconstruct the 64 source chunks without a network model. Chunk previews show actual encoded bytes; the recovered image is read from the decoder and checked against the original pixels.

The simulation models one valid proposal through primary and secondary **deterministic RaptorCast v1**, based on the sibling `../monad-bft` checkout at `18b86935e4f8465514176d29c1afb93ec7a5ba2d`. Geographic transmission is the only mode. Select the leader and per-hop loss. The page fixes the serialized proposal size at 64 KiB and upload capacity at 1,000 Mbps for every node. The network seed is fixed at 1, so Replay repeats the same result. The previous run remains as a dashed comparison.

**Recovery is real decoding.** The browser runs the unmodified `monad-raptor` encoder and `ManagedDecoder`, compiled to WASM. Packets carry distinct encoding symbol identities; each receiver has independent decoder state. A successful decode must reconstruct the synthetic proposal bytes exactly. Receiving K symbols is a minimum, not an automatic success. Secondary publishing happens only after that validator actually decodes; the leader already has the proposal at time zero. Different secondary publishers never share decoder state.

| Modeled behavior | Implementation basis |
|---|---|
| 2.5× redundancy; 1500-byte MTU, 32-byte authenticated header, 1440-byte RaptorCast segment | `monad-raptorcast/src/packet/deterministic.rs`, `monad-wireauth/src/protocol/messages.rs`, `monad-dataplane/src/udp.rs` |
| Merkle depth and symbol size from serialized message length; primary rounding included in depth hint | `packet/deterministic.rs::DeterministicEncoding::build` |
| Stake-ceiling obligations, then round-robin distribution, excluding the author | `packet/assigner.rs::StakePartition::assign_round_robin` |
| Even secondary distribution across shuffled members | `packet/assigner.rs::EvenPartition::assign` |
| Deterministic seed from round, coarse timestamp, and publisher key; actual ChaCha20/`SliceRandom` implementation | `packet/deterministic.rs::derive_seed`, `Partition::shuffle` |
| First-hop recipients forward admitted symbols, including after local decode | `udp.rs::finalize_deterministic`, `decoding.rs::RecentlyDecodedState` |
| Recovery from actual symbols with duplicate detection and byte verification | `monad-raptor` + `codec/lib.rs` |
| Shared sender bandwidth; high-priority rebroadcasts before regular publications | Packet-level approximation of the byte-paced dataplane and `lib.rs::rebroadcast_packet` |

The network contains 16 synthetic validators with sample stakes totaling 100, and 48 full nodes. Public identities are valid secp256k1 public keys generated from fixture private scalars 1–64; these are public test data only. The ordered group uses compressed-key order; the seed uses the first 16 bytes of the x-coordinate, which are shared by compressed and uncompressed encodings. A fixed accepted-membership snapshot has four members per publisher, sampled across regions; 16 full nodes have a second publisher. Group membership does not change when switching leaders or loss.

The fixed 64 KiB proposal size means **serialized application-message bytes**, not an execution block-size estimate. Each primary/secondary layout is computed independently. The actual codec encodes deterministic synthetic bytes of that size. Encoding caches may share identical bytes, but never receive state. The supported size range is 1–256 KiB in the engine (fixed at 64 KiB in the UI); the smaller cap keeps browser work bounded, and is not a claim about the production message limit.
