import sys
import csv
import ipaddress
from typing import Dict, Callable, Tuple as PyTuple, List, Optional, Any
from dataclasses import dataclass

# ------------------------------------------------------------------------------
# op_result variants
# ------------------------------------------------------------------------------

class OpResult:
    pass

@dataclass
class FloatResult(OpResult):
    value: float

@dataclass
class IntResult(OpResult):
    value: int

@dataclass
class IPv4Result(OpResult):
    value: ipaddress.IPv4Address

@dataclass
class MACResult(OpResult):
    value: bytes

class EmptyResult(OpResult):
    pass

# A tuple is just a dict from string to OpResult
TupleType = Dict[str, OpResult]

# ------------------------------------------------------------------------------
# Operator record
# ------------------------------------------------------------------------------

class Operator:
    def __init__(self,
                 next_fn: Callable[[TupleType], None],
                 reset_fn: Callable[[TupleType], None]):
        self.next = next_fn
        self.reset = reset_fn

OpCreator = Callable[[Operator], Operator]
DblOpCreator = Callable[[Operator], tuple[Operator, Operator]]


def chain(op_creator: OpCreator, nxt: Operator) -> Operator:
    """ Right‐associate an OpCreator with the next operator """
    return op_creator(nxt)

def chain2(op_creator: DblOpCreator, op: Operator) -> tuple[Operator, Operator]:
    return op_creator(op)

# ------------------------------------------------------------------------------
# Conversion utilities
# ------------------------------------------------------------------------------

def string_of_mac(buf: bytes) -> str:
    return ":".join(f"{b:02x}" for b in buf)

def tcp_flags_to_strings(flags: int) -> str:
    flag_names = [
        ("FIN", 1 << 0),
        ("SYN", 1 << 1),
        ("RST", 1 << 2),
        ("PSH", 1 << 3),
        ("ACK", 1 << 4),
        ("URG", 1 << 5),
        ("ECE", 1 << 6),
        ("CWR", 1 << 7),
    ]
    active = [name for name, bit in flag_names if (flags & bit) == bit]
    return "|".join(active)

def int_of_op_result(x: OpResult) -> int:
    if isinstance(x, IntResult):
        return x.value
    raise ValueError("Trying to extract int from non-int result")

def float_of_op_result(x: OpResult) -> float:
    if isinstance(x, FloatResult):
        return x.value
    raise ValueError("Trying to extract float from non-float result")

def string_of_op_result(x: OpResult) -> str:
    if isinstance(x, FloatResult):
        return f"{x.value:f}"
    if isinstance(x, IntResult):
        return str(x.value)
    if isinstance(x, IPv4Result):
        return str(x.value)
    if isinstance(x, MACResult):
        return string_of_mac(x.value)
    if isinstance(x, EmptyResult):
        return "Empty"
    raise ValueError("Unknown OpResult")

def string_of_tuple(tup: TupleType) -> str:
    parts = []
    for k, v in tup.items():
        parts.append(f"\"{k}\" => {string_of_op_result(v)}")
    return ", ".join(parts)

def tuple_of_list(lst: List[PyTuple[str, OpResult]]) -> TupleType:
    return {k: v for k, v in lst}

def dump_tuple(outc, tup: TupleType) -> None:
    outc.write(string_of_tuple(tup) + "\n")

def lookup_int(key: str, tup: TupleType) -> int:
    return int_of_op_result(tup[key])

def lookup_float(key: str, tup: TupleType) -> float:
    return float_of_op_result(tup[key])

# ------------------------------------------------------------------------------
# Built‐in operator definitions
# ------------------------------------------------------------------------------

def dump_tuple_op(outc=sys.stdout, show_reset=False) -> Operator:
    def nxt(tup: TupleType):
        dump_tuple(outc, tup)
    def rst(tup: TupleType):
        if show_reset:
            dump_tuple(outc, tup)
            outc.write("[reset]\n")
    return Operator(nxt, rst)

def dump_as_csv_op(outc=sys.stdout,
                   static_field: Optional[PyTuple[str,str]] = None,
                   header: bool = True) -> Operator:
    first = header
    def nxt(tup: TupleType):
        nonlocal first
        if first:
            if static_field:
                outc.write(static_field[0] + ",")
            outc.write(",".join(tup.keys()) + "\n")
            first = False
        if static_field:
            outc.write(static_field[1] + ",")
        outc.write(",".join(string_of_op_result(v) for v in tup.values()) + "\n")
    def rst(_: TupleType):
        pass
    return Operator(nxt, rst)

