use std::collections::HashMap;
use std::fmt;
use ipnetwork::Ipv4Network;
use bytes::Bytes;

#[derive(Debug, Clone, PartialEq)]
pub enum OpResult {
    Float(f64),
    Int(i32),
    IPv4(Ipv4Network),
    MAC(Bytes),
    Empty,
}

pub type Tuple = HashMap<String, OpResult>;

impl fmt::Display for OpResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpResult::Float(val) => write!(f, "{:.6}", val),
            OpResult::Int(val) => write!(f, "{}", val),
            OpResult::IPv4(addr) => write!(f, "{}", addr),
            OpResult::MAC(mac) => {
                let slice = mac.as_ref();
                write!(
                    f,
                    "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
                    slice[0], slice[1], slice[2], slice[3], slice[4], slice[5]
                )
            }
            OpResult::Empty => write!(f, "Empty"),
        }
    }
}

pub fn int_of_op_result(input: &OpResult) -> i32 {
    match input {
        OpResult::Int(i) => *i,
        _ => panic!("Expected Int variant"),
    }
}

pub fn float_of_op_result(input: &OpResult) -> f64 {
    match input {
        OpResult::Float(f) => *f,
        _ => panic!("Expected Float variant"),
    }
}

pub fn string_of_tuple(t: &Tuple) -> String {
    t.iter()
        .map(|(k, v)| format!("\"{}\" => {}", k, v))
        .collect::<Vec<String>>()
        .join(", ")
}
