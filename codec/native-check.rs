use std::io::{self, BufRead};
use monad_raptor::{Encoder, ManagedDecoder};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let mut fields = line.split_whitespace();
        let name = fields.next().unwrap();
        let nums: Vec<usize> = fields.map(|n| n.parse().unwrap()).collect();
        let (len, symbol_len, n, salt) = (nums[0], nums[1], nums[2], nums[3]);
        let source: Vec<u8> = (0..len).map(|i| ((i as u32).wrapping_mul(37) ^ (i as u32 / 11) ^ salt as u32) as u8).collect();
        let encoder = Encoder::new(&source, symbol_len).unwrap();
        let mut decoder = ManagedDecoder::new(encoder.num_source_symbols(), n, symbol_len).unwrap();
        let mut at = 0;
        for (i, &esi) in nums[4..].iter().enumerate() {
            let mut buf = vec![0; symbol_len];
            encoder.encode_symbol(&mut buf, esi);
            decoder.received_encoded_symbol(&buf, esi);
            if decoder.try_decode() {
                let mut got = decoder.reconstruct_source_data().unwrap();
                got.truncate(len);
                assert_eq!(got, source);
                at = i + 1;
                break;
            }
        }
        println!("{} {}", name, at);
    }
}