def dump_walts_csv_op(filename: str) -> Operator:
    outc = open(filename, "w")
    first = True
    def nxt(tup: TupleType):
        nonlocal first
        if first:
            # open file on first use
            first = False
        row = [
            tup["src_ip"], tup["dst_ip"],
            tup["src_l4_port"], tup["dst_l4_port"],
            tup["packet_count"], tup["byte_count"],
            tup["epoch_id"]
        ]
        outc.write(",".join(string_of_op_result(v) for v in row) + "\n")
    def rst(_: TupleType):
        pass
    return Operator(nxt, rst)

def get_ip_or_zero(s: str) -> OpResult:
    if s == "0":
        return IntResult(0)
    return IPv4Result(ipaddress.IPv4Address(s))

def read_walts_csv(file_names: List[str],
                   ops: List[Operator],
                   epoch_id_key: str = "eid") -> None:
    channels = [(open(fn), 0, 0) for fn in file_names]  # (in_ch, eid, tup_cnt)
    active = len(ops)
    while active > 0:
        for idx, ((in_ch, eid, cnt), op) in enumerate(zip(channels, ops)):
            line = in_ch.readline()
            if not line:
                op.reset({ epoch_id_key: IntResult(eid+1),
                           "tuples": IntResult(cnt) })
                active -= 1
                channels[idx] = (in_ch, -1, cnt)
                continue
            src_ip, dst_ip, sport, dport, pc, bc, e = line.strip().split(",")
            sport, dport, pc, bc, e = map(int, (sport,dport,pc,bc,e))
            tup: TupleType = {
                "ipv4.src": get_ip_or_zero(src_ip),
                "ipv4.dst": get_ip_or_zero(dst_ip),
                "l4.sport": IntResult(sport),
                "l4.dport": IntResult(dport),
                "packet_count": IntResult(pc),
                "byte_count": IntResult(bc),
                epoch_id_key: IntResult(e),
            }
            cnt += 1
            if e > eid:
                # reset for each missed epoch
                for _ in range(e - eid):
                    op.reset({ epoch_id_key: IntResult(eid), "tuples": IntResult(cnt) })
                    cnt = 0
                    eid += 1
            tup["tuples"] = IntResult(cnt)
            op.next(tup)
            channels[idx] = (in_ch, eid, cnt)
    print("Done.")

# ------------------------------------------------------------------------------
# Misc utils: filter, map, epoch, groupby, distinct, split, join, etc.
# ------------------------------------------------------------------------------

def meta_meter(name: str, outc=sys.stdout, static_field: Optional[str]=None) -> OpCreator:
    def make(next_op: Operator) -> Operator:
        epoch_count = 0
        tup_count = 0
        def nxt(tup: TupleType):
            nonlocal tup_count
            tup_count += 1
            next_op.next(tup)
        def rst(tup: TupleType):
            nonlocal epoch_count, tup_count
            outc.write(f"{epoch_count},{name},{tup_count},{static_field or ''}\n")
            tup_count = 0
            epoch_count += 1
            next_op.reset(tup)
        return Operator(nxt, rst)
    return make

def epoch_op(epoch_width: float, key_out: str) -> OpCreator:
    def make(next_op: Operator) -> Operator:
        boundary = 0.0
        eid = 0
        def nxt(tup: TupleType):
            nonlocal boundary, eid
            t = float_of_op_result(tup["time"])
            if boundary == 0.0:
                boundary = t + epoch_width
            elif t >= boundary:
                while t >= boundary:
                    next_op.reset({ key_out: IntResult(eid) })
                    boundary += epoch_width
                    eid += 1
            tup[key_out] = IntResult(eid)
            next_op.next(tup)
        def rst(_: TupleType):
            nonlocal boundary, eid
            next_op.reset({ key_out: IntResult(eid) })
            boundary = 0.0
            eid = 0
        return Operator(nxt, rst)
    return make

