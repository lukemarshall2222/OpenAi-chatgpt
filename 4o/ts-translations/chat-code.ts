// ===============================================
// Basic Types
// ===============================================

type IPv4 = string;
type MAC = Uint8Array;

type OpResult =
  | { kind: 'Float'; value: number }
  | { kind: 'Int'; value: number }
  | { kind: 'IPv4'; value: IPv4 }
  | { kind: 'MAC'; value: MAC }
  | { kind: 'Empty' };

type Tuple = Map<string, OpResult>;

interface Operator {
  next: (tuple: Tuple) => void;
  reset: (tuple: Tuple) => void;
}

type OpCreator = (nextOp: Operator) => Operator;
type DblOpCreator = (nextOp: Operator) => [Operator, Operator];

// ===============================================
// Basic Helpers
// ===============================================

function stringOfMac(mac: MAC): string {
  return Array.from(mac).map(b => b.toString(16).padStart(2, '0')).join(':');
}

function tcpFlagsToStrings(flags: number): string {
  const tcpFlags = {
    FIN: 1 << 0,
    SYN: 1 << 1,
    RST: 1 << 2,
    PSH: 1 << 3,
    ACK: 1 << 4,
    URG: 1 << 5,
    ECE: 1 << 6,
    CWR: 1 << 7,
  };
  return Object.keys(tcpFlags)
    .filter(key => (flags & tcpFlags[key as keyof typeof tcpFlags]) !== 0)
    .join('|');
}

function intOfOpResult(input: OpResult): number {
  if (input.kind === 'Int') return input.value;
  throw new Error('Trying to extract int from non-int result');
}

function floatOfOpResult(input: OpResult): number {
  if (input.kind === 'Float') return input.value;
  throw new Error('Trying to extract float from non-float result');
}

function stringOfOpResult(input: OpResult): string {
  switch (input.kind) {
    case 'Float': return input.value.toFixed(6);
    case 'Int': return input.value.toString();
    case 'IPv4': return input.value;
    case 'MAC': return stringOfMac(input.value);
    case 'Empty': return 'Empty';
  }
}

function tupleOfList(entries: [string, OpResult][]): Tuple {
  return new Map(entries);
}

function stringOfTuple(tuple: Tuple): string {
  return Array.from(tuple.entries())
    .map(([key, val]) => `"${key}" => ${stringOfOpResult(val)}`)
    .join(', ');
}

function lookupInt(key: string, tup: Tuple): number {
  const val = tup.get(key);
  if (!val) throw new Error(`Missing key ${key}`);
  return intOfOpResult(val);
}

function lookupFloat(key: string, tup: Tuple): number {
  const val = tup.get(key);
  if (!val) throw new Error(`Missing key ${key}`);
  return floatOfOpResult(val);
}

function getIpOrZero(input: string): OpResult {
  if (input === "0") return { kind: 'Int', value: 0 };
  return { kind: 'IPv4', value: input };
}

// ===============================================
// Operator Combinators
// ===============================================

function chain(opCreator: OpCreator, nextOp: Operator): Operator {
  return opCreator(nextOp);
}

function chainDouble(opCreator: DblOpCreator, op: Operator): [Operator, Operator] {
  return opCreator(op);
}

// ===============================================
// Operator Implementations
// ===============================================

function dumpTuple(): Operator {
  return {
    next: (tup) => console.log(stringOfTuple(tup)),
    reset: (_) => { }
  };
}

function filter(f: (t: Tuple) => boolean): OpCreator {
  return (nextOp) => ({
    next: (tup) => { if (f(tup)) nextOp.next(tup); },
    reset: (tup) => nextOp.reset(tup),
  });
}

function map(f: (t: Tuple) => Tuple): OpCreator {
  return (nextOp) => ({
    next: (tup) => nextOp.next(f(tup)),
    reset: (tup) => nextOp.reset(tup),
  });
}

function epoch(epochWidth: number, keyOut: string): OpCreator {
  let epochBoundary = 0.0;
  let eid = 0;
  return (nextOp) => ({
    next: (tup) => {
      const time = floatOfOpResult(tup.get("time")!);
      if (epochBoundary === 0.0) {
        epochBoundary = time + epochWidth;
      } else if (time >= epochBoundary) {
        while (time >= epochBoundary) {
          nextOp.reset(tupleOfList([[keyOut, { kind: 'Int', value: eid }]]));
          epochBoundary += epochWidth;
          eid++;
        }
      }
      tup.set(keyOut, { kind: 'Int', value: eid });
      nextOp.next(tup);
    },
    reset: (_) => {
      nextOp.reset(tupleOfList([[keyOut, { kind: 'Int', value: eid }]]));
      epochBoundary = 0.0;
      eid = 0;
    }
  });
}

