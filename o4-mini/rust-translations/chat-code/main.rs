use std::sync::{Arc, Mutex};

/// Utility aliases for grouping & reduction functions
pub type GroupingFunc   = Arc<dyn Fn(&Tuple)->Tuple + Send + Sync>;
pub type ReductionFunc  = Arc<dyn Fn(&OpResult,&Tuple)->OpResult + Send + Sync>;
pub type KeyExtractor   = Arc<dyn Fn(&Tuple)->(Tuple,Tuple) + Send + Sync>;

///
/// filter_groups: pick only the listed keys out of a Tuple
///
pub fn filter_groups(incl_keys: Vec<String>) 
  -> impl Fn(&Tuple)->Tuple + Send + Sync + 'static 
{
    Arc::new(move |tup: &Tuple| {
        let mut out = Tuple::new();
        for k in &incl_keys {
            if let Some(v) = tup.get(k) {
                out.insert(k.clone(), v.clone());
            }
        }
        out
    })
}

/// single_group: everything in one bucket
pub fn single_group(_: &Tuple) -> Tuple {
    Tuple::new()
}

/// counter: fold function that just increments an Int
pub fn counter(val: &OpResult, _: &Tuple) -> OpResult {
    match val {
        OpResult::Empty    => OpResult::Int(1),
        OpResult::Int(i)   => OpResult::Int(i + 1),
        other              => other.clone(),
    }
}

/// sum_ints: fold function that sums the Int under `search_key`
pub fn sum_ints(search_key: String)
  -> impl Fn(&OpResult,&Tuple)->OpResult + Send + Sync + 'static
{
    Arc::new(move |init, tup| {
        let base = match init {
            OpResult::Empty    => 0,
            OpResult::Int(i)   => *i,
            _                  => panic!("sum_ints got {:?}", init),
        };
        if let Some(OpResult::Int(n)) = tup.get(&search_key) {
            OpResult::Int(base + n)
        } else {
            panic!("sum_ints: key {} missing or not Int", search_key);
        }
    })
}

/// --- groupby ---
pub fn op_groupby(
    grouping:  GroupingFunc,
    reduce:    ReductionFunc,
    out_key:   String,
) -> OpCreator {
    Box::new(move |next_op| {
        let state = Arc::new(Mutex::new(Vec::<(Tuple,OpResult)>::new()));
        Operator {
            next: Box::new({
                let state     = state.clone();
                let grouping  = grouping.clone();
                let reduce    = reduce.clone();
                move |tup: &Tuple| {
                    let key = (grouping)(tup);
                    let mut st = state.lock().unwrap();
                    // find an existing group?
                    if let Some((_, acc)) = st.iter_mut()
                        .find(|(k, _)| k == &key)
                    {
                        *acc = (reduce)(acc, tup);
                    } else {
                        let v = (reduce)(&OpResult::Empty, tup);
                        st.push((key, v));
                    }
                }
            }),
            reset: Box::new({
                let state   = state.clone();
                let out_key = out_key.clone();
                let next_fn = next_op.next.clone();
                let reset_fn= next_op.reset.clone();
                move |tup: &Tuple| {
                    let groups = std::mem::take(&mut *state.lock().unwrap());
                    for (gk, val) in groups {
                        // union reset‐tuple and grouping key
                        let mut out = tup.clone();
                        for (k,v) in gk {
                            out.insert(k, v);
                        }
                        out.insert(out_key.clone(), val);
                        (next_fn)(&out);
                    }
                    (reset_fn)(tup);
                }
            }),
        }
    })
}

/// --- distinct ---
pub fn op_distinct(grouping: GroupingFunc) -> OpCreator {
    Box::new(move |next_op| {
        let seen = Arc::new(Mutex::new(Vec::<Tuple>::new()));
        Operator {
            next: Box::new({
                let seen     = seen.clone();
                let grouping = grouping.clone();
                move |tup: &Tuple| {
                    let key = (grouping)(tup);
                    let mut s = seen.lock().unwrap();
                    if !s.iter().any(|k| k == &key) {
                        s.push(key);
                    }
                }
            }),
            reset: Box::new({
                let seen    = seen.clone();
                let next_fn = next_op.next.clone();
                let reset_fn= next_op.reset.clone();
                move |tup: &Tuple| {
                    let keys = std::mem::take(&mut *seen.lock().unwrap());
                    for key in keys {
                        let mut out = tup.clone();
                        for (k,v) in key {
                            out.insert(k, v);
                        }
                        (next_fn)(&out);
                    }
                    (reset_fn)(tup);
                }
            }),
        }
    })
}

