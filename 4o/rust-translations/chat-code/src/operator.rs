use crate::types::*;
use std::collections::HashMap;
use std::rc::Rc;
use std::cell::RefCell;

pub trait Operator {
    fn next(&mut self, tup: &Tuple);
    fn reset(&mut self, ctx: &Tuple);
}

pub type OperatorBox = Rc<RefCell<dyn Operator>>;

/// Compose two operators like OCaml's `@=>` operator
pub fn compose(op_creator: impl Fn(OperatorBox) -> OperatorBox, next: OperatorBox) -> OperatorBox {
    op_creator(next)
}

/// DumpTupleOperator: prints tuples to stdout
pub struct DumpTupleOperator {
    show_reset: bool,
}

impl DumpTupleOperator {
    pub fn new(show_reset: bool) -> OperatorBox {
        Rc::new(RefCell::new(Self { show_reset }))
    }
}

impl Operator for DumpTupleOperator {
    fn next(&mut self, tup: &Tuple) {
        println!("{}", string_of_tuple(tup));
    }

    fn reset(&mut self, ctx: &Tuple) {
        if self.show_reset {
            println!("{}", string_of_tuple(ctx));
            println!("[reset]");
        }
    }
}

/// EpochOperator: assigns epoch IDs based on time
pub struct EpochOperator {
    width: f64,
    key_out: String,
    eid: i32,
    boundary: f64,
    next: OperatorBox,
}

impl EpochOperator {
    pub fn new(width: f64, key_out: &str, next: OperatorBox) -> OperatorBox {
        Rc::new(RefCell::new(Self {
            width,
            key_out: key_out.to_string(),
            eid: 0,
            boundary: 0.0,
            next,
        }))
    }
}

impl Operator for EpochOperator {
    fn next(&mut self, tup: &Tuple) {
        if let Some(OpResult::Float(time)) = tup.get("time") {
            if self.boundary == 0.0 {
                self.boundary = time + self.width;
            } else if *time >= self.boundary {
                while *time >= self.boundary {
                    let mut reset_tuple = Tuple::new();
                    reset_tuple.insert(self.key_out.clone(), OpResult::Int(self.eid));
                    self.next.borrow_mut().reset(&reset_tuple);
                    self.boundary += self.width;
                    self.eid += 1;
                }
            }

            let mut new_tuple = tup.clone();
            new_tuple.insert(self.key_out.clone(), OpResult::Int(self.eid));
            self.next.borrow_mut().next(&new_tuple);
        }
    }

    fn reset(&mut self, _: &Tuple) {
        let mut reset_tuple = Tuple::new();
        reset_tuple.insert(self.key_out.clone(), OpResult::Int(self.eid));
        self.next.borrow_mut().reset(&reset_tuple);
        self.boundary = 0.0;
        self.eid = 0;
    }
}

/// MapOperator: applies a transformation function to each tuple
pub struct MapOperator {
    func: Rc<dyn Fn(&Tuple) -> Tuple>,
    next: OperatorBox,
}

impl MapOperator {
    pub fn new(f: impl Fn(&Tuple) -> Tuple + 'static, next: OperatorBox) -> OperatorBox {
        Rc::new(RefCell::new(Self {
            func: Rc::new(f),
            next,
        }))
    }
}

impl Operator for MapOperator {
    fn next(&mut self, tup: &Tuple) {
        let new_tup = (self.func)(tup);
        self.next.borrow_mut().next(&new_tup);
    }

    fn reset(&mut self, ctx: &Tuple) {
        self.next.borrow_mut().reset(ctx);
    }
}
