#include <iostream>
#include <map>
#include <string>
#include <variant>
#include <vector>
#include <sstream>
#include <iomanip>
#include <memory>
#include <functional>
#include <stdexcept>

// ---- Core Types ----

using op_result = std::variant<int, float, std::string, std::vector<uint8_t>, std::monostate>;
using tuple = std::map<std::string, op_result>;

#define EMPTY std::monostate{}

// Operator definition
struct operator_t {
    std::function<void(const tuple&)> next;
    std::function<void(const tuple&)> reset;
};

using op_creator = std::function<operator_t(operator_t)>;
using dbl_op_creator = std::function<std::pair<operator_t, operator_t>(operator_t)>;

// ---- Utilities ----

std::string string_of_mac(const std::vector<uint8_t>& mac) {
    std::ostringstream oss;
    for (size_t i = 0; i < mac.size(); ++i) {
        if (i > 0) oss << ":";
        oss << std::hex << std::setw(2) << std::setfill('0') << (int)mac[i];
    }
    return oss.str();
}

std::string tcp_flags_to_strings(int flags) {
    static const std::map<std::string, int> tcp_flags_map = {
        {"FIN", 1 << 0}, {"SYN", 1 << 1}, {"RST", 1 << 2},
        {"PSH", 1 << 3}, {"ACK", 1 << 4}, {"URG", 1 << 5},
        {"ECE", 1 << 6}, {"CWR", 1 << 7}
    };
    std::string result;
    for (const auto& [key, value] : tcp_flags_map) {
        if ((flags & value) == value) {
            if (!result.empty()) result += "|";
            result += key;
        }
    }
    return result;
}

int int_of_op_result(const op_result& res) {
    if (std::holds_alternative<int>(res)) return std::get<int>(res);
    throw std::runtime_error("Expected int in op_result");
}

float float_of_op_result(const op_result& res) {
    if (std::holds_alternative<float>(res)) return std::get<float>(res);
    throw std::runtime_error("Expected float in op_result");
}

std::string string_of_op_result(const op_result& res) {
    if (std::holds_alternative<int>(res)) return std::to_string(std::get<int>(res));
    if (std::holds_alternative<float>(res)) return std::to_string(std::get<float>(res));
    if (std::holds_alternative<std::string>(res)) return std::get<std::string>(res);
    if (std::holds_alternative<std::vector<uint8_t>>(res)) return string_of_mac(std::get<std::vector<uint8_t>>(res));
    return "Empty";
}

std::string string_of_tuple(const tuple& tup) {
    std::ostringstream oss;
    for (const auto& [k, v] : tup) {
        oss << "\"" << k << "\" => " << string_of_op_result(v) << ", ";
    }
    return oss.str();
}

void dump_tuple(std::ostream& out, const tuple& tup) {
    out << string_of_tuple(tup) << "\n";
}

tuple tuple_of_list(const std::vector<std::pair<std::string, op_result>>& items) {
    tuple t;
    for (auto& [k, v] : items) t[k] = v;
    return t;
}

// ---- Operator Building Blocks ----

operator_t make_dump_operator(std::ostream& out, bool show_reset = false) {
    return {
        .next = [&out](const tuple& tup) { dump_tuple(out, tup); },
        .reset = [show_reset, &out](const tuple& tup) {
            if (show_reset) {
                dump_tuple(out, tup);
                out << "[reset]\n";
            }
        }
    };
}

operator_t filter(std::function<bool(const tuple&)> pred, operator_t next_op) {
    return {
        .next = [pred, next_op](const tuple& tup) {
            if (pred(tup)) next_op.next(tup);
        },
        .reset = [next_op](const tuple& tup) { next_op.reset(tup); }
    };
}

operator_t map(std::function<tuple(const tuple&)> f, operator_t next_op) {
    return {
        .next = [f, next_op](const tuple& tup) { next_op.next(f(tup)); },
        .reset = [next_op](const tuple& tup) { next_op.reset(tup); }
    };
}