/// --- split (fan‐out) ---
pub fn op_split(l: Operator, r: Operator) -> Operator {
    Operator {
        next:  Box::new(move |t| { (l.next)(t);  (r.next)(t)  }),
        reset: Box::new(move |t| { (l.reset)(t); (r.reset)(t) }),
    }
}

/// rename_filtered_keys: (old_key → new_key) renaming
pub fn rename_filtered_keys(
    renames: Vec<(String,String)>
) -> impl Fn(&Tuple)->Tuple + Send + Sync + 'static {
    Arc::new(move |tup: &Tuple| {
        let mut out = Tuple::new();
        for (old,new) in &renames {
            if let Some(v) = tup.get(old) {
                out.insert(new.clone(), v.clone());
            }
        }
        out
    })
}

/// --- join (two‐stream) ---
pub fn op_join(
    eid_key: String,
    left_ext:  KeyExtractor,
    right_ext: KeyExtractor,
) -> DblOpCreator {
    Box::new(move |next_op| {
        let left_state  = Arc::new(Mutex::new(Vec::<(Tuple,Tuple)>::new()));
        let right_state = Arc::new(Mutex::new(Vec::<(Tuple,Tuple)>::new()));
        let left_epoch  = Arc::new(Mutex::new(0));
        let right_epoch = Arc::new(Mutex::new(0));

        let make_side = |my_state: Arc<Mutex<_>>,
                         other_state: Arc<Mutex<_>>,
                         my_epoch: Arc<Mutex<_>>,
                         other_epoch: Arc<Mutex<_>>,
                         extractor: KeyExtractor| {
            let next_fn = next_op.next.clone();
            Operator {
                next: Box::new(move |tup: &Tuple| {
                    let epoch = lookup_int(&eid_key, tup);
                    // (you could advance & reset epochs here…)
                    let (k0,vals0) = (extractor)(tup);
                    let mut key = k0.clone();
                    key.insert(eid_key.clone(), OpResult::Int(epoch));
                    let mut other = other_state.lock().unwrap();
                    if let Some(idx) = other.iter().position(|(k,_)| *k == key) {
                        let (_, v1) = other.remove(idx);
                        // merge vals0 + v1
                        let mut out = key.clone();
                        for (kk,vv) in vals0.iter().chain(v1.iter()) {
                            out.insert(kk.clone(), vv.clone());
                        }
                        (next_fn)(&out);
                    } else {
                        my_state.lock().unwrap().push((key, vals0));
                    }
                }),
                reset: Box::new(move |_tup| {
                    // optional epoch‐rollover logic
                })
            }
        };

        let left  = make_side(
            left_state.clone(),
            right_state.clone(),
            left_epoch.clone(),
            right_epoch.clone(),
            left_ext.clone()
        );
        let right = make_side(
            right_state.clone(),
            left_state.clone(),
            right_epoch.clone(),
            left_epoch.clone(),
            right_ext.clone()
        );
        (left, right)
    })
}

/// --- high‐level pipelines (“Sonata” queries) ---

pub fn ident(next_op: Operator) -> Operator {
    // drop eth.src .eth.dst, then pass on
    let m = op_map(Arc::new(|t: &Tuple| {
        t.iter()
         .filter(|(k,_)| k != "eth.src" && k != "eth.dst")
         .map(|(k,v)| (k.clone(), v.clone()))
         .collect()
    }));
    chain(m, next_op)
}

pub fn count_pkts(next_op: Operator) -> Operator {
    chain(
        op_epoch(1.0, "eid".into()),
        chain(
            op_groupby(
                Arc::new(single_group),
                Arc::new(counter),
                "pkts".into()
            ),
            next_op
        )
    )
}

pub fn super_spreader(next_op: Operator) -> Operator {
    chain(
        op_epoch(1.0, "eid".into()),
        chain(
            op_distinct(Arc::new(filter_groups(vec![
                "ipv4.src".into(), "ipv4.dst".into()
            ]))),
            chain(
                op_groupby(
                    Arc::new(filter_groups(vec!["ipv4.src".into()])),
                    Arc::new(counter),
                    "dsts".into()
                ),
                next_op
            )
        )
    )
}

