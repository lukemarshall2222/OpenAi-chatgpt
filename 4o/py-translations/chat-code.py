from typing import Callable, Dict, Optional, List, Tuple as PyTuple
from ipaddress import IPv4Address
import sys

# Define op_result
class OpResult:
    pass

class FloatOp(OpResult):
    def __init__(self, value: float):
        self.value = value

class IntOp(OpResult):
    def __init__(self, value: int):
        self.value = value

class IPv4Op(OpResult):
    def __init__(self, value: IPv4Address):
        self.value = value

class MACOp(OpResult):
    def __init__(self, value: bytes):
        self.value = value

class EmptyOp(OpResult):
    def __init__(self):
        pass

# Tuple is simply a dict
TupleType = Dict[str, OpResult]

# Operator class
class Operator:
    def __init__(self, next_func: Callable[[TupleType], None], reset_func: Callable[[TupleType], None]):
        self.next_func = next_func
        self.reset_func = reset_func

    def next(self, tup: TupleType):
        self.next_func(tup)

    def reset(self, tup: TupleType):
        self.reset_func(tup)

# Helper: chaining operators
def chain(op_creator: Callable[[Operator], Operator], next_op: Operator) -> Operator:
    return op_creator(next_op)

# Double chaining
def double_chain(dbl_op_creator: Callable[[Operator], PyTuple[Operator, Operator]], op: Operator) -> PyTuple[Operator, Operator]:
    return dbl_op_creator(op)

# String utils
def string_of_mac(mac_bytes: bytes) -> str:
    return ":".join(f"{b:02x}" for b in mac_bytes)

def tcp_flags_to_strings(flags: int) -> str:
    tcp_flags = {
        "FIN": 1 << 0,
        "SYN": 1 << 1,
        "RST": 1 << 2,
        "PSH": 1 << 3,
        "ACK": 1 << 4,
        "URG": 1 << 5,
        "ECE": 1 << 6,
        "CWR": 1 << 7,
    }
    return "|".join(name for name, bit in tcp_flags.items() if flags & bit)

def int_of_op_result(input: OpResult) -> int:
    if isinstance(input, IntOp):
        return input.value
    else:
        raise TypeError("Trying to extract int from non-int result")

def float_of_op_result(input: OpResult) -> float:
    if isinstance(input, FloatOp):
        return input.value
    else:
        raise TypeError("Trying to extract float from non-float result")

def string_of_op_result(input: OpResult) -> str:
    if isinstance(input, FloatOp):
        return f"{input.value:.6f}"
    elif isinstance(input, IntOp):
        return str(input.value)
    elif isinstance(input, IPv4Op):
        return str(input.value)
    elif isinstance(input, MACOp):
        return string_of_mac(input.value)
    elif isinstance(input, EmptyOp):
        return "Empty"
    else:
        return "Unknown"

def string_of_tuple(tup: TupleType) -> str:
    return ", ".join(f'"{k}" => {string_of_op_result(v)}' for k, v in tup.items())

def tuple_of_list(lst: List[PyTuple[str, OpResult]]) -> TupleType:
    return dict(lst)

def dump_tuple(out, tup: TupleType):
    print(string_of_tuple(tup), file=out)


import time as pytime
import io
import itertools
from collections import defaultdict
import copy

init_table_size = 10000  # For compatibility with OCaml version

# More operator helpers

def lookup_int(key: str, tup: TupleType) -> int:
    return int_of_op_result(tup[key])

def lookup_float(key: str, tup: TupleType) -> float:
    return float_of_op_result(tup[key])

def get_ip_or_zero(s: str) -> OpResult:
    if s == "0":
        return IntOp(0)
    else:
        return IPv4Op(IPv4Address(s))

# Built-in Operators