function keyGeqInt(key: string, threshold: number) {
  return (tup: Tuple) => lookupInt(key, tup) >= threshold;
}

function filterGroups(keys: string[]) {
  return (tup: Tuple): Tuple => {
    const result = new Map<string, OpResult>();
    keys.forEach(k => {
      if (tup.has(k)) result.set(k, tup.get(k)!);
    });
    return result;
  };
}

function groupby(groupingFunc: (t: Tuple) => Tuple, reducer: (agg: OpResult, tup: Tuple) => OpResult, outKey: string): OpCreator {
  const table = new Map<string, OpResult>();

  function tupleKey(t: Tuple): string {
    return JSON.stringify([...t.entries()].sort());
  }

  return (nextOp) => ({
    next: (tup) => {
      const key = groupingFunc(tup);
      const keyStr = tupleKey(key);
      const current = table.get(keyStr) ?? { kind: 'Empty' };
      table.set(keyStr, reducer(current, tup));
    },
    reset: (tup) => {
      for (const [keyStr, val] of table) {
        const groupTuple: Tuple = new Map(JSON.parse(keyStr));
        const merged = new Map(tup);
        for (const [k, v] of groupTuple) merged.set(k, v);
        merged.set(outKey, val);
        nextOp.next(merged);
      }
      table.clear();
      nextOp.reset(tup);
    }
  });
}

function counter(agg: OpResult, _: Tuple): OpResult {
  if (agg.kind === 'Empty') return { kind: 'Int', value: 1 };
  if (agg.kind === 'Int') return { kind: 'Int', value: agg.value + 1 };
  throw new Error('counter expects Empty or Int');
}

function distinct(groupby: (t: Tuple) => Tuple): OpCreator {
  const table = new Set<string>();

  function tupleKey(t: Tuple): string {
    return JSON.stringify([...t.entries()].sort());
  }

  return (nextOp) => ({
    next: (tup) => {
      const key = groupingFunc(tup);
      table.add(tupleKey(key));
    },
    reset: (tup) => {
      for (const keyStr of table) {
        const groupTuple: Tuple = new Map(JSON.parse(keyStr));
        const merged = new Map(tup);
        for (const [k, v] of groupTuple) merged.set(k, v);
        nextOp.next(merged);
      }
      table.clear();
      nextOp.reset(tup);
    }
  });
}

// ===============================================
// Example Query Setup
// ===============================================

const queries: Operator[] = [
  chain(
    map((tup) => {
      const filtered = new Map(tup);
      filtered.delete("eth.src");
      filtered.delete("eth.dst");
      return filtered;
    }),
    dumpTuple()
  )
];

function split(left: Operator, right: Operator): Operator {
    return {
        next: (tup) => { 
            left.next(tup);
            right.next(tup); 
        },
        reset: (tup) => { 
            left.reset(tup);
            right.reset(tup); 
        },
    };
}

function metaMeter(name: string, staticField: string | null, output: (line: string) => void): OpCreator {
    let epochCount = 0;
    let tupsCount = 0;

    return (nextOp) => ({
        next: (tup) => { 
            tupsCount++;
            nextOp.next(tup);
        },
        reset: (tup) => {
            const staticFieldPart = staticField ? staticField : "";
            output(`${epochCount},${name},${tupsCount},${staticFieldPart}`);
            tupsCount = 0;
            epochCount++;
            nextOp.reset(tup);
        },
    });
}

function dumpAsCSV(staticField: [string, string] | null, header: boolean, output: (line: string) => void): OpCreator {
    let first = true;

    return (nextOp) => ({
        next: (tup) => {
            if (first && header) {
                const keys = Array.from(tup.keys());
                const headers = staticField ? [staticField[0], ...keys] : keys;
                output(headers.join(","));
                first = false;
            }
            const row = Array.from(tup.values())
                .map(stringOfOpResult);
            const fields = staticField ? [staticField[1], ...row] : row;
            output(fields.join(","));
            nextOp.next(tup);
        },
        reset: (tup) => {
            nextOp.reset(tup);
        },
    });
}

