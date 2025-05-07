// src/lib.rs

use std::collections::HashMap;
use std::io::{self, Write, BufRead, BufReader};
use std::net::Ipv4Addr;
use std::fs::File;
use std::sync::{Arc, Mutex};

/// The OCaml
///   type op_result = Float of float | Int of int | IPv4 of Ipaddr.V4.t | MAC of Bytes.t | Empty
#[derive(Clone, Debug)]
pub enum OpResult {
    Float(f64),
    Int(i32),
    IPv4(Ipv4Addr),
    MAC([u8; 6]),
    Empty,
}

/// A Tuple is just a map from String → OpResult
pub type Tuple = HashMap<String, OpResult>;

/// An Operator has two callbacks: next and reset.
/// In Rust we box them up as trait objects.
pub struct Operator {
    pub next: Box<dyn Fn(&Tuple) + Send + Sync>,
    pub reset: Box<dyn Fn(&Tuple) + Send + Sync>,
}

/// Type aliases for CPS-style constructors
pub type OpCreator = Box<dyn Fn(Operator) -> Operator + Send + Sync>;
pub type DblOpCreator = Box<dyn Fn(Operator) -> (Operator, Operator) + Send + Sync>;

/// “Chaining” functions
pub fn chain(opc: OpCreator, next_op: Operator) -> Operator {
    opc(next_op)
}
pub fn chain2(dbc: DblOpCreator, op: Operator) -> (Operator, Operator) {
    dbc(op)
}


/// --- Conversion utilities ---

/// formats 6-byte MAC to “aa:bb:cc:dd:ee:ff”
pub fn string_of_mac(buf: &[u8;6]) -> String {
    buf.iter()
       .map(|b| format!("{:02x}", b))
       .collect::<Vec<_>>()
       .join(":")
}

/// decodes TCP flags into “SYN|ACK|…” strings
pub fn tcp_flags_to_strings(flags: u8) -> String {
    // same as OCaml’s Map.Make; here a simple static list
    let all = [
        ("FIN", 1 << 0),
        ("SYN", 1 << 1),
        ("RST", 1 << 2),
        ("PSH", 1 << 3),
        ("ACK", 1 << 4),
        ("URG", 1 << 5),
        ("ECE", 1 << 6),
        ("CWR", 1 << 7),
    ];
    all.iter()
       .filter_map(|&(name, bit)| if flags & bit == bit { Some(name) } else { None })
       .collect::<Vec<_>>()
       .join("|")
}

/// extract int or panic
pub fn int_of_op_result(r: &OpResult) -> i32 {
    match r {
        OpResult::Int(i) => *i,
        _ => panic!("Trying to extract int from {:?}", r),
    }
}

/// extract float or panic
pub fn float_of_op_result(r: &OpResult) -> f64 {
    match r {
        OpResult::Float(f) => *f,
        _ => panic!("Trying to extract float from {:?}", r),
    }
}

/// stringify any OpResult
pub fn string_of_op_result(r: &OpResult) -> String {
    match r {
        OpResult::Float(f) => format!("{}", f),
        OpResult::Int(i)   => format!("{}", i),
        OpResult::IPv4(a)  => a.to_string(),
        OpResult::MAC(m)   => string_of_mac(m),
        OpResult::Empty    => "Empty".into(),
    }
}

/// show a whole Tuple as `"k" => v, `
pub fn string_of_tuple(t: &Tuple) -> String {
    t.iter()
     .map(|(k,v)| format!("\"{}\" => {}, ", k, string_of_op_result(v)))
     .collect()
}

/// build a Tuple from a Vec of pairs
pub fn tuple_of_list(v: Vec<(String, OpResult)>) -> Tuple {
    v.into_iter().collect()
}

/// dump to any Write (stdout, file…)
pub fn dump_tuple<W: Write>(out: &mut W, t: &Tuple) -> io::Result<()> {
    writeln!(out, "{}", string_of_tuple(t))
}

/// lookup helpers
pub fn lookup_int(key: &str, t: &Tuple) -> i32 {
    int_of_op_result(&t[key])
}
pub fn lookup_float(key: &str, t: &Tuple) -> f64 {
    float_of_op_result(&t[key])
}


/// --- Built-in operator definitions ---

