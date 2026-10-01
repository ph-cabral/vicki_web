use boringtun::noise::{rate_limiter::RateLimiter, Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use base64::Engine;
use std::net::UdpSocket;
use std::sync::Arc;

fn csum(h: &[u8]) -> u16 {
    let mut s: u32 = 0;
    for i in (0..h.len()).step_by(2) { s += ((h[i] as u32) << 8) | h[i + 1] as u32; }
    while s > 0xffff { s = (s & 0xffff) + (s >> 16); }
    !(s as u16)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let b64 = base64::engine::general_purpose::STANDARD;
    let mode = args[1].clone();
    let client_pub: [u8; 32] = b64.decode(&args[2]).unwrap().try_into().unwrap();
    let sk = StaticSecret::from([7u8; 32]);
    let pk = PublicKey::from(&sk);
    println!("SERVERPUB {}", b64.encode(pk.as_bytes()));
    let rl = if mode == "cookie" { Some(Arc::new(RateLimiter::new(&pk, 0))) } else { None };
    let mut t = Tunn::new(sk, PublicKey::from(client_pub), None, None, 42, rl).unwrap();
    let sock = UdpSocket::bind("127.0.0.1:51999").unwrap();
    let mut buf = vec![0u8; 65536];
    let mut out = vec![0u8; 65536];
    let mut out2 = vec![0u8; 65536];
    loop {
        let (n, src) = sock.recv_from(&mut buf).unwrap();
        eprintln!("rx type={} len={}", buf[0], n);
        match t.decapsulate(Some(src.ip()), &buf[..n], &mut out) {
            TunnResult::WriteToNetwork(p) => {
                eprintln!("tx type={} len={}", p[0], p.len());
                sock.send_to(p, src).unwrap();
                loop {
                    match t.decapsulate(None, &[], &mut out) {
                        TunnResult::WriteToNetwork(p) => { sock.send_to(p, src).unwrap(); }
                        _ => break,
                    }
                }
            }
            TunnResult::WriteToTunnelV4(p, a) => {
                let mut r = p.to_vec();
                eprintln!("ip from {} len={}", a, r.len());
                let (s, d) = (r[12..16].to_vec(), r[16..20].to_vec());
                r[12..16].copy_from_slice(&d);
                r[16..20].copy_from_slice(&s);
                if &r[20..24] == b"PING" { r[20..24].copy_from_slice(b"PONG"); }
                r[10] = 0; r[11] = 0;
                let c = csum(&r[..20]);
                r[10] = (c >> 8) as u8; r[11] = c as u8;
                if let TunnResult::WriteToNetwork(p) = t.encapsulate(&r, &mut out2) { sock.send_to(p, src).unwrap(); }
            }
            TunnResult::Done => { eprintln!("done (keepalive?)"); }
            TunnResult::Err(e) => { eprintln!("ERR {:?}", e); }
            _ => {}
        }
    }
}