function join(
    leftExtractor: (t: Tuple) => [Tuple, Tuple],
    rightExtractor: (t: Tuple) => [Tuple, Tuple],
    eidKey = "eid"
): DblOpCreator {
    const leftTable = new Map<string, Tuple>();
    const rightTable = new Map<string, Tuple>();
    let leftEpoch = 0;
    let rightEpoch = 0;

    function tupleKey(t: Tuple): string {
        return JSON.stringify([...t.entries()].sort());
    }

    function handleJoin(
        currTable: Map<string, Tuple>,
        otherTable: Map<string, Tuple>,
        currEpochRef: { value: number },
        otherEpochRef: { value: number },
        extractor: (t: Tuple) => [Tuple, Tuple]
    ): OpCreator {
        return (nextOp) => ({
            next: (tup) => {
                const [key, vals] = extractor(tup);
                const currEpoch = lookupInt(eidKey, tup);

                while (currEpoch > currEpochRef.value) {
                    if (otherEpochRef.value > currEpochRef.value) {
                        nextOp.reset(tupleOfList([[eidKey, { kind: 'Int', value: currEpochRef.value }]]));
                    }
                    currEpochRef.value++;
                }

                const compositeKey = tupleKey(key);
                if (otherTable.has(compositeKey)) {
                    const match = otherTable.get(compositeKey)!;
                    const merged = new Map([...key, ...vals, ...match]);
                    merged.set(eidKey, { kind: 'Int', value: currEpoch });
                    nextOp.next(merged);
                    otherTable.delete(compositeKey);
                } else {
                    currTable.set(compositeKey, vals);
                }
            },
            reset: (tup) => {
                const currEpoch = lookupInt(eidKey, tup);
                while (currEpoch > currEpochRef.value) {
                    if (otherEpochRef.value > currEpochRef.value) {
                        nextOp.reset(tupleOfList([[eidKey, { kind: 'Int', value: currEpochRef.value }]]));
                    }
                    currEpochRef.value++;
                }
            },
        });
    }

    const leftEpochRef = { value: 0 };
    const rightEpochRef = { value: 0 };

    const leftOp = handleJoin(leftTable, rightTable, leftEpochRef, rightEpochRef, leftExtractor);
    const rightOp = handleJoin(rightTable, leftTable, rightEpochRef, leftEpochRef, rightExtractor);

    return (nextOp) => [leftOp(nextOp), rightOp(nextOp)];
}

function countPkts(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                groupby(singleGroup, counter, "pkts"),
                nextOp
            )
        );
}

function singleGroup(_: Tuple): Tuple {
    return new Map();
}

function ddos(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                distinct(filterGroups(["ipv4.src", "ipv4.dst"])),
                chain(
                    groupby(filterGroups(["ipv4.dst"]), counter, "srcs"),
                    chain(
                        filter(keyGeqInt("srcs", 45)),
                        nextOp
                    )
                )
            )
        );
}

function renameFilteredKeys(renamePairs: [string, string][], tup: Tuple): Tuple {
    const result = new Map<string, OpResult>();
    for (const [oldKey, newKey] of renamePairs) {
        const val = tup.get(oldKey);
        if (val !== undefined) {
            result.set(newKey, val);
        }
    }
    return result;
}

function ident(): OpCreator {
    return (nextOp) =>
        chain(
            map(tup => {
                const newTup = new Map(tup);
                newTup.delete("eth.src");
                newTup.delete("eth.dst");
                return newTup;
            }),
            nextOp
        );
}

function countPkts(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                groupby(singleGroup, counter, "pkts"),
                nextOp
            )
        );
}

function pktsPerSrcDst(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                groupby(filterGroups(["ipv4.src", "ipv4.dst"]), counter, "pkts"),
                nextOp
            )
        );
}

function distinctSrcs(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                distinct(filterGroups(["ipv4.src"])),
                chain(
                    groupby(singleGroup, counter, "srcs"),
                    nextOp
                )
            )
        );
}

function tcpNewCons(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                filter(tup => lookupInt("ipv4.proto", tup) === 6 && lookupInt("l4.flags", tup) === 2),
                chain(
                    groupby(filterGroups(["ipv4.dst"]), counter, "cons"),
                    chain(
                        filter(keyGeqInt("cons", 40)),
                        nextOp
                    )
                )
            )
        );
}

function sshBruteForce(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                filter(tup => lookupInt("ipv4.proto", tup) === 6 && lookupInt("l4.dport", tup) === 22),
                chain(
                    distinct(filterGroups(["ipv4.src", "ipv4.dst", "ipv4.len"])),
                    chain(
                        groupby(filterGroups(["ipv4.dst", "ipv4.len"]), counter, "srcs"),
                        chain(
                            filter(keyGeqInt("srcs", 40)),
                            nextOp
                        )
                    )
                )
            )
        );
}