def filter_op(f: Callable[[TupleType], bool]) -> OpCreator:
    def make(next_op: Operator) -> Operator:
        def nxt(tup: TupleType):
            if f(tup):
                next_op.next(tup)
        def rst(tup: TupleType):
            next_op.reset(tup)
        return Operator(nxt, rst)
    return make

def key_geq_int(key: str, threshold: int) -> Callable[[TupleType], bool]:
    return lambda tup: int_of_op_result(tup[key]) >= threshold

def map_op(f: Callable[[TupleType], TupleType]) -> OpCreator:
    def make(next_op: Operator) -> Operator:
        def nxt(tup: TupleType):
            next_op.next(f(tup))
        def rst(tup: TupleType):
            next_op.reset(tup)
        return Operator(nxt, rst)
    return make

def groupby_op(groupby: Callable[[TupleType], TupleType],
               reduce_fn: Callable[[OpResult, TupleType], OpResult],
               out_key: str) -> OpCreator:
    def make(next_op: Operator) -> Operator:
        table: Dict[bytes, OpResult] = {}
        def nxt(tup: TupleType):
            key = tuple(sorted(groupby(tup).items()))
            prev = table.get(key, EmptyResult())
            table[key] = reduce_fn(prev, tup)
        def rst(base: TupleType):
            for key_items, val in table.items():
                grouping_key = dict(key_items)
                merged = {**base, **grouping_key}
                merged[out_key] = val
                next_op.next(merged)
            next_op.reset(base)
            table.clear()
        return Operator(nxt, rst)
    return make

def distinct_op(groupby: Callable[[TupleType], TupleType]) -> OpCreator:
    def make(next_op: Operator) -> Operator:
        seen = set()
        def nxt(tup: TupleType):
            key = tuple(sorted(groupby(tup).items()))
            seen.add(key)
        def rst(base: TupleType):
            for key_items in seen:
                merged = {**base, **dict(key_items)}
                next_op.next(merged)
            next_op.reset(base)
            seen.clear()
        return Operator(nxt, rst)
    return make

def split_op(l: Operator, r: Operator) -> Operator:
    return Operator(
        next_fn=lambda tup: (l.next(tup), r.next(tup)),
        reset_fn=lambda tup: (l.reset(tup), r.reset(tup))
    )

def rename_filtered_keys(pairs: List[PyTuple[str,str]], inp: TupleType) -> TupleType:
    out: TupleType = {}
    for old, new in pairs:
        if old in inp:
            out[new] = inp[old]
    return out

def join_op(left_extr: Callable[[TupleType], PyTuple[TupleType,TupleType]],
            right_extr: Callable[[TupleType], PyTuple[TupleType,TupleType]],
            eid_key: str = "eid") -> DblOpCreator:
    def make(next_op: Operator) -> (Operator, Operator):
        tbl1, tbl2 = {}, {}
        epoch1, epoch2 = 0, 0

        def make_side(my_tbl, other_tbl, my_epoch_ref, other_epoch_ref, extr):
            def nxt(tup: TupleType):
                nonlocal my_epoch_ref
                key_tup, vals = extr(tup)
                eid = int_of_op_result(tup[eid_key])
                while eid > my_epoch_ref:
                    if other_epoch_ref > my_epoch_ref:
                        next_op.reset({eid_key: IntResult(my_epoch_ref)})
                    my_epoch_ref += 1
                key_full = {**key_tup, eid_key: IntResult(eid)}
                key_full_items = tuple(sorted(key_full.items()))
                if key_full_items in other_tbl:
                    val = other_tbl.pop(key_full_items)
                    merged = {**key_full, **vals, **val}
                    next_op.next(merged)
                else:
                    my_tbl[key_full_items] = vals
            def rst(_: TupleType):
                nonlocal my_epoch_ref
                eid = int_of_op_result(tup[eid_key])
                while eid > my_epoch_ref:
                    if other_epoch_ref > my_epoch_ref:
                        next_op.reset({eid_key: IntResult(my_epoch_ref)})
                    my_epoch_ref += 1
            return Operator(nxt, rst)

        left_op = make_side(tbl1, tbl2, epoch1, epoch2, left_extr)
        right_op = make_side(tbl2, tbl1, epoch2, epoch1, right_extr)
        return left_op, right_op
    return make