operator_t epoch(double width, const std::string& key_out, operator_t next_op) {
    auto epoch_boundary = std::make_shared<double>(0.0);
    auto eid = std::make_shared<int>(0);

    return {
        .next = [=](const tuple& tup) mutable {
            double time = float_of_op_result(tup.at("time"));
            if (*epoch_boundary == 0.0) {
                *epoch_boundary = time + width;
            } else if (time >= *epoch_boundary) {
                while (time >= *epoch_boundary) {
                    tuple reset_tup = {{key_out, *eid}};
                    next_op.reset(reset_tup);
                    *epoch_boundary += width;
                    (*eid)++;
                }
            }
            tuple out = tup;
            out[key_out] = *eid;
            next_op.next(out);
        },
        .reset = [=](const tuple&) mutable {
            tuple reset_tup = {{key_out, *eid}};
            next_op.reset(reset_tup);
            *epoch_boundary = 0.0;
            *eid = 0;
        }
    };
}

operator_t groupby(std::function<tuple(const tuple&)> group_func,
                   std::function<op_result(op_result, const tuple&)> reducer,
                   const std::string& out_key,
                   operator_t next_op) {
    auto table = std::make_shared<std::map<tuple, op_result>>();

    return {
        .next = [=](const tuple& tup) mutable {
            tuple key = group_func(tup);
            auto& val = (*table)[key];
            val = reducer(val, tup);
        },
        .reset = [=](const tuple& tup) mutable {
            for (auto& [k, v] : *table) {
                tuple merged = tup;
                merged.insert(k.begin(), k.end());
                merged[out_key] = v;
                next_op.next(merged);
            }
            table->clear();
            next_op.reset(tup);
        }
    };
}

op_result counter(op_result prev, const tuple&) {
    if (std::holds_alternative<std::monostate>(prev)) return 1;
    return int_of_op_result(prev) + 1;
}

tuple single_group(const tuple&) {
    return {};
}

tuple filter_groups(const std::vector<std::string>& keys, const tuple& tup) {
    tuple out;
    for (auto& k : keys) {
        if (tup.count(k)) out[k] = tup.at(k);
    }
    return out;
}

operator_t distinct(std::function<tuple(const tuple&)> group_func, operator_t next_op) {
    auto seen = std::make_shared<std::map<tuple, bool>>();

    return {
        .next = [=](const tuple& tup) mutable {
            (*seen)[group_func(tup)] = true;
        },
        .reset = [=](const tuple& tup) mutable {
            for (const auto& [key, _] : *seen) {
                tuple merged = tup;
                merged.insert(key.begin(), key.end());
                next_op.next(merged);
            }
            seen->clear();
            next_op.reset(tup);
        }
    };
}

// ---- Queries ----

operator_t ident(operator_t next_op) {
    return map([](const tuple& tup) {
        tuple out;
        for (auto& [k, v] : tup) {
            if (k != "eth.src" && k != "eth.dst") out[k] = v;
        }
        return out;
    }, next_op);
}

operator_t count_pkts(operator_t next_op) {
    return epoch(1.0, "eid",
           groupby(single_group, counter, "pkts",
           next_op));
}

operator_t tcp_new_cons(operator_t next_op) {
    int threshold = 40;
    return epoch(1.0, "eid",
           filter([](const tuple& tup) {
               return int_of_op_result(tup.at("ipv4.proto")) == 6 &&
                      int_of_op_result(tup.at("l4.flags")) == 2;
           },
           groupby([](const tuple& tup) {
               return filter_groups({"ipv4.dst"}, tup);
           },
           counter, "cons",
           filter([threshold](const tuple& tup) {
               return int_of_op_result(tup.at("cons")) >= threshold;
           }, next_op))));
}

operator_t ssh_brute_force(operator_t next_op) {
    int threshold = 40;
    return epoch(1.0, "eid",
           filter([](const tuple& tup) {
               return int_of_op_result(tup.at("ipv4.proto")) == 6 &&
                      int_of_op_result(tup.at("l4.dport")) == 22;
           },
           distinct([](const tuple& tup) {
               return filter_groups({"ipv4.src", "ipv4.dst", "ipv4.len"}, tup);
           },
           groupby([](const tuple& tup) {
               return filter_groups({"ipv4.dst", "ipv4.len"}, tup);
           },
           counter, "srcs",
           filter([threshold](const tuple& tup) {
               return int_of_op_result(tup.at("srcs")) >= threshold;
           }, next_op)))));
}

operator_t super_spreader(operator_t next_op) {
    int threshold = 40;
    return epoch(1.0, "eid",
           distinct([](const tuple& tup) {
               return filter_groups({"ipv4.src", "ipv4.dst"}, tup);
           },
           groupby([](const tuple& tup) {
               return filter_groups({"ipv4.src"}, tup);
           },
           counter, "dsts",
           filter([threshold](const tuple& tup) {
               return int_of_op_result(tup.at("dsts")) >= threshold;
           }, next_op)))));
}

