#ifndef WALT_UTILS_HPP
#define WALT_UTILS_HPP

#include <string>
#include <variant>
#include <map>
#include <vector>
#include <functional>
#include <iostream>
#include <sstream>
#include <iomanip>
#include <array>
#include <fstream>
#include <set>
#include <boost/asio.hpp>
#include <boost/algorithm/string.hpp>

namespace walt {

//--------------------------------------------------------------------------------
// Type definitions
//--------------------------------------------------------------------------------
using OpResult = std::variant<
    double,                                 // Float
    int,                                    // Int
    boost::asio::ip::address_v4,            // IPv4
    std::array<uint8_t,6>,                  // MAC
    std::monostate                          // Empty
>;
using Tuple = std::map<std::string, OpResult>;

struct Operator {
    std::function<void(const Tuple&)> next;
    std::function<void(const Tuple&)> reset;
};
using OpCreator    = std::function<Operator(Operator)>;
using DblOpCreator = std::function<std::pair<Operator,Operator>(Operator)>;

//--------------------------------------------------------------------------------
// Conversion utilities
//--------------------------------------------------------------------------------
inline std::string string_of_mac(const std::array<uint8_t,6>& buf) {
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (size_t i = 0; i < buf.size(); ++i) {
        oss << std::setw(2) << static_cast<int>(buf[i]);
        if (i + 1 < buf.size()) oss << ':';
    }
    return oss.str();
}
inline std::string tcp_flags_to_strings(int flags) {
    static const std::map<std::string,int> flag_map = {
        {"FIN",1<<0},{"SYN",1<<1},{"RST",1<<2},
        {"PSH",1<<3},{"ACK",1<<4},{"URG",1<<5},
        {"ECE",1<<6},{"CWR",1<<7}
    };
    std::string acc;
    for (auto& [key,bit] : flag_map) {
        if ((flags & bit) == bit) {
            if (!acc.empty()) acc += '|';
            acc += key;
        }
    }
    return acc;
}
inline int int_of_op_result(const OpResult& v) {
    if (auto p = std::get_if<int>(&v)) return *p;
    throw std::runtime_error("Extracting int from non-int");
}
inline double float_of_op_result(const OpResult& v) {
    if (auto p = std::get_if<double>(&v)) return *p;
    throw std::runtime_error("Extracting float from non-float");
}
inline std::string string_of_op_result(const OpResult& v) {
    struct Visitor {
        std::string operator()(double f) const { return std::to_string(f); }
        std::string operator()(int i) const { return std::to_string(i); }
        std::string operator()(const boost::asio::ip::address_v4& ip) const { return ip.to_string(); }
        std::string operator()(const std::array<uint8_t,6>& m) const { return string_of_mac(m); }
        std::string operator()(std::monostate) const { return "Empty"; }
    };
    return std::visit(Visitor{}, v);
}
inline std::string string_of_tuple(const Tuple& t) {
    std::string s;
    for (auto& [k,v] : t) {
        s += '"' + k + "" => " + string_of_op_result(v) + ", ";
    }
    return s;
}
inline Tuple tuple_of_list(const std::vector<std::pair<std::string,OpResult>>& L) {
    Tuple t;
    for (auto& p : L) t.emplace(p);
    return t;
}
inline void dump_tuple(std::ostream& os, const Tuple& t) { os << string_of_tuple(t) << '\n'; }
inline int lookup_int(const Tuple& t, const std::string& k) { return int_of_op_result(t.at(k)); }
inline double lookup_float(const Tuple& t, const std::string& k) { return float_of_op_result(t.at(k)); }
inline OpResult get_ip_or_zero(const std::string& s) {
    if (s == "0") return OpResult(int(0));
    return OpResult(boost::asio::ip::address_v4::from_string(s));
}

//--------------------------------------------------------------------------------
// Operator creators
//--------------------------------------------------------------------------------
inline Operator dump_tuple_op(std::ostream& os, bool show_reset=false) {
    return Operator{
        [&](auto& t){ dump_tuple(os,t); },
        [&](auto& t){ if(show_reset){ dump_tuple(os,t); os<<"[reset]\n";} }
    };
}
inline Operator dump_as_csv_op(std::ostream& os, bool header=true,
                               const std::pair<std::string,std::string>* sf=nullptr) {
    bool first = header;
    return Operator{
        [&](auto& t) {
            if(first) {
                if(sf) os<<sf->first<<",";
                for(auto& [k,v]:t) os<<k<<",";
                os<<"\n";
                first=false;
            }
            if(sf) os<<sf->second<<",";
            for(auto& [k,v]:t) os<<string_of_op_result(v)<<",";
            os<<"\n";
        },
        [&](auto&){ }
    };
}
inline Operator dump_walts_csv_op(const std::string& file) {
    std::ofstream ofs;
    bool open=false;
    return Operator{
        [&](auto& t) {
            if(!open) { ofs.open(file); open=true; }
            ofs<<string_of_op_result(t.at("src_ip"))<<","<<string_of_op_result(t.at("dst_ip"))
               <<","<<string_of_op_result(t.at("src_l4_port"))<<","<<string_of_op_result(t.at("dst_l4_port"))
               <<","<<string_of_op_result(t.at("packet_count"))<<","<<string_of_op_result(t.at("byte_count"))
               <<","<<string_of_op_result(t.at("epoch_id"))<<"\n";
        },
        [&](auto&){ }
    };
}
inline void read_walts_csv(const std::vector<std::string>& files,
                           const std::vector<Operator>& ops,
                           const std::string& eid_key="eid") {
    struct State { std::ifstream in; int eid=0, cnt=0; bool alive=true; };
    std::vector<State> S;
    for(auto& f:files) S.emplace_back(State{std::ifstream(f)});
    int running = ops.size();
    while(running>0) {
        for(size_t i=0;i<S.size();++i) {
            auto& st=S[i]; auto& op=ops[i];
            if(!st.alive) continue;
            std::string line;
            if(std::getline(st.in, line)) {
                std::vector<std::string> p;
                boost::split(p, line, boost::is_any_of(","));
                int sport=std::stoi(p[2]), dport=std::stoi(p[3]);
                int pc=std::stoi(p[4]), bc=std::stoi(p[5]), eid=std::stoi(p[6]);
                Tuple t;
                t["ipv4.src"]=get_ip_or_zero(p[0]);
                t["ipv4.dst"]=get_ip_or_zero(p[1]);
                t["l4.sport"]=sport; t["l4.dport"]=dport;
                t["packet_count"]=pc; t["byte_count"]=bc;
                t[eid_key]=eid;
                ++st.cnt;
                if(eid>st.eid) {
                    while(eid>st.eid) {
                        op.reset(Tuple{{eid_key, st.eid}, {"tuples", st.cnt}});
                        st.cnt=0; ++st.eid;
                    }
                }
                t["tuples"]=st.cnt;
                op.next(t);
            } else {
                st.alive=false;
                op.reset(Tuple{{eid_key, st.eid+1}, {"tuples", st.cnt}});
                --running;
            }
        }
    }
    std::cout<<"Done.\n";
}
inline Operator meta_meter(const std::string& name, std::ostream& os,
                            Operator next_op,
                            const std::string* sf=nullptr) {
    int epoch=0, cnt=0;
    return Operator{
        [&](auto& t){ ++cnt; next_op.next(t); },
        [&](auto& t){ os<<epoch++<<","<<name<<","<<cnt;
                      if(sf) os<<","<<*sf;
                      os<<"\n"; cnt=0; next_op.reset(t);
        }
    };
}
inline Operator epoch(float width, const std::string& key, Operator next_op) {
    float boundary=0.0f;
    int eid=0;
    return Operator{
        [&](auto& t){ float time=float_of_op_result(t.at("time"));
                      if(boundary==0.0f) boundary=time+width;
                      else while(time>=boundary) {
                          next_op.reset(Tuple{{key,eid}});
                          boundary+=width; ++eid;
                      }
                      Tuple nt=t; nt[key]=eid;
                      next_op.next(nt);
        },
        [&](auto&){ next_op.reset(Tuple{{key,eid}});
                  boundary=0.0f; eid=0;
        }
    };
}
inline Operator filter_op(std::function<bool(const Tuple&)> f, Operator next_op) {
    return Operator{
        [&](auto& t){ if(f(t)) next_op.next(t); },
        [&](auto& t){ next_op.reset(t); }
    };
}
inline Operator map_op(std::function<Tuple(const Tuple&)> fn, Operator next_op) {
    return Operator{
        [&](auto& t){ next_op.next(fn(t)); },
        [&](auto& t){ next_op.reset(t); }
    };
}
inline Operator groupby(std::function<Tuple(const Tuple&)> key_fn,
                        std::function<OpResult(const OpResult&, const Tuple&)> red_fn,
                        const std::string& out_key,
                        Operator next_op) {
    std::map<Tuple,OpResult> ht;
    return Operator{
        [&](auto& t){ Tuple k=key_fn(t);
                      auto it=ht.find(k);
                      if(it!=ht.end()) it->second = red_fn(it->second, t);
                      else ht[k] = red_fn(OpResult{}, t);
        },
        [&](auto& t){ for(auto& [k,v]: ht) {
                          Tuple u=t;
                          for(auto& [kk,vv]: k) u[kk]=vv;
                          u[out_key]=v;
                          next_op.next(u);
                      }
                      next_op.reset(t);
                      ht.clear();
        }
    };
}
inline Operator distinct(std::function<Tuple(const Tuple&)> key_fn, Operator next_op) {
    std::set<Tuple> seen;
    return Operator{
        [&](auto& t){ seen.insert(key_fn(t)); },
        [&](auto& t){ for(auto& k: seen) {
                          Tuple u=t;
                          for(auto& [kk,vv]: k) u[kk]=vv;
                          next_op.next(u);
                      }
                      next_op.reset(t);
                      seen.clear();
        }
    };
}
inline Operator split_op(Operator l, Operator r) {
    return Operator{
        [&](auto& t){ l.next(t); r.next(t); },
        [&](auto& t){ l.reset(t); r.reset(t); }
    };
}
inline std::pair<Operator,Operator> join(std::function<std::pair<Tuple,Tuple>(const Tuple&)> left_fn,
                                         std::function<std::pair<Tuple,Tuple>(const Tuple&)> right_fn,
                                         Operator next_op,
                                         const std::string& eid_key="eid") {
    std::map<Tuple,Tuple> htL, htR;
    int eL=0, eR=0;
    auto make_side=[&](auto& mine, auto& other, int& me, int& oth, bool isLeft){
        return Operator{
            [&](auto& t){ auto pr = isLeft ? left_fn(t) : right_fn(t);
                          Tuple k = pr.first;
                          Tuple v = pr.second;
                          int eid = lookup_int(t, eid_key);
                          while(eid>me) {
                              if(oth>me) next_op.reset(Tuple{{eid_key,me}});
                              ++me;
                          }
                          k[eid_key] = eid;
                          auto it = other.find(k);
                          if(it!=other.end()) {
                              Tuple merged = k;
                              for(auto& [kk,vv]: (isLeft? it->second : v)) merged[kk]=vv;
                              next_op.next(merged);
                              other.erase(it);
                          } else {
                              mine[k]=v;
                          }
            },
            [&](auto& t){ int eid = lookup_int(t, eid_key);
                          while(eid>me) {
                              if(oth>me) next_op.reset(Tuple{{eid_key,me}});
                              ++me;
                          }
            }
        };
    };
    Operator L = make_side(htL, htR, eL, eR, true);
    Operator R = make_side(htR, htL, eR, eL, false);
    return {L, R};
}

//--------------------------------------------------------------------------------
// Utilities for Sonatas
//--------------------------------------------------------------------------------
inline Tuple filter_groups(const Tuple& tup, const std::vector<std::string>& keys) {
    Tuple out;
    for(auto& k: keys) {
        auto it = tup.find(k);
        if(it!=tup.end()) out.emplace(*it);
    }
    return out;
}
inline OpResult counter(const OpResult& acc, const Tuple&) {
    if(auto p = std::get_if<int>(&acc)) return *p+1;
    return 1;
}
inline std::function<OpResult(const OpResult&,const Tuple&)> sum_ints_fn(const std::string& key) {
    return [key](auto& acc, auto& tup){ int base=0;
        if(auto p = std::get_if<int>(&acc)) base=*p;
        auto it=tup.find(key);
        if(it!=tup.end()) if(auto q=std::get_if<int>(&it->second)) base+=*q;
        return base;
    };
}

// Sonata queries
inline Operator ident(Operator next_op) {
    return map_op(
        [](auto& tup){ Tuple o; for(auto& [k,v]:tup) if(k!="eth.src"&&k!="eth.dst") o[k]=v; return o; },
        next_op);
}
inline Operator count_pkts(Operator next_op) {
    return epoch(1.0f, "eid",
           groupby([](auto&){ return Tuple{}; }, counter, "pkts", next_op));
}
inline Operator pkts_per_src_dst(Operator next_op) {
    return epoch(1.0f, "eid",
           groupby([](auto& t){ return filter_groups(t,{"ipv4.src","ipv4.dst"}); }, counter, "pkts", next_op));
}
inline Operator distinct_srcs(Operator next_op) {
    return epoch(1.0f, "eid",
           distinct([](auto& t){ return filter_groups(t,{"ipv4.src"}); },
           groupby([](auto&){ return Tuple{}; }, counter, "srcs", next_op)));
}
inline Operator tcp_new_cons(Operator next_op) {
    return epoch(1.0f, "eid",
           filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && lookup_int(t,"l4.flags")==2; },
           groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "cons",
           filter_op([](auto& t){ return lookup_int(t,"cons")>=40; }, next_op))));
}
inline Operator ssh_brute_force(Operator next_op) {
    return epoch(1.0f, "eid",
           filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && lookup_int(t,"l4.dport")==22; },
           distinct([](auto& t){ return filter_groups(t,{"ipv4.src","ipv4.dst","ipv4.len"}); },
           groupby([](auto& t){ return filter_groups(t,{"ipv4.dst","ipv4.len"}); }, counter, "srcs",
           filter_op([](auto& t){ return lookup_int(t,"srcs")>=40; }, next_op)))));
}
inline Operator super_spreader(Operator next_op) {
    return epoch(1.0f, "eid",
           distinct([](auto& t){ return filter_groups(t,{"ipv4.src","ipv4.dst"}); },
           groupby([](auto& t){ return filter_groups(t,{"ipv4.src"}); }, counter, "dsts",
           filter_op([](auto& t){ return lookup_int(t,"dsts")>=40; }, next_op))));
}
inline Operator port_scan(Operator next_op) {
    return epoch(1.0f, "eid",
           distinct([](auto& t){ return filter_groups(t,{"ipv4.src","l4.dport"}); },
           groupby([](auto& t){ return filter_groups(t,{"ipv4.src"}); }, counter, "ports",
           filter_op([](auto& t){ return lookup_int(t,"ports")>=40; }, next_op))));
}
inline Operator ddos(Operator next_op) {
    return epoch(1.0f, "eid",
           distinct([](auto& t){ return filter_groups(t,{"ipv4.src","ipv4.dst"}); },
           groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "srcs",
           filter_op([](auto& t){ return lookup_int(t,"srcs")>=45; }, next_op))));
}
inline std::vector<Operator> syn_flood_sonata(Operator next_op) {
    auto syns = epoch(1.0f, "eid",
                 filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && (lookup_int(t,"l4.flags")==2); },
                 groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "syns", next_op)));
    auto synacks = epoch(1.0f, "eid",
                    filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && (lookup_int(t,"l4.flags")==18); },
                    groupby([](auto& t){ return filter_groups(t,{"ipv4.src"}); }, counter, "synacks", next_op)));
    auto acks = epoch(1.0f, "eid",
               filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && (lookup_int(t,"l4.flags")==16); },
               groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "acks", next_op)));
    auto [j1, j2] = join(
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.dst"}), filter_groups(t,{"syns"})); },
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.src"}), filter_groups(t,{"synacks"})); },
        map_op([](auto& tup){ Tuple o=tup; o["syns+synacks"] = OpResult(lookup_int(tup,"syns")+lookup_int(tup,"synacks")); return o; }, next_op));
    return {syns, synacks, acks, j1, j2};
}
inline std::vector<Operator> completed_flows(Operator next_op) {
    auto syns = epoch(30.0f, "eid",
                 filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && ((lookup_int(t,"l4.flags") & 1)==1); },
                 groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "syns", next_op)));
    auto fins = epoch(30.0f, "eid",
                filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && ((lookup_int(t,"l4.flags") & 1)==1); },
                groupby([](auto& t){ return filter_groups(t,{"ipv4.src"}); }, counter, "fins", next_op)));
    auto [j1, j2] = join(
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.dst"}), filter_groups(t,{"syns"})); },
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.src"}), filter_groups(t,{"fins"})); },
        filter_op([](auto& tup){ return (lookup_int(tup,"syns")-lookup_int(tup,"fins"))>0; }, next_op));
    return {syns, fins, j1, j2};
}
inline std::vector<Operator> slowloris(Operator next_op) {
    auto n_conns = epoch(1.0f, "eid",
                    filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6; },
                    distinct([](auto& t){ return filter_groups(t,{"ipv4.src","ipv4.dst","l4.sport"}); },
                    groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "n_conns",
                    filter_op([](auto& t){ return lookup_int(t,"n_conns")>=5; }, next_op)))));
    auto n_bytes = epoch(1.0f, "eid",
                    filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6; },
                    groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, sum_ints_fn("ipv4.len"), "n_bytes",
                    filter_op([](auto& t){ return lookup_int(t,"n_bytes")>=500; }, next_op))));
    auto [j1, j2] = join(
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.dst"}), filter_groups(t,{"n_conns"})); },
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.dst"}), filter_groups(t,{"n_bytes"})); },
        filter_op([](auto& tup){ return (lookup_int(tup,"n_bytes")/lookup_int(tup,"n_conns"))<=90; }, next_op));
    return {n_conns, n_bytes, j1, j2};
}
inline std::vector<Operator> join_test(Operator next_op) {
    auto syns = epoch(1.0f, "eid",
                 filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && lookup_int(t,"l4.flags")==2; }, next_op));
    auto synacks = epoch(1.0f, "eid",
                    filter_op([](auto& t){ return lookup_int(t,"ipv4.proto")==6 && lookup_int(t,"l4.flags")==18; }, next_op));
    auto [j1, j2] = join(
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.src"}), filter_groups(t,{"ipv4.dst"})); },
        [](auto& t){ return std::make_pair(filter_groups(t,{"ipv4.dst"}), filter_groups(t,{"time"})); },
        next_op);
    return {syns, synacks, j1, j2};
}
inline Operator q3(Operator next_op) {
    return epoch(100.0f, "eid",
           distinct([](auto& t){ return filter_groups(t,{"ipv4.src","ipv4.dst"}); }, next_op));
}
inline Operator q4(Operator next_op) {
    return epoch(10000.0f, "eid",
           groupby([](auto& t){ return filter_groups(t,{"ipv4.dst"}); }, counter, "pkts", next_op));
}

} // namespace walt

#endif // WALT_UTILS_HPP