# ------------------------------------------------------------------------------
# Example “queries” and main
# ------------------------------------------------------------------------------

def ident(next_op: Operator) -> Operator:
    return chain(map_op(lambda t: {k:v for k,v in t.items()
                                   if k not in ("eth.src","eth.dst")}),
                 next_op)

def count_pkts(next_op: Operator) -> Operator:
    return chain(epoch_op(1.0, "eid"),
                 chain(groupby_op(lambda t: {}, 
                                  lambda acc,t: IntResult(int(acc.value)+1) if isinstance(acc, IntResult) else IntResult(1),
                                  "pkts"),
                       next_op))

# ------------------------------------------------------------------------------
# More grouping / reduction utilities
# ------------------------------------------------------------------------------

def filter_groups(incl_keys: List[str], tup: TupleType) -> TupleType:
    return {k: v for k, v in tup.items() if k in incl_keys}

def single_group(_: TupleType) -> TupleType:
    return {}

def counter(prev: OpResult, tup: TupleType) -> OpResult:
    if isinstance(prev, EmptyResult):
        return IntResult(1)
    if isinstance(prev, IntResult):
        return IntResult(prev.value + 1)
    return prev

def sum_ints(search_key: str) -> Callable[[OpResult, TupleType], OpResult]:
    def reduce_fn(prev: OpResult, tup: TupleType) -> OpResult:
        if isinstance(prev, EmptyResult):
            return IntResult(0)
        if isinstance(prev, IntResult):
            val = tup.get(search_key)
            if isinstance(val, IntResult):
                return IntResult(prev.value + val.value)
            raise ValueError(f"sum_ints failed to find integer for {search_key}")
        return prev
    return reduce_fn

# ------------------------------------------------------------------------------
# Built‐in “Sonata” style queries
# ------------------------------------------------------------------------------

def pkts_per_src_dst(next_op: Operator) -> Operator:
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            groupby_op(
                lambda t: filter_groups(["ipv4.src", "ipv4.dst"], t),
                counter,
                "pkts"
            ),
            next_op
        )
    )

def distinct_srcs(next_op: Operator) -> Operator:
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            distinct_op(lambda t: filter_groups(["ipv4.src"], t)),
            chain(
                groupby_op(single_group, counter, "srcs"),
                next_op
            )
        )
    )

def tcp_new_cons(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                             and lookup_int("l4.flags",  t) == 2),
            chain(
                groupby_op(lambda t: filter_groups(["ipv4.dst"], t), counter, "cons"),
                chain(
                    filter_op(key_geq_int("cons", threshold)),
                    next_op
                )
            )
        )
    )

def ssh_brute_force(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                             and lookup_int("l4.dport",   t) == 22),
            chain(
                distinct_op(lambda t: filter_groups(
                    ["ipv4.src","ipv4.dst","ipv4.len"], t)),
                chain(
                    groupby_op(lambda t: filter_groups(
                        ["ipv4.dst","ipv4.len"], t), counter, "srcs"),
                    chain(
                        filter_op(key_geq_int("srcs", threshold)),
                        next_op
                    )
                )
            )
        )
    )

def super_spreader(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            distinct_op(lambda t: filter_groups(["ipv4.src","ipv4.dst"], t)),
            chain(
                groupby_op(lambda t: filter_groups(["ipv4.src"], t), counter, "dsts"),
                chain(
                    filter_op(key_geq_int("dsts", threshold)),
                    next_op
                )
            )
        )
    )

def port_scan(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            distinct_op(lambda t: filter_groups(["ipv4.src","l4.dport"], t)),
            chain(
                groupby_op(lambda t: filter_groups(["ipv4.src"], t), counter, "ports"),
                chain(
                    filter_op(key_geq_int("ports", threshold)),
                    next_op
                )
            )
        )
    )

def ddos(next_op: Operator) -> Operator:
    threshold = 45
    return chain(
        epoch_op(1.0, "eid"),
        chain(
            distinct_op(lambda t: filter_groups(["ipv4.src","ipv4.dst"], t)),
            chain(
                groupby_op(lambda t: filter_groups(["ipv4.dst"], t), counter, "srcs"),
                chain(
                    filter_op(key_geq_int("srcs", threshold)),
                    next_op
                )
            )
        )
    )