operator_t port_scan(operator_t next_op) {
    int threshold = 40;
    return epoch(1.0, "eid",
           distinct([](const tuple& tup) {
               return filter_groups({"ipv4.src", "l4.dport"}, tup);
           },
           groupby([](const tuple& tup) {
               return filter_groups({"ipv4.src"}, tup);
           },
           counter, "ports",
           filter([threshold](const tuple& tup) {
               return int_of_op_result(tup.at("ports")) >= threshold;
           }, next_op)))));
}

operator_t ddos(operator_t next_op) {
    int threshold = 45;
    return epoch(1.0, "eid",
           distinct([](const tuple& tup) {
               return filter_groups({"ipv4.src", "ipv4.dst"}, tup);
           },
           groupby([](const tuple& tup) {
               return filter_groups({"ipv4.dst"}, tup);
           },
           counter, "srcs",
           filter([threshold](const tuple& tup) {
               return int_of_op_result(tup.at("srcs")) >= threshold;
           }, next_op)))));
}

// Simple addition
op_result add_op_result(const op_result& a, const op_result& b) {
    return int_of_op_result(a) + int_of_op_result(b);
}

std::pair<operator_t, operator_t> syn_flood_sonata(operator_t next_op) {
    double epoch_dur = 1.0;
    int threshold = 3;

    // Stream 1: SYNs
    auto syns = epoch(epoch_dur, "eid",
               filter([](const tuple& tup) {
                   return int_of_op_result(tup.at("ipv4.proto")) == 6 &&
                          int_of_op_result(tup.at("l4.flags")) == 2;
               },
               groupby([](const tuple& tup) {
                   return filter_groups({"ipv4.dst"}, tup);
               },
               counter, "syns", next_op)));

    // Stream 2: SYNACKs
    auto synacks = epoch(epoch_dur, "eid",
               filter([](const tuple& tup) {
                   return int_of_op_result(tup.at("ipv4.proto")) == 6 &&
                          int_of_op_result(tup.at("l4.flags")) == 18;
               },
               groupby([](const tuple& tup) {
                   return filter_groups({"ipv4.src"}, tup);
               },
               counter, "synacks", next_op)));

    // Join: syns + synacks
    auto [left, right] = join(
        [](const tuple& tup) {
            return std::make_pair(
                filter_groups({"ipv4.dst"}, tup),
                filter_groups({"syns"}, tup)
            );
        },
        [](const tuple& tup) {
            return std::make_pair(
                filter_groups({"ipv4.src"}, tup),
                filter_groups({"synacks"}, tup)
            );
        },
        map([](const tuple& tup) {
            tuple new_tup = tup;
            new_tup["syns+synacks"] = int_of_op_result(tup.at("syns")) + int_of_op_result(tup.at("synacks"));
            return new_tup;
        }, next_op)
    );

    return {left, right};
}

std::pair<operator_t, operator_t> completed_flows(operator_t next_op) {
    double epoch_dur = 30.0;
    int threshold = 1;

    // SYNs stream
    auto syns = epoch(epoch_dur, "eid",
        filter([](const tuple& tup) {
            return int_of_op_result(tup.at("ipv4.proto")) == 6 &&
                   int_of_op_result(tup.at("l4.flags")) == 2;
        },
        groupby([](const tuple& tup) {
            return filter_groups({"ipv4.dst"}, tup);
        }, counter, "syns", next_op)
    ));

    // FINs stream
    auto fins = epoch(epoch_dur, "eid",
        filter([](const tuple& tup) {
            return int_of_op_result(tup.at("ipv4.proto")) == 6 &&
                   (int_of_op_result(tup.at("l4.flags")) & 1) == 1; // FIN flag set
        },
        groupby([](const tuple& tup) {
            return filter_groups({"ipv4.src"}, tup);
        }, counter, "fins", next_op)
    ));

    // Join SYNs and FINs
    auto [left, right] = join(
        [](const tuple& tup) {
            return std::make_pair(
                filter_groups({"ipv4.dst"}, tup),
                filter_groups({"syns"}, tup)
            );
        },
        [](const tuple& tup) {
            return std::make_pair(
                filter_groups({"ipv4.src"}, tup),
                filter_groups({"fins"}, tup)
            );
        },
        map([](const tuple& tup) {
            tuple t = tup;
            t["diff"] = int_of_op_result(tup.at("syns")) - int_of_op_result(tup.at("fins"));
            return t;
        },
        filter([threshold](const tuple& tup) {
            return int_of_op_result(tup.at("diff")) >= threshold;
        }, next_op))
    );

    return {left, right};
}