function superSpreader(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                distinct(filterGroups(["ipv4.src", "ipv4.dst"])),
                chain(
                    groupby(filterGroups(["ipv4.src"]), counter, "dsts"),
                    chain(
                        filter(keyGeqInt("dsts", 40)),
                        nextOp
                    )
                )
            )
        );
}

function portScan(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                distinct(filterGroups(["ipv4.src", "l4.dport"])),
                chain(
                    groupby(filterGroups(["ipv4.src"]), counter, "ports"),
                    chain(
                        filter(keyGeqInt("ports", 40)),
                        nextOp
                    )
                )
            )
        );
}

function ddos(): OpCreator {
    return (nextOp) =>
        chain(
            epoch(1.0, "eid"),
            chain(
                distinct(filterGroups(["ipv4.src", "ipv4.dst"])),
                chain(
                    groupby(filterGroups(["ipv4.dst"]), counter, "srcs"),
                    chain(
                        filter(keyGeqInt("srcs", 45)),
                        nextOp
                    )
                )
            )
        );
}

function synFloodSonata(): (nextOp: Operator) => Operator[] {
    return (nextOp) => {
        const syns = (nextOp2: Operator) =>
            chain(
                epoch(1.0, "eid"),
                chain(
                    filter(tup => lookupInt("ipv4.proto", tup) === 6 && lookupInt("l4.flags", tup) === 2),
                    chain(
                        groupby(filterGroups(["ipv4.dst"]), counter, "syns"),
                        nextOp2
                    )
                )
            );

        const synacks = (nextOp2: Operator) =>
            chain(
                epoch(1.0, "eid"),
                chain(
                    filter(tup => lookupInt("ipv4.proto", tup) === 6 && lookupInt("l4.flags", tup) === 18),
                    chain(
                        groupby(filterGroups(["ipv4.src"]), counter, "synacks"),
                        nextOp2
                    )
                )
            );

        const acks = (nextOp2: Operator) =>
            chain(
                epoch(1.0, "eid"),
                chain(
                    filter(tup => lookupInt("ipv4.proto", tup) === 6 && lookupInt("l4.flags", tup) === 16),
                    chain(
                        groupby(filterGroups(["ipv4.dst"]), counter, "acks"),
                        nextOp2
                    )
                )
            );

        const [join1, join2] = join(
            tup => [filterGroups(["host"])(tup), filterGroups(["syns+synacks"])(tup)],
            tup => [renameFilteredKeys([["ipv4.dst", "host"]], tup), filterGroups(["acks"])(tup)]
        )(
            chain(
                map(tup => {
                    const synsSynacks = lookupInt("syns+synacks", tup);
                    const acksVal = lookupInt("acks", tup);
                    tup.set("syns+synacks-acks", { kind: "Int", value: synsSynacks - acksVal });
                    return tup;
                }),
                filter(keyGeqInt("syns+synacks-acks", 3))
            )(nextOp)
        );

        const [join3, join4] = join(
            tup => [renameFilteredKeys([["ipv4.dst", "host"]], tup), filterGroups(["syns"])(tup)],
            tup => [renameFilteredKeys([["ipv4.src", "host"]], tup), filterGroups(["synacks"])(tup)]
        )(join1);

        return [
            syns(join3),
            synacks(join4),
            acks(join2)
        ];
    };
}



// ===============================================
// Entry Point Example
// ===============================================

function runQueries() {
  for (let i = 0; i < 20; i++) {
    const tup: Tuple = new Map([
      ["time", { kind: "Float", value: i * 1.0 }],
      ["eth.src", { kind: "MAC", value: new Uint8Array([0, 17, 34, 51, 68, 85]) }],
      ["eth.dst", { kind: "MAC", value: new Uint8Array([170, 187, 204, 221, 238, 255]) }],
      ["eth.ethertype", { kind: "Int", value: 0x0800 }],
      ["ipv4.hlen", { kind: "Int", value: 20 }],
      ["ipv4.proto", { kind: "Int", value: 6 }],
      ["ipv4.len", { kind: "Int", value: 60 }],
      ["ipv4.src", { kind: "IPv4", value: "127.0.0.1" }],
      ["ipv4.dst", { kind: "IPv4", value: "127.0.0.1" }],
      ["l4.sport", { kind: "Int", value: 440 }],
      ["l4.dport", { kind: "Int", value: 50000 }],
      ["l4.flags", { kind: "Int", value: 10 }]
    ]);
    for (const query of queries) {
      query.next(tup);
    }
  }
  console.log("Done.");
}

runQueries();