def syn_flood_sonata(next_op: Operator) -> List[Operator]:
    threshold = 3
    dur = 1.0

    def syns_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and lookup_int("l4.flags",  t) == 2),
                chain(
                    groupby_op(lambda t: filter_groups(["ipv4.dst"], t),
                               counter, "syns"),
                    nxt
                )
            )
        )
    def synacks_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and lookup_int("l4.flags",  t) == 18),
                chain(
                    groupby_op(lambda t: filter_groups(["ipv4.src"], t),
                               counter, "synacks"),
                    nxt
                )
            )
        )
    def acks_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and lookup_int("l4.flags",  t) == 16),
                chain(
                    groupby_op(lambda t: filter_groups(["ipv4.dst"], t),
                               counter, "acks"),
                    nxt
                )
            )
        )

    # first join: build pipeline = filter -> map -> next_op
    pipeline1 = filter_op(key_geq_int("syns+synacks-acks", threshold))(next_op)
    pipeline1 = map_op(lambda t: {
        **t,
        "syns+synacks-acks": IntResult(
            lookup_int("syns+synacks", t) - lookup_int("acks", t)
        )
    })(pipeline1)
    join1_creator = join_op(
        lambda t: (filter_groups(["host"], t),
                   filter_groups(["syns+synacks"], t)),
        lambda t: (rename_filtered_keys([("ipv4.dst", "host")], t),
                   filter_groups(["acks"], t))
    )
    join_op1, join_op2 = join1_creator(pipeline1)

    # second join: map sum -> join_op1
    pipeline2 = map_op(lambda t: {
        **t,
        "syns+synacks": IntResult(
            lookup_int("syns", t) + lookup_int("synacks", t)
        )
    })(join_op1)
    join2_creator = join_op(
        lambda t: (rename_filtered_keys([("ipv4.dst", "host")], t),
                   filter_groups(["syns"], t)),
        lambda t: (rename_filtered_keys([("ipv4.src", "host")], t),
                   filter_groups(["synacks"], t))
    )
    join_op3, join_op4 = join2_creator(pipeline2)

    return [
        syns_op(join_op3),
        synacks_op(join_op4),
        acks_op(join_op2),
    ]

def completed_flows(next_op: Operator) -> List[Operator]:
    threshold = 1
    dur = 30.0

    def syns_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and lookup_int("l4.flags",  t) == 2),
                chain(
                    groupby_op(lambda t: filter_groups(["ipv4.dst"], t),
                               counter, "syns"),
                    nxt
                )
            )
        )
    def fins_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and (lookup_int("l4.flags", t) & 1) == 1),
                chain(
                    groupby_op(lambda t: filter_groups(["ipv4.src"], t),
                               counter, "fins"),
                    nxt
                )
            )
        )

    pipeline = filter_op(key_geq_int("diff", threshold))(next_op)
    pipeline = map_op(lambda t: {
        **t,
        "diff": IntResult(
            lookup_int("syns", t) - lookup_int("fins", t)
        )
    })(pipeline)

    join_creator = join_op(
        lambda t: (rename_filtered_keys([("ipv4.dst", "host")], t),
                   filter_groups(["syns"], t)),
        lambda t: (rename_filtered_keys([("ipv4.src", "host")], t),
                   filter_groups(["fins"], t))
    )
    op1, op2 = join_creator(pipeline)

    return [
        syns_op(op1),
        fins_op(op2),
    ]

def slowloris(next_op: Operator) -> List[Operator]:
    t1, t2, t3 = 5, 500, 90
    dur = 1.0

    def n_conns_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6),
                chain(
                    distinct_op(lambda t: filter_groups(
                        ["ipv4.src","ipv4.dst","l4.sport"], t)),
                    chain(
                        groupby_op(lambda t: filter_groups(["ipv4.dst"], t),
                                   counter, "n_conns"),
                        chain(
                            filter_op(lambda t: lookup_int("n_conns", t) >= t1),
                            nxt
                        )
                    )
                )
            )
        )
    def n_bytes_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6),
                chain(
                    groupby_op(lambda t: filter_groups(["ipv4.dst"], t),
                               sum_ints("ipv4.len"), "n_bytes"),
                    chain(
                        filter_op(lambda t: lookup_int("n_bytes", t) >= t2),
                        nxt
                    )
                )
            )
        )

    pipeline = chain(chain(
        map_op(lambda t: {
            **t,
            "bytes_per_conn": IntResult(
                lookup_int("n_bytes", t) // lookup_int("n_conns", t)
            )
        }),
        filter_op(lambda t: lookup_int("bytes_per_conn", t) <= t3)
    ),next_op)

    join_creator = join_op(
        lambda t: (filter_groups(["ipv4.dst"], t),
                   filter_groups(["n_conns"], t)),
        lambda t: (filter_groups(["ipv4.dst"], t),
                   filter_groups(["n_bytes"], t))
    )
    op1, op2 = join_creator(pipeline)

    return [
        n_conns_op(op1),
        n_bytes_op(op2),
    ]