use std::sync::Arc;

/// Sonata 1: TCP new connections
pub fn tcp_new_cons(next_op: Operator) -> Operator {
    let threshold = 40;
    // stage 4: filter on cons ≥ threshold, then next_op
    let stage4 = chain(
        op_filter(Arc::new(move |t| lookup_int("cons", t) >= threshold)),
        next_op,
    );
    // stage 3: groupby dst → counter “cons”
    let stage3 = chain(
        op_groupby(
            Arc::new(filter_groups(vec!["ipv4.dst".into()])),
            Arc::new(counter),
            "cons".into(),
        ),
        stage4,
    );
    // stage 2: only SYN packets
    let stage2 = chain(
        op_filter(Arc::new(|t| {
            lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) == 2
        })),
        stage3,
    );
    // stage 1: epoch
    chain(op_epoch(1.0, "eid".into()), stage2)
}

/// Sonata 2: SSH brute-force
pub fn ssh_brute_force(next_op: Operator) -> Operator {
    let threshold = 40;
    let stage4 = chain(
        op_filter(Arc::new(move |t| lookup_int("srcs", t) >= threshold)),
        next_op,
    );
    let stage3 = chain(
        op_groupby(
            Arc::new(filter_groups(vec!["ipv4.dst".into(), "ipv4.len".into()])),
            Arc::new(counter),
            "srcs".into(),
        ),
        stage4,
    );
    let stage2 = chain(
        op_distinct(Arc::new(filter_groups(vec![
            "ipv4.src".into(),
            "ipv4.dst".into(),
            "ipv4.len".into(),
        ]))),
        stage3,
    );
    let stage1 = chain(
        op_filter(Arc::new(|t| {
            lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.dport", t) == 22
        })),
        stage2,
    );
    chain(op_epoch(1.0, "eid".into()), stage1)
}

/// Sonata 3: distinct_srcs
pub fn distinct_srcs(next_op: Operator) -> Operator {
    let stage2 = chain(
        op_groupby(
            Arc::new(single_group),
            Arc::new(counter),
            "srcs".into(),
        ),
        next_op,
    );
    let stage1 = chain(
        op_distinct(Arc::new(filter_groups(vec!["ipv4.src".into()]))),
        stage2,
    );
    chain(op_epoch(1.0, "eid".into()), stage1)
}

/// Sonata 4: port_scan
pub fn port_scan(next_op: Operator) -> Operator {
    let threshold = 40;
    let stage4 = chain(
        op_filter(Arc::new(move |t| lookup_int("ports", t) >= threshold)),
        next_op,
    );
    let stage3 = chain(
        op_groupby(
            Arc::new(filter_groups(vec!["ipv4.src".into()])),
            Arc::new(counter),
            "ports".into(),
        ),
        stage4,
    );
    let stage2 = chain(
        op_distinct(Arc::new(filter_groups(vec![
            "ipv4.src".into(),
            "l4.dport".into(),
        ]))),
        stage3,
    );
    chain(op_epoch(1.0, "eid".into()), stage2)
}

/// Sonata 5: DDoS
pub fn ddos(next_op: Operator) -> Operator {
    let threshold = 45;
    let stage4 = chain(
        op_filter(Arc::new(move |t| lookup_int("srcs", t) >= threshold)),
        next_op,
    );
    let stage3 = chain(
        op_groupby(
            Arc::new(filter_groups(vec!["ipv4.dst".into()])),
            Arc::new(counter),
            "srcs".into(),
        ),
        stage4,
    );
    let stage2 = chain(
        op_distinct(Arc::new(filter_groups(vec![
            "ipv4.src".into(),
            "ipv4.dst".into(),
        ]))),
        stage3,
    );
    chain(op_epoch(1.0, "eid".into()), stage2)
}

