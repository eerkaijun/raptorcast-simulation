use std::cell::RefCell;
use monad_raptor::{Encoder, ManagedDecoder};
use rand::{seq::SliceRandom, SeedableRng};
use rand_chacha::ChaCha20Rng;

struct Message {
    source: Vec<u8>,
    symbols: Vec<Vec<u8>>,
    k: usize,
    symbol_len: usize,
}
struct Receiver {
    message: usize,
    decoder: ManagedDecoder,
    seen: Vec<bool>,
    done: bool,
    count: u32,
    recovered: Vec<u8>,
}
#[derive(Default)]
struct Pool {
    messages: Vec<Message>,
    receivers: Vec<Receiver>,
    seed: [u8; 32],
    order: Vec<usize>,
    input: Vec<u8>,
}
thread_local! { static POOL: RefCell<Pool> = RefCell::new(Pool::default()); }

#[no_mangle]
pub extern "C" fn reset() { POOL.with(|p| *p.borrow_mut() = Pool::default()); }

#[no_mangle]
pub extern "C" fn message_new(len: u32, symbol_len: u32, count: u32, salt: u32) -> u32 {
    assert!(len > 0 && len <= 256 * 1024 && symbol_len > 0 && count < 65521);
    let source: Vec<u8> = (0..len).map(|i| (i.wrapping_mul(37) ^ (i / 11) ^ salt) as u8).collect();
    encode_message(source, symbol_len, count)
}

fn encode_message(source: Vec<u8>, symbol_len: u32, count: u32) -> u32 {
    assert!(!source.is_empty() && source.len() <= 256 * 1024 && symbol_len > 0 && count < 65521);
    let encoder = Encoder::new(&source, symbol_len as usize).unwrap();
    let k = encoder.num_source_symbols();
    let symbols = (0..count).map(|esi| {
        let mut symbol = vec![0; symbol_len as usize];
        encoder.encode_symbol(&mut symbol, esi as usize);
        symbol
    }).collect();
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let id = p.messages.len();
        p.messages.push(Message { source, symbols, k, symbol_len: symbol_len as usize });
        id as u32
    })
}

#[no_mangle]
pub extern "C" fn decoder_new(message: u32) -> u32 {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let m = &p.messages[message as usize];
        let r = Receiver { message: message as usize,
            decoder: ManagedDecoder::new(m.k, m.symbols.len(), m.symbol_len).unwrap(),
            seen: vec![false; m.symbols.len()], done: false, count: 0, recovered: Vec::new() };
        let id = p.receivers.len();
        p.receivers.push(r);
        id as u32
    })
}

// 0: needs more symbols; 1: reconstructed now; 2: duplicate; 3: already decoded;
// -1: invalid ID.
#[no_mangle]
pub extern "C" fn receive(receiver: u32, esi: u32) -> i32 {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let Pool { messages, receivers, .. } = &mut *p;
        let r = &mut receivers[receiver as usize];
        let m = &messages[r.message];
        let Some(symbol) = m.symbols.get(esi as usize) else { return -1; };
        receive_symbol(r, m, esi as usize, symbol)
    })
}

fn receive_symbol(r: &mut Receiver, m: &Message, esi: usize, symbol: &[u8]) -> i32 {
    if esi >= r.seen.len() || symbol.len() != m.symbol_len { return -1; }
    if r.seen[esi] { return 2; }
    r.seen[esi] = true;
    r.count += 1;
    if r.done { return 3; }
    r.decoder.received_encoded_symbol(symbol, esi);
    if !r.decoder.try_decode() { return 0; }
    let mut recovered = r.decoder.reconstruct_source_data().unwrap();
    recovered.truncate(m.source.len());
    assert_eq!(recovered, m.source, "decoded bytes differ from source");
    r.recovered = recovered;
    r.done = true;
    1
}

#[no_mangle]
pub extern "C" fn input_buffer(len: u32) -> *mut u8 {
    assert!(len <= 256 * 1024);
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        p.input.resize(len as usize, 0);
        p.input.as_mut_ptr()
    })
}

#[no_mangle]
pub extern "C" fn message_from_input(symbol_len: u32, count: u32) -> u32 {
    let source = POOL.with(|p| p.borrow().input.clone());
    encode_message(source, symbol_len, count)
}

#[no_mangle]
pub extern "C" fn message_source_symbols(message: u32) -> u32 {
    POOL.with(|p| p.borrow().messages[message as usize].k as u32)
}

#[no_mangle]
pub extern "C" fn symbol_ptr(message: u32, esi: u32) -> *const u8 {
    POOL.with(|p| p.borrow().messages[message as usize].symbols[esi as usize].as_ptr())
}