/// dump_tuple “operator”
pub fn op_dump_tuple(show_reset: bool, mut out: Box<dyn Write + Send + Sync>) -> Operator {
    let show_reset = show_reset;
    Operator {
        next: Box::new(move |tup: &Tuple| {
            let _ = dump_tuple(&mut *out, tup);
        }),
        reset: Box::new(move |tup: &Tuple| {
            if show_reset {
                let _ = dump_tuple(&mut *out, tup);
                let _ = writeln!(&mut *out, "[reset]");
            }
        }),
    }
}

/// CSV dumping
pub fn op_dump_csv(
    static_field: Option<(String,String)>,
    header: bool,
    mut out: Box<dyn Write + Send + Sync>
) -> Operator {
    let first = Arc::new(Mutex::new(header));
    Operator {
        next: Box::new(move |tup: &Tuple| {
            let mut first = first.lock().unwrap();
            if *first {
                if let Some((ref k,_)) = static_field { write!(&mut *out, "{},", k).ok(); }
                for key in tup.keys() { write!(&mut *out, "{},", key).ok(); }
                writeln!(&mut *out).ok();
                *first = false;
            }
            if let Some((_, ref v)) = static_field { write!(&mut *out, "{},", v).ok(); }
            for val in tup.values() {
                write!(&mut *out, "{},", string_of_op_result(val)).ok();
            }
            writeln!(&mut *out).ok();
        }),
        reset: Box::new(|_tup| {}),
    }
}

/// “epoch” operator: resets every epoch_width seconds
pub fn op_epoch(epoch_width: f64, key_out: String) -> OpCreator {
    Box::new(move |next_op: Operator| {
        let boundary = Arc::new(Mutex::new(0.0));
        let eid = Arc::new(Mutex::new(0));
        Operator {
            next: {
                let boundary = Arc::clone(&boundary);
                let eid = Arc::clone(&eid);
                let key_out = key_out.clone();
                let next_op = next_op.next.clone();
                let reset_op = next_op.clone();
                Box::new(move |tup: &Tuple| {
                    let time = float_of_op_result(&tup["time"]);
                    let mut b = boundary.lock().unwrap();
                    let mut e = eid.lock().unwrap();
                    if *b == 0.0 {
                        *b = time + epoch_width;
                    } else if time >= *b {
                        while time >= *b {
                            let mut reset_tup = Tuple::new();
                            reset_tup.insert(key_out.clone(), OpResult::Int(*e));
                            reset_op(&reset_tup);
                            *b += epoch_width;
                            *e += 1;
                        }
                    }
                    let mut out_tup = tup.clone();
                    out_tup.insert(key_out.clone(), OpResult::Int(*e));
                    next_op(&out_tup);
                })
            },
            reset: {
                let boundary = Arc::clone(&boundary);
                let eid = Arc::clone(&eid);
                let key_out = key_out.clone();
                let next_reset = next_op.reset.clone();
                Box::new(move |_tup: &Tuple| {
                    let mut reset_tup = Tuple::new();
                    let e = *eid.lock().unwrap();
                    reset_tup.insert(key_out.clone(), OpResult::Int(e));
                    next_reset(&reset_tup);
                    *boundary.lock().unwrap() = 0.0;
                    *eid.lock().unwrap() = 0;
                })
            }
        }
    })
}

/// “filter” operator
pub fn op_filter<F>(pred: F) -> OpCreator
where F: Fn(&Tuple) -> bool + Send + Sync + 'static
{
    Box::new(move |next_op: Operator| {
        let pred = pred.clone();
        Operator {
            next: Box::new(move |tup: &Tuple| {
                if pred(tup) {
                    next_op.next(tup);
                }
            }),
            reset: next_op.reset.clone(),
        }
    })
}

/// “map” operator
pub fn op_map<F>(func: F) -> OpCreator
where F: Fn(&Tuple) -> Tuple + Send + Sync + 'static
{
    Box::new(move |next_op: Operator| {
        let func = func.clone();
        Operator {
            next: Box::new(move |tup: &Tuple| {
                let t2 = func(tup);
                next_op.next(&t2);
            }),
            reset: next_op.reset.clone(),
        }
    })
}

/// You can now build pipelines exactly as in OCaml:
///
/// ```ignore
/// let my_pipeline =
///     chain(op_epoch(1.0, "eid".into()),
///     chain(op_filter(|t| lookup_int("ipv4.proto", t) == 6),
///     chain(op_map(|t| {/* ... */}), op_dump_tuple(false, Box::new(io::stdout())))));
/// ```
///
/// And you can run it on a sequence of tuples just like `run_queries` in OCaml.