/// Sonata 6: SYN-flood (joins syn, syn+synack, ack streams)
pub fn syn_flood_sonata(next_op: Operator) -> Vec<Operator> {
    let threshold = 3;
    let epoch_dur = 1.0;

    // simple builders for syn, synacks, acks
    let syns = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) == 2
                })),
                n,
            ),
        )
    };
    let synacks = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) == 18
                })),
                n,
            ),
        )
    };
    let acks = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) == 16
                })),
                n,
            ),
        )
    };

    // first join syn+synacks vs acks → compute diff → filter → next_op
    let join1_cont = chain(
        op_map(Arc::new(|t: &Tuple| {
            let sum = lookup_int("syns+synacks", t);
            let ack = lookup_int("acks", t);
            let diff = sum - ack;
            let mut o = t.clone();
            o.insert("syns+synacks-acks".into(), OpResult::Int(diff));
            o
        })),
        chain(
            op_filter(Arc::new(move |t| lookup_int("syns+synacks-acks", t) >= threshold)),
            next_op.clone(),
        ),
    );
    let (join_op1, join_op2) = chain2(
        op_join(
            "eid".into(),
            Arc::new(|t: &Tuple| {
                (filter_groups(vec!["host".into()])(t),
                 filter_groups(vec!["syns+synacks".into()])(t))
            }),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.dst".into(), "host".into())])(t),
                 filter_groups(vec!["acks".into()])(t))
            }),
        ),
        join1_cont,
    );

    // second join syn vs synack → sum → feed into join_op1
    let join2_cont = chain(
        op_map(Arc::new(|t: &Tuple| {
            let s = lookup_int("syns", t);
            let sa = lookup_int("synacks", t);
            let mut o = t.clone();
            o.insert("syns+synacks".into(), OpResult::Int(s + sa));
            o
        })),
        join_op1,
    );
    let (join_op3, join_op4) = chain2(
        op_join(
            "eid".into(),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.dst".into(), "host".into())])(t),
                 filter_groups(vec!["syns".into()])(t))
            }),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.src".into(), "host".into())])(t),
                 filter_groups(vec!["synacks".into()])(t))
            }),
        ),
        join2_cont,
    );

    vec![
        syns(join_op3),
        synacks(join_op4),
        acks(join_op2),
    ]
}

/// Sonata 7: completed_flows
pub fn completed_flows(next_op: Operator) -> Vec<Operator> {
    let threshold = 1;
    let epoch_dur = 30.0;
    let syns = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) & 2 == 2
                })),
                n,
            ),
        )
    };
    let fins = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) & 1 == 1
                })),
                n,
            ),
        )
    };

    let join_cont = chain(
        op_map(Arc::new(|t: &Tuple| {
            let syn = lookup_int("syns", t);
            let fin = lookup_int("fins", t);
            let mut o = t.clone();
            o.insert("diff".into(), OpResult::Int(syn - fin));
            o
        })),
        chain(
            op_filter(Arc::new(|t| lookup_int("diff", t) >= threshold)),
            next_op.clone(),
        ),
    );
    let (j1, j2) = chain2(
        op_join(
            "eid".into(),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.dst".into(), "host".into())])(t),
                 filter_groups(vec!["syns".into()])(t))
            }),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.src".into(), "host".into())])(t),
                 filter_groups(vec!["fins".into()])(t))
            }),
        ),
        join_cont,
    );
    vec![syns(j1), fins(j2)]
}

/// Sonata 8: slowloris
pub fn slowloris(next_op: Operator) -> Vec<Operator> {
    let t1 = 5;
    let t2 = 500;
    let t3 = 90;
    let epoch_dur = 1.0;

    let n_conns = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| lookup_int("ipv4.proto", t) == 6)),
                chain(
                    op_distinct(Arc::new(filter_groups(vec![
                        "ipv4.src".into(),
                        "ipv4.dst".into(),
                        "l4.sport".into(),
                    ]))),
                    chain(
                        op_groupby(
                            Arc::new(filter_groups(vec!["ipv4.dst".into()])),
                            Arc::new(counter),
                            "n_conns".into(),
                        ),
                        chain(
                            op_filter(Arc::new(move |t| lookup_int("n_conns", t) >= t1)),
                            n,
                        ),
                    ),
                ),
            ),
        )
    };

    let n_bytes = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| lookup_int("ipv4.proto", t) == 6)),
                chain(
                    op_groupby(
                        Arc::new(filter_groups(vec!["ipv4.dst".into()])),
                        Arc::new(sum_ints("ipv4.len".into())),
                        "n_bytes".into(),
                    ),
                    chain(
                        op_filter(Arc::new(move |t| lookup_int("n_bytes", t) >= t2)),
                        n,
                    ),
                ),
            ),
        )
    };

    let join_cont = chain(
        op_map(Arc::new(|t: &Tuple| {
            let bytes = lookup_int("n_bytes", t);
            let conns = lookup_int("n_conns", t);
            let mut o = t.clone();
            o.insert("bytes_per_conn".into(), OpResult::Int(bytes / conns));
            o
        })),
        chain(
            op_filter(Arc::new(move |t| lookup_int("bytes_per_conn", t) <= t3)),
            next_op.clone(),
        ),
    );
    let (j1, j2) = chain2(
        op_join(
            "eid".into(),
            Arc::new(|t: &Tuple| {
                (filter_groups(vec!["ipv4.dst".into()])(t),
                 filter_groups(vec!["n_conns".into()])(t))
            }),
            Arc::new(|t: &Tuple| {
                (filter_groups(vec!["ipv4.dst".into()])(t),
                 filter_groups(vec!["n_bytes".into()])(t))
            }),
        ),
        join_cont,
    );

    vec![n_conns(j1), n_bytes(j2)]
}

