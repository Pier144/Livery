//! meshoptimizer's index-sequence decoder (`meshopt_decodeIndexSequence`, MIT), which the game's
//! packs use for packed index buffers. Only decoding is needed, and it is short enough to port.

use super::bad;
use crate::error::AppResult;

/// Bytes of zero padding that end a stream.
const TAIL: usize = 4;

/// Decodes `count` indices. Byte 0 is `0xD0 | version` (0 or 1); then one vbyte `v` per index
/// (7 bits per byte, least significant group first, high bit = more, at most 5 bytes):
/// `cur = v & 1; v >>= 1; d = (v >> 1) ^ -(v & 1); idx = last[cur] + d; last[cur] = idx`. The
/// stream ends with 4 zero bytes and decoding must stop exactly at `len - 4`. Wrapping `u32`
/// arithmetic throughout, as in the original.
pub fn decode_index_sequence(buf: &[u8], count: usize) -> AppResult<Vec<u32>> {
    let (&head, rest) = buf.split_first().ok_or_else(|| bad("empty index stream"))?;
    if head & 0xF0 != 0xD0 || head & 0x0F > 1 {
        return Err(bad(format!("index stream header {head:#04X}")));
    }
    let data_len = rest.len().checked_sub(TAIL).ok_or_else(|| bad("index stream shorter than its tail"))?;
    let data = &rest[..data_len];
    // Every index takes at least one byte: refuse a count the stream can't hold before allocating.
    if count > data.len() {
        return Err(bad(format!("{count} indices in {} bytes", data.len())));
    }

    let mut out = Vec::with_capacity(count);
    let mut last = [0u32; 2];
    let mut at = 0;
    for _ in 0..count {
        let mut v = 0u32;
        let mut done = false;
        for group in 0..5 {
            let byte = *data.get(at).ok_or_else(|| bad("index stream truncated"))?;
            at += 1;
            v |= u32::from(byte & 0x7F) << (7 * group);
            if byte < 0x80 {
                done = true;
                break;
            }
        }
        if !done {
            return Err(bad("index stream: number longer than 5 bytes"));
        }
        let cur = (v & 1) as usize;
        v >>= 1;
        let delta = (v >> 1) ^ 0u32.wrapping_sub(v & 1);
        last[cur] = last[cur].wrapping_add(delta);
        out.push(last[cur]);
    }
    if at != data.len() {
        return Err(bad(format!("index stream has {} bytes left after {count} indices", data.len() - at)));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    /// The mirror of the decoder: `(index, which "last" it is coded against)` per index.
    fn encode(version: u8, indices: &[(u32, usize)]) -> Vec<u8> {
        let mut out = vec![0xD0 | version];
        let mut last = [0u32; 2];
        for &(idx, cur) in indices {
            let d = idx.wrapping_sub(last[cur]) as i32;
            let zigzag = ((d << 1) ^ (d >> 31)) as u32;
            let mut v = (zigzag << 1) | cur as u32;
            last[cur] = idx;
            loop {
                let low = (v & 0x7F) as u8;
                v >>= 7;
                if v == 0 {
                    out.push(low);
                    break;
                }
                out.push(low | 0x80);
            }
        }
        out.extend_from_slice(&[0; TAIL]);
        out
    }

    fn single(indices: &[u32]) -> Vec<(u32, usize)> {
        indices.iter().map(|&i| (i, 0)).collect()
    }

    fn is_parse(r: AppResult<Vec<u32>>) -> bool {
        r.is_err_and(|e| e.code == ErrorCode::Parse)
    }

    #[test]
    fn decodes_a_sequence_coded_against_one_last_value() {
        let indices = [0, 1, 2, 2, 1, 3, 100_000, 5];
        for version in [0, 1] {
            let buf = encode(version, &single(&indices));
            assert_eq!(decode_index_sequence(&buf, indices.len()).unwrap(), indices, "version {version}");
        }
    }

    #[test]
    fn decodes_both_last_values() {
        let coded = [(10, 0), (500, 1), (11, 0), (498, 1), (12, 0), (7, 1), (0, 0), (u32::MAX, 1)];
        let want: Vec<u32> = coded.iter().map(|&(i, _)| i).collect();
        assert_eq!(decode_index_sequence(&encode(1, &coded), coded.len()).unwrap(), want);
    }

    #[test]
    fn five_byte_numbers_and_wrapping_work() {
        let indices = [0, 1 << 29, 0, u32::MAX, 0];
        let buf = encode(0, &single(&indices));
        assert_eq!(decode_index_sequence(&buf, indices.len()).unwrap(), indices);
        // Header, then 1 + 5 + 5 + 1 + 1 bytes of numbers (0 -> 2^29 and back need 5 each), then the tail.
        assert_eq!(buf.len(), 1 + (1 + 5 + 5 + 1 + 1) + TAIL, "{buf:02X?}");
    }

    #[test]
    fn an_empty_sequence_is_a_header_and_a_tail() {
        assert_eq!(decode_index_sequence(&encode(0, &[]), 0).unwrap(), Vec::<u32>::new());
    }

    #[test]
    fn a_bad_header_is_an_error() {
        let good = encode(0, &single(&[1, 2, 3]));
        for head in [0x00, 0xC0, 0xD2, 0xE0, 0xDF, 0xFF] {
            let mut buf = good.clone();
            buf[0] = head;
            assert!(is_parse(decode_index_sequence(&buf, 3)), "{head:#04X}");
        }
        assert!(is_parse(decode_index_sequence(&[], 0)));
    }

    #[test]
    fn a_truncated_stream_is_an_error() {
        let buf = encode(0, &single(&[1, 2, 300_000]));
        // No tail, a short tail, the tail only.
        for cut in [1, 2, 3, buf.len() - 5, buf.len() - 4, buf.len() - 1] {
            assert!(is_parse(decode_index_sequence(&buf[..cut], 3)), "cut at {cut}");
        }
        // More indices than bytes: refused without allocating the count.
        assert!(is_parse(decode_index_sequence(&buf, 4)));
        assert!(is_parse(decode_index_sequence(&buf, usize::MAX)));
        // A number that runs into the tail.
        let mut cut = vec![0xD0, 0x80];
        cut.extend_from_slice(&[0; TAIL]);
        assert!(is_parse(decode_index_sequence(&cut, 1)));
    }

    #[test]
    fn stopping_before_the_tail_is_an_error() {
        let buf = encode(0, &single(&[1, 2, 3, 4]));
        assert!(is_parse(decode_index_sequence(&buf, 3)), "one index left over");
        assert!(is_parse(decode_index_sequence(&buf, 0)));
    }

    #[test]
    fn a_number_longer_than_five_bytes_is_an_error() {
        let mut buf = vec![0xD0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00];
        buf.extend_from_slice(&[0; TAIL]);
        assert!(is_parse(decode_index_sequence(&buf, 1)));
        // Exactly five bytes are fine.
        let mut ok = vec![0xD0, 0x80, 0x80, 0x80, 0x80, 0x01];
        ok.extend_from_slice(&[0; TAIL]);
        assert_eq!(decode_index_sequence(&ok, 1).unwrap().len(), 1);
    }

    #[test]
    fn random_bytes_never_panic() {
        let mut seed: u32 = 77;
        for round in 0..3000usize {
            let len = round % 40;
            let mut buf: Vec<u8> = (0..len)
                .map(|_| {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    (seed >> 16) as u8
                })
                .collect();
            if let Some(first) = buf.first_mut() {
                *first = 0xD0 | (round as u8 & 1);
            }
            let _ = decode_index_sequence(&buf, round % 12);
        }
    }
}
