mod types;
mod operator;

use types::*;
use operator::*;

fn main() {
    let next_op = DumpTupleOperator::new(true);

    let op = compose(
        |n| EpochOperator::new(1.0, "eid", n),
        compose(
            |n| MapOperator::new(
                |t| {
                    let mut t = t.clone();
                    t.insert("value".into(), OpResult::Int(42));
                    t
                },
                n,
            ),
            next_op,
        ),
    );

    // Feed in some example tuples
    for i in 0..5 {
        let mut tup = Tuple::new();
        tup.insert("time".into(), OpResult::Float(i as f64));
        op.borrow_mut().next(&tup);
    }

    op.borrow_mut().reset(&Tuple::new());
}