std::pair<operator_t, operator_t> slowloris(operator_t next_op) {
    double epoch_dur = 1.0;
    int t1 = 5;    // min number of connections
    int t2 = 500;  // min total bytes
    int t3 = 90;   // max bytes per conn threshold

    // Stream 1: Number of connections per dst
    auto n_conns = epoch(epoch_dur, "eid",
        filter([](const tuple& tup) {
            return int_of_op_result(tup.at("ipv4.proto")) == 6;
        },
        distinct([](const tuple& tup) {
            return filter_groups({"ipv4.src", "ipv4.dst", "l4.sport"}, tup);
        },
        groupby([](const tuple& tup) {
            return filter_groups({"ipv4.dst"}, tup);
        }, counter, "n_conns",
        filter([t1](const tuple& tup) {
            return int_of_op_result(tup.at("n_conns")) >= t1;
        }, next_op))))
    );

    // Stream 2: Total bytes per dst
    auto n_bytes = epoch(epoch_dur, "eid",
        filter([](const tuple& tup) {
            return int_of_op_result(tup.at("ipv4.proto")) == 6;
        },
        groupby([](const tuple& tup) {
            return filter_groups({"ipv4.dst"}, tup);
        },
        [](op_result prev, const tuple& tup) -> op_result {
            int prev_sum = std::holds_alternative<std::monostate>(prev) ? 0 : int_of_op_result(prev);
            if (tup.count("ipv4.len")) {
                return prev_sum + int_of_op_result(tup.at("ipv4.len"));
            }
            return prev_sum;
        }, "n_bytes",
        filter([t2](const tuple& tup) {
            return int_of_op_result(tup.at("n_bytes")) >= t2;
        }, next_op))))
    );

    // Join connections and bytes
    auto [left, right] = join(
        [](const tuple& tup) {
            return std::make_pair(
                filter_groups({"ipv4.dst"}, tup),
                filter_groups({"n_conns"}, tup)
            );
        },
        [](const tuple& tup) {
            return std::make_pair(
                filter_groups({"ipv4.dst"}, tup),
                filter_groups({"n_bytes"}, tup)
            );
        },
        map([](const tuple& tup) {
            tuple t = tup;
            int bytes = int_of_op_result(tup.at("n_bytes"));
            int conns = int_of_op_result(tup.at("n_conns"));
            t["bytes_per_conn"] = bytes / conns;
            return t;
        },
        filter([t3](const tuple& tup) {
            return int_of_op_result(tup.at("bytes_per_conn")) <= t3;
        }, next_op))
    );

    return {left, right};
}


operator_t q3(operator_t next_op) {
    return epoch(100.0, "eid",
           distinct([](const tuple& tup) {
               return filter_groups({"ipv4.src", "ipv4.dst"}, tup);
           }, next_op));
}

operator_t q4(operator_t next_op) {
    return epoch(10000.0, "eid",
           groupby([](const tuple& tup) {
               return filter_groups({"ipv4.dst"}, tup);
           },
           counter, "pkts", next_op));
}

// ---- Main Program ----

int main() {
    auto printer = make_dump_operator(std::cout);
    auto query = ident(printer);

    // Simulate 20 tuples
    for (int i = 0; i < 20; ++i) {
        tuple t = {
            {"time", (float)i},
            {"eth.src", std::vector<uint8_t>{0x00,0x11,0x22,0x33,0x44,0x55}},
            {"eth.dst", std::vector<uint8_t>{0xAA,0xBB,0xCC,0xDD,0xEE,0xFF}},
            {"eth.ethertype", 0x0800},
            {"ipv4.hlen", 20},
            {"ipv4.proto", 6},
            {"ipv4.len", 60},
            {"ipv4.src", std::string("127.0.0.1")},
            {"ipv4.dst", std::string("127.0.0.1")},
            {"l4.sport", 440},
            {"l4.dport", 50000},
            {"l4.flags", 10}
        };
        query.next(t);
    }

    std::cout << "Done\n";
}