def dump_tuple_op(show_reset: bool = False, out=sys.stdout) -> Operator:
    def next_func(tup: TupleType):
        dump_tuple(out, tup)

    def reset_func(tup: TupleType):
        if show_reset:
            dump_tuple(out, tup)
            print("[reset]", file=out)

    return Operator(next_func, reset_func)

def dump_as_csv_op(static_field: Optional[PyTuple[str, str]] = None, header=True, out=sys.stdout) -> Operator:
    first = [header]  # mutable closure

    def next_func(tup: TupleType):
        if first[0]:
            if static_field:
                print(static_field[0], end=",", file=out)
            print(",".join(tup.keys()), file=out)
            first[0] = False
        if static_field:
            print(static_field[1], end=",", file=out)
        print(",".join(string_of_op_result(v) for v in tup.values()), file=out)

    return Operator(next_func, lambda _: None)

def epoch(epoch_width: float, key_out: str) -> Callable[[Operator], Operator]:
    def wrap(next_op: Operator) -> Operator:
        epoch_boundary = [0.0]
        eid = [0]

        def next_func(tup: TupleType):
            time_val = float_of_op_result(tup.get("time", FloatOp(0.0)))
            if epoch_boundary[0] == 0.0:
                epoch_boundary[0] = time_val + epoch_width
            elif time_val >= epoch_boundary[0]:
                while time_val >= epoch_boundary[0]:
                    next_op.reset({key_out: IntOp(eid[0])})
                    epoch_boundary[0] += epoch_width
                    eid[0] += 1
            tup2 = copy.deepcopy(tup)
            tup2[key_out] = IntOp(eid[0])
            next_op.next(tup2)

        def reset_func(tup: TupleType):
            next_op.reset({key_out: IntOp(eid[0])})
            epoch_boundary[0] = 0.0
            eid[0] = 0

        return Operator(next_func, reset_func)
    return wrap

def filter_op(f: Callable[[TupleType], bool]) -> Callable[[Operator], Operator]:
    def wrap(next_op: Operator) -> Operator:
        return Operator(
            lambda tup: next_op.next(tup) if f(tup) else None,
            lambda tup: next_op.reset(tup)
        )
    return wrap

def map_op(f: Callable[[TupleType], TupleType]) -> Callable[[Operator], Operator]:
    def wrap(next_op: Operator) -> Operator:
        return Operator(
            lambda tup: next_op.next(f(tup)),
            lambda tup: next_op.reset(tup)
        )
    return wrap

# Filter helpers
def key_geq_int(key: str, threshold: int) -> Callable[[TupleType], bool]:
    def f(tup: TupleType):
        return lookup_int(key, tup) >= threshold
    return f

def get_mapped_int(key: str, tup: TupleType) -> int:
    return lookup_int(key, tup)

def get_mapped_float(key: str, tup: TupleType) -> float:
    return lookup_float(key, tup)

# GroupBy helpers
def filter_groups(keys: List[str]) -> Callable[[TupleType], TupleType]:
    def f(tup: TupleType):
        return {k: v for k, v in tup.items() if k in keys}
    return f

def single_group(_: TupleType) -> TupleType:
    return {}

def counter(val: OpResult, _: TupleType) -> OpResult:
    if isinstance(val, EmptyOp):
        return IntOp(1)
    elif isinstance(val, IntOp):
        return IntOp(val.value + 1)
    else:
        return val

def sum_ints(search_key: str) -> Callable[[OpResult, TupleType], OpResult]:
    def f(init_val: OpResult, tup: TupleType):
        if isinstance(init_val, EmptyOp):
            return IntOp(0)
        elif isinstance(init_val, IntOp):
            n = lookup_int(search_key, tup)
            return IntOp(init_val.value + n)
        else:
            return init_val
    return f