/// join_test
pub fn join_test(next_op: Operator) -> Vec<Operator> {
    let epoch_dur = 1.0;
    let syns = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) == 2
                })),
                n,
            ),
        )
    };
    let synacks = |n| {
        chain(
            op_epoch(epoch_dur, "eid".into()),
            chain(
                op_filter(Arc::new(|t| {
                    lookup_int("ipv4.proto", t) == 6 && lookup_int("l4.flags", t) == 18
                })),
                n,
            ),
        )
    };
    let (j1, j2) = chain2(
        op_join(
            "eid".into(),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.src".into(), "host".into())])(t),
                 rename_filtered_keys(vec![("ipv4.dst".into(), "remote".into())])(t))
            }),
            Arc::new(|t: &Tuple| {
                (rename_filtered_keys(vec![("ipv4.dst".into(), "host".into())])(t),
                 filter_groups(vec!["time".into()])(t))
            }),
        ),
        next_op.clone(),
    );
    vec![syns(j1), synacks(j2)]
}

/// q3
pub fn q3(next_op: Operator) -> Operator {
    chain(
        op_epoch(100.0, "eid".into()),
        chain(op_distinct(Arc::new(filter_groups(vec![
            "ipv4.src".into(),
            "ipv4.dst".into(),
        ]))), next_op),
    )
}

/// q4
pub fn q4(next_op: Operator) -> Operator {
    chain(
        op_epoch(10_000.0, "eid".into()),
        chain(
            op_groupby(
                Arc::new(filter_groups(vec!["ipv4.dst".into()])),
                Arc::new(counter),
                "pkts".into(),
            ),
            next_op,
        ),
    )
}


/// Finally, collect your queries and run them just like in OCaml:
pub fn run_queries() {
    let queries: Vec<Operator> = vec![
        ident(op_dump_tuple(false, Box::new(std::io::stdout()))),
        count_pkts(op_dump_tuple(false, Box::new(std::io::stdout()))),
        super_spreader(op_dump_tuple(false, Box::new(std::io::stdout()))),
        // … etc …
    ];

    for i in 0..20 {
        let mut t = Tuple::new();
        t.insert("time".into(), OpResult::Float(i as f64));
        t.insert("eth.src".into(), OpResult::MAC([0,17,34,51,68,85]));
        t.insert("eth.dst".into(), OpResult::MAC([170,187,204,221,238,255]));
        t.insert("eth.ethertype".into(), OpResult::Int(0x0800));
        t.insert("ipv4.hlen".into(), OpResult::Int(20));
        t.insert("ipv4.proto".into(), OpResult::Int(6));
        t.insert("ipv4.len".into(), OpResult::Int(60));
        t.insert("ipv4.src".into(),
                 OpResult::IPv4("127.0.0.1".parse().unwrap()));
        t.insert("ipv4.dst".into(),
                 OpResult::IPv4("127.0.0.1".parse().unwrap()));
        t.insert("l4.sport".into(), OpResult::Int(440));
        t.insert("l4.dport".into(), OpResult::Int(50000));
        t.insert("l4.flags".into(), OpResult::Int(10));

        for op in &queries {
            (op.next)(&t);
        }
    }

    println!("Done");
}