#[no_mangle]
pub extern "C" fn receive_input(receiver: u32, esi: u32) -> i32 {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let Pool { messages, receivers, input, .. } = &mut *p;
        let r = &mut receivers[receiver as usize];
        receive_symbol(r, &messages[r.message], esi as usize, input)
    })
}

#[no_mangle]
pub extern "C" fn decoder_restart(receiver: u32) {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let message = p.receivers[receiver as usize].message;
        let m = &p.messages[message];
        let r = Receiver { message,
            decoder: ManagedDecoder::new(m.k, m.symbols.len(), m.symbol_len).unwrap(),
            seen: vec![false; m.symbols.len()], done: false, count: 0, recovered: Vec::new() };
        p.receivers[receiver as usize] = r;
    });
}

#[no_mangle]
pub extern "C" fn recovered_ptr(receiver: u32) -> *const u8 {
    POOL.with(|p| p.borrow().receivers[receiver as usize].recovered.as_ptr())
}

#[no_mangle]
pub extern "C" fn recovered_len(receiver: u32) -> u32 {
    POOL.with(|p| p.borrow().receivers[receiver as usize].recovered.len() as u32)
}

#[no_mangle]
pub extern "C" fn received_count(receiver: u32) -> u32 {
    POOL.with(|p| p.borrow().receivers[receiver as usize].count)
}

// Keep the RNG and shuffle versions aligned with Partition::shuffle.
#[no_mangle]
pub extern "C" fn seed_word(index: u32, word: u32) {
    POOL.with(|p| p.borrow_mut().seed[index as usize * 4..index as usize * 4 + 4].copy_from_slice(&word.to_le_bytes()));
}
#[no_mangle]
pub extern "C" fn shuffle(len: u32) {
    POOL.with(|p| {
        let mut p = p.borrow_mut();
        let mut rng = ChaCha20Rng::from_seed(p.seed);
        p.order = (0..len as usize).collect();
        p.order.shuffle(&mut rng);
    });
}
#[no_mangle]
pub extern "C" fn shuffled_at(index: u32) -> u32 {
    POOL.with(|p| p.borrow().order[index as usize] as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audited_false_success_and_duplicates() {
        reset();
        let msg = message_new(768, 32, 72, 0);
        let r = decoder_new(msg);
        let ids = [4,17,0,30,1,2,9,7,10,12,50,20,26,18,24,22,27,29,31,32,67,35,39,45,52,56,60,57,63,62,64,68,70];
        for id in ids { assert_eq!(receive(r, id), 0); assert_eq!(receive(r, id), 2); }
        assert_eq!(received_count(r), 33);
        assert_eq!(receive(r, 72), -1);
        let mut decoded = false;
        for id in 0..72 { decoded |= receive(r, id) == 1; }
        assert!(decoded);
        assert_eq!(received_count(r), 72);
    }
    #[test]
    fn complete_stream_sizes() {
        for len in [1, 768, 32*1024, 64*1024, 128*1024, 256*1024] {
            reset();
            let symbol_len = 1159;
            let n = (len as usize).div_ceil(symbol_len) * 3;
            let m = message_new(len, symbol_len as u32, n as u32, 19);
            let r = decoder_new(m);
            assert!((0..n).any(|id| receive(r, id as u32) == 1));
        }
    }

    #[test]
    fn input_bytes_roundtrip_and_decoder_restart() {
        reset();
        let source: Vec<u8> = (0..65536).map(|i| ((i * 17 + i / 7) % 256) as u8).collect();
        POOL.with(|p| p.borrow_mut().input = source.clone());
        let m = message_from_input(1024, 160);
        assert_eq!(message_source_symbols(m), 64);
        let r = decoder_new(m);
        for _ in 0..2 {
            assert_eq!(recovered_len(r), 0);
            let mut complete = false;
            for esi in (0..130).rev() {
                POOL.with(|p| {
                    let mut p = p.borrow_mut();
                    p.input = p.messages[m as usize].symbols[esi as usize].clone();
                });
                let status = receive_input(r, esi);
                assert_eq!(receive_input(r, esi), 2);
                if status == 1 { complete = true; break; }
            }
            assert!(complete);
            POOL.with(|p| assert_eq!(p.borrow().receivers[r as usize].recovered, source));
            decoder_restart(r);
            assert_eq!(received_count(r), 0);
        }
        POOL.with(|p| p.borrow_mut().input = vec![0; 3]);
        assert_eq!(receive_input(r, 0), -1);
        assert_eq!(received_count(r), 0);
    }
}