def groupby(grouping_func: Callable[[TupleType], TupleType],
            reduce_func: Callable[[OpResult, TupleType], OpResult],
            out_key: str) -> Callable[[Operator], Operator]:
    def wrap(next_op: Operator) -> Operator:
        h_tbl = {}

        def next_func(tup: TupleType):
            grouping_key = frozenset(grouping_func(tup).items())
            old_val = h_tbl.get(grouping_key, EmptyOp())
            h_tbl[grouping_key] = reduce_func(old_val, tup)

        def reset_func(tup: TupleType):
            for grouping_key, val in h_tbl.items():
                out_tup = dict(grouping_key)
                out_tup.update(tup)
                out_tup[out_key] = val
                next_op.next(out_tup)
            next_op.reset(tup)
            h_tbl.clear()

        return Operator(next_func, reset_func)
    return wrap

def distinct(groupby_func: Callable[[TupleType], TupleType]) -> Callable[[Operator], Operator]:
    def wrap(next_op: Operator) -> Operator:
        h_tbl = {}

        def next_func(tup: TupleType):
            key = frozenset(groupby_func(tup).items())
            h_tbl[key] = True

        def reset_func(tup: TupleType):
            for key in h_tbl.keys():
                out_tup = dict(key)
                out_tup.update(tup)
                next_op.next(out_tup)
            next_op.reset(tup)
            h_tbl.clear()

        return Operator(next_func, reset_func)
    return wrap

def split(left: Operator, right: Operator) -> Operator:
    def next_func(tup: TupleType):
        left.next(tup)
        right.next(tup)

    def reset_func(tup: TupleType):
        left.reset(tup)
        right.reset(tup)

    return Operator(next_func, reset_func)

# Joins

def join(left_extractor, right_extractor, eid_key="eid"):
    def dbl_wrap(next_op: Operator):
        h_tbl1 = {}
        h_tbl2 = {}
        left_epoch = [0]
        right_epoch = [0]

        def handle(curr_tbl, other_tbl, curr_epoch, other_epoch, extractor):
            def next_func(tup: TupleType):
                key, val = extractor(tup)
                curr_eid = lookup_int(eid_key, tup)

                while curr_eid > curr_epoch[0]:
                    if other_epoch[0] > curr_epoch[0]:
                        next_op.reset({eid_key: IntOp(curr_epoch[0])})
                    curr_epoch[0] += 1

                new_key = frozenset(key.items())
                if new_key in other_tbl:
                    other_val = other_tbl.pop(new_key)
                    merged = {**key, **val, **other_val}
                    merged[eid_key] = IntOp(curr_eid)
                    next_op.next(merged)
                else:
                    curr_tbl[new_key] = val

            def reset_func(tup: TupleType):
                curr_eid = lookup_int(eid_key, tup)
                while curr_eid > curr_epoch[0]:
                    if other_epoch[0] > curr_epoch[0]:
                        next_op.reset({eid_key: IntOp(curr_epoch[0])})
                    curr_epoch[0] += 1

            return Operator(next_func, reset_func)

        return (handle(h_tbl1, h_tbl2, left_epoch, right_epoch, left_extractor),
                handle(h_tbl2, h_tbl1, right_epoch, left_epoch, right_extractor))
    return dbl_wrap

def rename_filtered_keys(rename_pairs: List[PyTuple[str, str]]):
    def inner(tup: TupleType) -> TupleType:
        out = {}
        for old_key, new_key in rename_pairs:
            if old_key in tup:
                out[new_key] = tup[old_key]
        return out
    return inner


# === Queries ===

# Ident operator
def ident(next_op: Operator) -> Operator:
    return chain(
        map_op(lambda tup: {k: v for k, v in tup.items() if k not in ["eth.src", "eth.dst"]}),
        next_op
    )

# Count packets per epoch
def count_pkts(next_op: Operator) -> Operator:
    return chain(
        epoch(1.0, "eid"),
        chain(
            groupby(single_group, counter, "pkts"),
            next_op
        )
    )