def join_test(next_op: Operator) -> List[Operator]:
    dur = 1.0

    def syns_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and lookup_int("l4.flags",  t) == 2),
                nxt
            )
        )
    def synacks_op(nxt: Operator) -> Operator:
        return chain(
            epoch_op(dur, "eid"),
            chain(
                filter_op(lambda t: lookup_int("ipv4.proto", t) == 6
                                 and lookup_int("l4.flags",  t) == 18),
                nxt
            )
        )

    pipeline = next_op  # no extra map or filter here
    join_creator = join_op(
        lambda t: (rename_filtered_keys([("ipv4.src","host")], t),
                   rename_filtered_keys([("ipv4.dst","remote")], t)),
        lambda t: (rename_filtered_keys([("ipv4.dst","host")], t),
                   filter_groups(["time"], t))
    )
    op1, op2 = join_creator(pipeline)

    return [
        syns_op(op1),
        synacks_op(op2),
    ]

def q3(next_op: Operator) -> Operator:
    return chain(
        epoch_op(100.0, "eid"),
        chain(distinct_op(lambda t: filter_groups(["ipv4.src","ipv4.dst"], t)),
              next_op)
    )

def q4(next_op: Operator) -> Operator:
    return chain(
        epoch_op(10000.0, "eid"),
        chain(groupby_op(lambda t: filter_groups(["ipv4.dst"], t),
                         counter, "pkts"),
              next_op)
    )

# ------------------------------------------------------------------------------
# Final queries list and runner
# ------------------------------------------------------------------------------

queries: List[Operator] = [
    # ident(dump_tuple_op(sys.stdout)),
    # count_pkts(dump_tuple_op(sys.stdout)),
    # pkts_per_src_dst(dump_tuple_op(sys.stdout)),
    # distinct_srcs(dump_tuple_op(sys.stdout)),
    # tcp_new_cons(dump_tuple_op(sys.stdout)),
    # ssh_brute_force(dump_tuple_op(sys.stdout)),
    # super_spreader(dump_tuple_op(sys.stdout)),
    # port_scan(dump_tuple_op(sys.stdout)),
    # ddos(dump_tuple_op(sys.stdout)),
#   *syn_flood_sonata(dump_tuple_op(sys.stdout)) \
#   *completed_flows(dump_tuple_op(sys.stdout)) \
#   *slowloris(dump_tuple_op(sys.stdout)) \
#   join_test(dump_tuple_op(sys.stdout)) \
#   
    #   q3(dump_tuple_op(sys.stdout)),
    #   q4(dump_tuple_op(sys.stdout)),
  ]

def run_queries():
    for i in range(5):
        base = {
            "time": FloatResult(float(i)),
            "eth.src": MACResult(b"\x00\x11\x22\x33\x44\x55"),
            "eth.dst": MACResult(b"\xAA\xBB\xCC\xDD\xEE\xFF"),
            "eth.ethertype": IntResult(0x0800),
            "ipv4.hlen": IntResult(20),
            "ipv4.proto": IntResult(6),
            "ipv4.len": IntResult(60),
            "ipv4.src": IPv4Result(ipaddress.IPv4Address("127.0.0.1")),
            "ipv4.dst": IPv4Result(ipaddress.IPv4Address("127.0.0.1")),
            "l4.sport": IntResult(440),
            "l4.dport": IntResult(50000),
            "l4.flags": IntResult(10),
        }
        for q in queries:
            q.next(base)
    print("Done")

if __name__ == "__main__":
    run_queries()



