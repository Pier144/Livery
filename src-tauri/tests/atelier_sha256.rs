//! The in-house SHA-256 against the NIST FIPS 180-4 example vectors, fed whole and in odd pieces.

use livery_lib::atelier::sha256::{digest, file_hex, hex, Sha256};

const VECTORS: [(&str, &str); 4] = [
    ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
    (
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ),
    (
        "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
        "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1",
    ),
];

#[test]
fn nist_vectors() {
    for (message, expected) in VECTORS {
        assert_eq!(hex(&digest(message.as_bytes())), expected, "{message:?}");
    }
}

#[test]
fn nist_vectors_in_pieces() {
    for (message, expected) in VECTORS {
        for piece in [1, 3, 7, 55, 56, 63, 64, 65] {
            let mut hasher = Sha256::new();
            message.as_bytes().chunks(piece).for_each(|c| hasher.update(c));
            assert_eq!(hex(&hasher.finalize()), expected, "{message:?} in pieces of {piece}");
        }
    }
}

#[test]
fn one_million_a() {
    let mut hasher = Sha256::new();
    let chunk = [b'a'; 1000];
    for _ in 0..1000 {
        hasher.update(&chunk);
    }
    assert_eq!(hex(&hasher.finalize()), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
}

#[test]
fn lengths_around_the_padding_boundary() {
    // Each length hashed whole equals the same bytes fed one by one.
    for len in 50..=130 {
        let data: Vec<u8> = (0..len).map(|i| (i * 7 + 3) as u8).collect();
        let mut hasher = Sha256::new();
        data.iter().for_each(|b| hasher.update(std::slice::from_ref(b)));
        assert_eq!(hasher.finalize(), digest(&data), "{len}");
    }
}

#[test]
fn hashes_a_file() {
    let path = std::env::temp_dir().join(format!("livery-sha256-{}.bin", std::process::id()));
    std::fs::write(&path, b"abc").unwrap();
    assert_eq!(file_hex(&path).unwrap(), VECTORS[1].1);
    let _ = std::fs::remove_file(&path);
}