# Packets per (src, dst)
def pkts_per_src_dst(next_op: Operator) -> Operator:
    return chain(
        epoch(1.0, "eid"),
        chain(
            groupby(filter_groups(["ipv4.src", "ipv4.dst"]), counter, "pkts"),
            next_op
        )
    )

# Distinct sources
def distinct_srcs(next_op: Operator) -> Operator:
    return chain(
        epoch(1.0, "eid"),
        chain(
            distinct(filter_groups(["ipv4.src"])),
            chain(
                groupby(single_group, counter, "srcs"),
                next_op
            )
        )
    )

# TCP New Connections (Sonata 1)
def tcp_new_cons(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch(1.0, "eid"),
        chain(
            filter_op(lambda tup: get_mapped_int("ipv4.proto", tup) == 6 and get_mapped_int("l4.flags", tup) == 2),
            chain(
                groupby(filter_groups(["ipv4.dst"]), counter, "cons"),
                chain(
                    filter_op(key_geq_int("cons", threshold)),
                    next_op
                )
            )
        )
    )

# Super Spreader (Sonata 3)
def super_spreader(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch(1.0, "eid"),
        chain(
            distinct(filter_groups(["ipv4.src", "ipv4.dst"])),
            chain(
                groupby(filter_groups(["ipv4.src"]), counter, "dsts"),
                chain(
                    filter_op(key_geq_int("dsts", threshold)),
                    next_op
                )
            )
        )
    )

# Port Scan (Sonata 4)
def port_scan(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch(1.0, "eid"),
        chain(
            distinct(filter_groups(["ipv4.src", "l4.dport"])),
            chain(
                groupby(filter_groups(["ipv4.src"]), counter, "ports"),
                chain(
                    filter_op(key_geq_int("ports", threshold)),
                    next_op
                )
            )
        )
    )

# DDoS Attack (Sonata 5)
def ddos(next_op: Operator) -> Operator:
    threshold = 45
    return chain(
        epoch(1.0, "eid"),
        chain(
            distinct(filter_groups(["ipv4.src", "ipv4.dst"])),
            chain(
                groupby(filter_groups(["ipv4.dst"]), counter, "srcs"),
                chain(
                    filter_op(key_geq_int("srcs", threshold)),
                    next_op
                )
            )
        )
    )

def ssh_brute_force(next_op: Operator) -> Operator:
    threshold = 40
    return chain(
        epoch(1.0, "eid"),
        chain(
            filter_op(lambda tup:
                      get_mapped_int("ipv4.proto", tup) == 6 and get_mapped_int("l4.dport", tup) == 22),
            chain(
                distinct(filter_groups(["ipv4.src", "ipv4.dst", "ipv4.len"])),
                chain(
                    groupby(filter_groups(["ipv4.dst", "ipv4.len"]), counter, "srcs"),
                    chain(
                        filter_op(key_geq_int("srcs", threshold)),
                        next_op
                    )
                )
            )
        )
    )

def completed_flows(next_op: Operator) -> List[Operator]:
    threshold = 1
    epoch_dur = 30.0

    def syns(next_op):
        return chain(
            epoch(epoch_dur, "eid"),
            chain(
                filter_op(lambda tup:
                          get_mapped_int("ipv4.proto", tup) == 6 and get_mapped_int("l4.flags", tup) == 2),
                chain(
                    groupby(filter_groups(["ipv4.dst"]), counter, "syns"),
                    next_op
                )
            )
        )

    def fins(next_op):
        return chain(
            epoch(epoch_dur, "eid"),
            chain(
                filter_op(lambda tup:
                          get_mapped_int("ipv4.proto", tup) == 6 and (get_mapped_int("l4.flags", tup) & 1) == 1),
                chain(
                    groupby(filter_groups(["ipv4.src"]), counter, "fins"),
                    next_op
                )
            )
        )

    join_op1, join_op2 = double_chain(
        join(
            lambda tup: (rename_filtered_keys([("ipv4.dst", "host")])(tup), filter_groups(["syns"])(tup)),
            lambda tup: (rename_filtered_keys([("ipv4.src", "host")])(tup), filter_groups(["fins"])(tup)),
        ),
        chain(
            map_op(lambda tup: {**tup, "diff": IntOp(get_mapped_int("syns", tup) - get_mapped_int("fins", tup))}),
            chain(
                filter_op(key_geq_int("diff", threshold)),
                next_op
            )
        )
    )

    return [syns(join_op1), fins(join_op2)]

def slowloris(next_op: Operator) -> List[Operator]:
    t1, t2, t3 = 5, 500, 90
    epoch_dur = 1.0

    def n_conns(next_op):
        return chain(
            epoch(epoch_dur, "eid"),
            chain(
                filter_op(lambda tup: get_mapped_int("ipv4.proto", tup) == 6),
                chain(
                    distinct(filter_groups(["ipv4.src", "ipv4.dst", "l4.sport"])),
                    chain(
                        groupby(filter_groups(["ipv4.dst"]), counter, "n_conns"),
                        chain(
                            filter_op(lambda tup: get_mapped_int("n_conns", tup) >= t1),
                            next_op
                        )
                    )
                )
            )
        )

    def n_bytes(next_op):
        return chain(
            epoch(epoch_dur, "eid"),
            chain(
                filter_op(lambda tup: get_mapped_int("ipv4.proto", tup) == 6),
                chain(
                    groupby(filter_groups(["ipv4.dst"]), sum_ints("ipv4.len"), "n_bytes"),
                    chain(
                        filter_op(lambda tup: get_mapped_int("n_bytes", tup) >= t2),
                        next_op
                    )
                )
            )
        )

    join_op1, join_op2 = double_chain(
        join(
            lambda tup: (filter_groups(["ipv4.dst"])(tup), filter_groups(["n_conns"])(tup)),
            lambda tup: (filter_groups(["ipv4.dst"])(tup), filter_groups(["n_bytes"])(tup)),
        ),
        chain(
            map_op(lambda tup: {**tup, "bytes_per_conn": IntOp(get_mapped_int("n_bytes", tup) // get_mapped_int("n_conns", tup))}),
            chain(
                filter_op(lambda tup: get_mapped_int("bytes_per_conn", tup) <= t3),
                next_op
            )
        )
    )

    return [n_conns(join_op1), n_bytes(join_op2)]

def q3(next_op: Operator) -> Operator:
    return chain(
        epoch(100.0, "eid"),
        chain(
            distinct(filter_groups(["ipv4.src", "ipv4.dst"])),
            next_op
        )
    )

def q4(next_op: Operator) -> Operator:
    return chain(
        epoch(10000.0, "eid"),
        chain(
            groupby(filter_groups(["ipv4.dst"]), counter, "pkts"),
            next_op
        )
    )


queries: List[Operator] = [q4(dump_tuple_op(out=sys.stdout))]

def run_queries():
    dummy_tuples = []
    for i in range(5):
        tup = {
            "time": FloatOp(0.0 + i),
            "eth.src": MACOp(bytes.fromhex("001122334455")),
            "eth.dst": MACOp(bytes.fromhex("AABBCCDDEEFF")),
            "eth.ethertype": IntOp(0x0800),
            "ipv4.hlen": IntOp(20),
            "ipv4.proto": IntOp(6),
            "ipv4.len": IntOp(60),
            "ipv4.src": IPv4Op(IPv4Address("127.0.0.1")),
            "ipv4.dst": IPv4Op(IPv4Address("127.0.0.1")),
            "l4.sport": IntOp(440),
            "l4.dport": IntOp(50000),
            "l4.flags": IntOp(10),
        }
        dummy_tuples.append(tup)

    for tup in dummy_tuples:
        for query in queries:
            query.next(tup)

    print("Done.")

# Entry point
if __name__ == "__main__":
    run_queries()