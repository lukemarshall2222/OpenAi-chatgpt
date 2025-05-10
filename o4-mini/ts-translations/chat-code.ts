// common.ts

import * as fs from 'fs';
import { Writable } from 'stream';

/**
 * Variant type for operator results
 */
export type OpResult =
  | { type: 'Float'; value: number }
  | { type: 'Int';   value: number }
  | { type: 'IPv4';  value: string }       // store as a dot-string
  | { type: 'MAC';   value: Uint8Array }   // 6-byte buffer
  | { type: 'Empty' };

/** A tuple is just a map from field→OpResult */
export type Tuple = Map<string, OpResult>;

/** Stream‐processing operator */
export interface Operator {
  next:  (t: Tuple) => void;
  reset: (t: Tuple) => void;
}

/** Single‐chain creator: Operator → Operator */
export type OpCreator    = (next: Operator) => Operator;
/** Double‐chain creator: Operator → [Operator,Operator] */
export type DblOpCreator = (next: Operator) => [Operator, Operator];

/** Right‐associative chaining of OpCreators */
export function chain(f: OpCreator, next: Operator): Operator {
  return f(next);
}
/** Right‐assoc chaining of DblOpCreators */
export function chain2(f: DblOpCreator, next: Operator): [Operator, Operator] {
  return f(next);
}


// -----------------------------------------------------------------------------
// Conversion utilities
// -----------------------------------------------------------------------------

/** format 6-byte MAC buffer as "aa:bb:cc:dd:ee:ff" */
export function stringOfMac(buf: Uint8Array): string {
  return Array.from(buf)
    .map(b => b.toString(16).padStart(2, '0'))
    .join(':');
}

/** TCP-flag bits → "SYN|ACK" style */
export function tcpFlagsToStrings(flags: number): string {
  const map: [string, number][] = [
    ['FIN',  1 << 0],
    ['SYN',  1 << 1],
    ['RST',  1 << 2],
    ['PSH',  1 << 3],
    ['ACK',  1 << 4],
    ['URG',  1 << 5],
    ['ECE',  1 << 6],
    ['CWR',  1 << 7],
  ];
  return map
    .filter(([, bit]) => (flags & bit) === bit)
    .map(([name]) => name)
    .join('|');
}

export function intOfOpResult(r: OpResult): number {
  if (r.type === 'Int') return r.value;
  throw new Error('Expected Int but got ' + r.type);
}
export function floatOfOpResult(r: OpResult): number {
  if (r.type === 'Float') return r.value;
  throw new Error('Expected Float but got ' + r.type);
}
export function stringOfOpResult(r: OpResult): string {
  switch (r.type) {
    case 'Float': return r.value.toString();
    case 'Int':   return r.value.toString();
    case 'IPv4':  return r.value;
    case 'MAC':   return stringOfMac(r.value);
    case 'Empty': return 'Empty';
  }
}

/** "\"k\" => v, \"k2\" => v2, " */
export function stringOfTuple(t: Tuple): string {
  let out = '';
  for (const [k,v] of t.entries()) {
    out += `"${k}" => ${stringOfOpResult(v)}, `;
  }
  return out;
}

/** build a Tuple from a list of [key,OpResult] */
export function tupleOfList(pairs: [string, OpResult][]): Tuple {
  return new Map(pairs);
}

/** dump 1-line repr of tuple */
export function dumpTuple(outc: Writable, tup: Tuple): void {
  outc.write(stringOfTuple(tup) + '\n');
}

/** find an Int in the Tuple or throw */
export function lookupInt (key: string, t: Tuple): number {
  const v = t.get(key);
  if (!v) throw new Error(`Key ${key} not found`);
  return intOfOpResult(v);
}
/** find a Float in the Tuple or throw */
export function lookupFloat(key: string, t: Tuple): number {
  const v = t.get(key);
  if (!v) throw new Error(`Key ${key} not found`);
  return floatOfOpResult(v);
}

// -----------------------------------------------------------------------------
// Built-in operators
// -----------------------------------------------------------------------------

/** dump every tuple (and on reset optionally dump+print "[reset]") */
export function dumpOperator(
  showReset: boolean = false,
  outc: Writable
): Operator {
  return {
    next:  tup => dumpTuple(outc, tup),
    reset: tup => {
      if (showReset) {
        dumpTuple(outc, tup);
        outc.write('[reset]\n');
      }
    }
  };
}

/** CSV-style dump (assumes same fields/order) */
export function dumpAsCsv(
  header: boolean = true,
  outc: Writable,
  staticField?: [string,string],
): Operator {
  let first = header;
  return {
    next: tup => {
      if (first) {
        if (staticField) outc.write(staticField[0] + ',');
        outc.write(Array.from(tup.keys()).join(',') + '\n');
        first = false;
      }
      if (staticField) outc.write(staticField[1] + ',');
      outc.write(
        Array.from(tup.values())
          .map(stringOfOpResult)
          .join(',') + '\n'
      );
    },
    reset: _ => {}
  };
}

/** Walt’s “canonical” CSV: open on first tuple, then append. */
export function dumpWaltsCsv(filename: string): Operator {
  let stream: fs.WriteStream | null = null;
  return {
    next: tup => {
      if (!stream) stream = fs.createWriteStream(filename, { flags: 'w' });
      const f = (k: string) => stringOfOpResult(tup.get(k)!);
      const line = [
        f('src_ip'),
        f('dst_ip'),
        f('src_l4_port'),
        f('dst_l4_port'),
        f('packet_count'),
        f('byte_count'),
        f('epoch_id')
      ].join(',') + '\n';
      stream.write(line);
    },
    reset: _ => {}
  };
}

/** "0" → Int(0), else IPv4(string). */
export function getIpOrZero(s: string): OpResult {
  if (s === '0') return { type: 'Int', value: 0 };
  return { type: 'IPv4', value: s };
}

/**
 * Read Walt CSV files in lock-step, feeding each
 * operator one row at a time, handling epoch resets.
 */
export function readWaltsCsv(
  epochIdKey: string = 'eid',
  fileNames: string[],
  ops: Operator[]
): void {
  const allLines = fileNames.map(fn =>
    fs.readFileSync(fn, 'utf-8').split('\n')
  );
  const ptrs     = fileNames.map(_ => 0);
  const eids     = fileNames.map(_ => 0);
  const tupCount = fileNames.map(_ => 0);
  let running = ops.length;

  while (running > 0) {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (eids[i] < 0) continue;  // finished
      const lines = allLines[i];
      const p     = ptrs[i]++;
      if (p >= lines.length || lines[p].trim() === '') {
        // EOF
        op.reset(new Map([
          [ epochIdKey, { type: 'Int', value: eids[i] + 1 } ],
          [ 'tuples',    { type: 'Int', value: tupCount[i] } ]
        ]));
        running--;
        eids[i] = -1;
      } else {
        // parse one row
        const [src_ip, dst_ip, src_s, dst_s, pkt_s, byte_s, eid_s] =
          lines[p].split(',');
        const src_p = parseInt(src_s, 10);
        const dst_p = parseInt(dst_s, 10);
        const pkt   = parseInt(pkt_s, 10);
        const byt   = parseInt(byte_s, 10);
        const eid   = parseInt(eid_s, 10);

        // build tuple
        const tup: Tuple = new Map();
        tup.set('ipv4.src',   getIpOrZero(src_ip));
        tup.set('ipv4.dst',   getIpOrZero(dst_ip));
        tup.set('l4.sport',   { type: 'Int', value: src_p });
        tup.set('l4.dport',   { type: 'Int', value: dst_p });
        tup.set('packet_count', { type: 'Int', value: pkt });
        tup.set('byte_count',   { type: 'Int', value: byt });
        tup.set(epochIdKey,     { type: 'Int', value: eid });

        // count
        tupCount[i] += 1;
        // maybe fire resets
        while (eid > eids[i]) {
          op.reset(new Map([
            [ epochIdKey, { type: 'Int', value: eids[i] } ],
            [ 'tuples',    { type: 'Int', value: tupCount[i] } ]
          ]));
          tupCount[i] = 0;
          eids[i]++;
        }

        tup.set('tuples', { type: 'Int', value: tupCount[i] });
        op.next(tup);
      }
    }
  }
  console.log('Done.');
}


/** meter tuples per epoch */
export function metaMeter(
  staticField: string | null,
  name: string,
  outc: Writable,
  nextOp: Operator
): Operator {
  let epochCount = 0;
  let tupsCount  = 0;
  return {
    next: tup => {
      tupsCount++;
      nextOp.next(tup);
    },
    reset: tup => {
      outc.write(
        `${epochCount},${name},${tupsCount},${staticField ?? ''}\n`
      );
      tupsCount = 0;
      epochCount++;
      nextOp.reset(tup);
    }
  };
}


/** Helper: copy a Tuple and add key→Int(eid) */
function withEid(orig: Tuple, key: string, eid: number): Tuple {
  const t2 = new Map(orig);
  t2.set(key, { type: 'Int', value: eid });
  return t2;
}

/** attach epoch IDs based on “time” field */
export function epoch(
  epochWidth: number,
  keyOut: string,
  nextOp: Operator
): Operator {
  let boundary = 0;
  let eid       = 0;

  return {
    next: tup => {
      const t = floatOfOpResult(tup.get('time')!);
      if (boundary === 0) {
        boundary = t + epochWidth;
      } else if (t >= boundary) {
        while (t >= boundary) {
          nextOp.reset(new Map([[ keyOut, { type: 'Int', value: eid } ]]));
          boundary += epochWidth;
          eid++;
        }
      }
      nextOp.next(withEid(tup, keyOut, eid));
    },
    reset: _ => {
      nextOp.reset(new Map([[ keyOut, { type: 'Int', value: eid } ]]));
      boundary = 0;
      eid      = 0;
    }
  };
}

/** only forward tuples passing `f` */
export function filterOp(
  f: (t: Tuple) => boolean,
  nextOp: Operator
): Operator {
  return {
    next: tup => { if (f(tup)) nextOp.next(tup); },
    reset: tup => nextOp.reset(tup)
  };
}

export function keyGeqInt(key: string, thresh: number, tup: Tuple): boolean {
  return lookupInt(key, tup) >= thresh;
}
export function getMappedInt(key: string, tup: Tuple): number {
  return lookupInt(key, tup);
}
export function getMappedFloat(key: string, tup: Tuple): number {
  return lookupFloat(key, tup);
}

/** apply a pure transform f to each tuple */
export function mapOp(
  f: (t: Tuple) => Tuple,
  nextOp: Operator
): Operator {
  return {
    next: tup => nextOp.next(f(tup)),
    reset: tup => nextOp.reset(tup)
  };
}


/** stable “string key” for a Tuple, by sorting and serializing */
function tupleKey(t: Tuple): string {
  const es = Array.from(t.entries())
    .sort((a,b) => a[0].localeCompare(b[0]))
    .map(([k,v]) => [k, stringOfOpResult(v)]);
  return JSON.stringify(es);
}

/**
 * groupBy: accumulate each tuple into buckets (by `groupFn`),
 * then on reset emit one output per bucket with `outKey→accum`.
 */
export function groupBy(
  groupFn: (t: Tuple) => Tuple,
  reduceFn: (acc: OpResult, t: Tuple) => OpResult,
  outKey: string,
  nextOp: Operator
): Operator {
  const table = new Map<string, { key: Tuple; acc: OpResult }>();
  return {
    next: tup => {
      const gkey = groupFn(tup);
      const kstr = tupleKey(gkey);
      if (table.has(kstr)) {
        const rec = table.get(kstr)!;
        rec.acc = reduceFn(rec.acc, tup);
      } else {
        table.set(kstr, { key: gkey, acc: reduceFn({ type: 'Empty' }, tup) });
      }
    },
    reset: baseTup => {
      for (const { key, acc } of table.values()) {
        const union = new Map(baseTup);
        for (const [k,v] of key.entries()) union.set(k, v);
        union.set(outKey, acc);
        nextOp.next(union);
      }
      nextOp.reset(baseTup);
      table.clear();
    }
  };
}

/** keep only specified keys */
export function filterGroups(
  inclKeys: string[],
  t: Tuple
): Tuple {
  return new Map(
    Array.from(t.entries()).filter(([k]) => inclKeys.includes(k))
  );
}
/** one single group for all */
export function singleGroup(_: Tuple): Tuple {
  return new Map();
}
/** count tuples */
export function counter(acc: OpResult, _: Tuple): OpResult {
  if (acc.type === 'Empty') return { type: 'Int', value: 1 };
  if (acc.type === 'Int')   return { type: 'Int', value: acc.value + 1 };
  return acc;
}
/** sum integer field */
export function sumInts(
  searchKey: string,
  initVal: OpResult,
  tup: Tuple
): OpResult {
  if (initVal.type === 'Empty') return { type: 'Int', value: 0 };
  if (initVal.type === 'Int') {
    const found = tup.get(searchKey);
    if (!found || found.type !== 'Int') {
      throw new Error(`sumInts: no Int at ${searchKey}`);
    }
    return { type: 'Int', value: initVal.value + found.value };
  }
  return initVal;
}

/**
 * like groupBy but just de-duplicates: on reset emit each distinct key once
 */
export function distinct(
  groupFn: (t: Tuple) => Tuple,
  nextOp: Operator
): Operator {
  const seen = new Map<string, Tuple>();
  return {
    next: tup => {
      const g = groupFn(tup);
      seen.set(tupleKey(g), g);
    },
    reset: baseTup => {
      for (const g of seen.values()) {
        const union = new Map(baseTup);
        for (const [k,v] of g.entries()) union.set(k, v);
        nextOp.next(union);
      }
      nextOp.reset(baseTup);
      seen.clear();
    }
  };
}

/** send every tuple to both sides */
export function split(l: Operator, r: Operator): Operator {
  return {
    next: tup => { l.next(tup); r.next(tup); },
    reset: tup => { l.reset(tup); r.reset(tup); }
  };
}

/**
 * join: emit matched pairs when both sides have same groupKey+eid
 * extractor: Tuple→[groupKeyTuple, payloadTuple]
 */
export function join(
  leftExtractor:  (t: Tuple) => [Tuple, Tuple],
  rightExtractor: (t: Tuple) => [Tuple, Tuple],
  nextOp: Operator,
  eidKey: string = 'eid'
): [Operator, Operator] {
  const tblL = new Map<string, Tuple>();
  const tblR = new Map<string, Tuple>();
  let epochL = 0, epochR = 0;

  function makeSide(
    mine: Map<string,Tuple>,
    theirs: Map<string,Tuple>,
    epochRef: { val: number },
    otherEpochRef: { val: number },
    extractor: (t: Tuple) => [Tuple, Tuple]
  ): Operator {
    return {
      next: tup => {
        const [k, vals] = extractor(tup);
        const curE = getMappedInt(eidKey, tup);
        // catch up resets
        while (curE > epochRef.val) {
          if (otherEpochRef.val > epochRef.val) {
            nextOp.reset(new Map([[eidKey, { type: 'Int', value: epochRef.val }]]));
          }
          epochRef.val++;
        }
        // key + eid
        const fullKey = withEid(k, eidKey, curE);
        const kstr    = tupleKey(fullKey);

        if (theirs.has(kstr)) {
          const otherVals = theirs.get(kstr)!;
          theirs.delete(kstr);
          // merge: key ∪ vals ∪ otherVals
          const merged = new Map(fullKey);
          for (const e of otherVals) merged.set(e[0], e[1]);
          for (const e of vals)       merged.set(e[0], e[1]);
          nextOp.next(merged);
        } else {
          mine.set(kstr, vals);
        }
      },
      reset: tup => {
        const curE = getMappedInt(eidKey, tup);
        while (curE > epochRef.val) {
          if (otherEpochRef.val > epochRef.val) {
            nextOp.reset(new Map([[eidKey, { type: 'Int', value: epochRef.val }]]));
          }
          epochRef.val++;
        }
      }
    };
  }

  const leftOp  = makeSide(tblL, tblR, { val: epochL }, { val: epochR }, leftExtractor);
  const rightOp = makeSide(tblR, tblL, { val: epochR }, { val: epochL }, rightExtractor);
  return [leftOp, rightOp];
}

/** rename selected keys */
export function renameFilteredKeys(
  renames: [string,string][],
  inTup: Tuple
): Tuple {
  const out = new Map<string, OpResult>();
  for (const [oldK, newK] of renames) {
    const v = inTup.get(oldK);
    if (v) out.set(newK, v);
  }
  return out;
}


// -----------------------------------------------------------------------------
// Example query constructors (ident, count_pkts, ...)
//
// The pattern is always: `export function foo(nextOp:Operator):Operator { … }`
// or, when it spawns two parallel branches, returns an array of `Operator`.
// -----------------------------------------------------------------------------

export function ident(nextOp: Operator): Operator {
  return mapOp(
    tup => {
      // drop eth.src and eth.dst
      return new Map(
        Array.from(tup.entries())
          .filter(([k]) => k !== 'eth.src' && k !== 'eth.dst')
      );
    },
    nextOp
  );
}

export function countPkts(nextOp: Operator): Operator {
  return epoch(
    1.0,
    'eid',
    groupBy(singleGroup, counter, 'pkts', nextOp)
  );
}

export function pktsPerSrcDst(nextOp: Operator): Operator {
  return epoch(
    1.0,
    'eid',
    groupBy(
      t => filterGroups(['ipv4.src','ipv4.dst'], t),
      counter,
      'pkts',
      nextOp
    )
  );
}

export function distinctSrcs(nextOp: Operator): Operator {
  return epoch(
    1.0,
    'eid',
    groupBy(
      singleGroup,
      counter,
      'srcs',
      distinct(t => filterGroups(['ipv4.src'], t), nextOp)
    )
  );
}

// … you can continue translating the rest of the "Sonata 1–8" and
// join_test, q3, q4, exactly following the OCaml logic above …

// -----------------------------------------------------------------------------
// Main harness
// -----------------------------------------------------------------------------



// Sonata 1
export function tcpNewCons(nextOp: Operator): Operator {
    const threshold = 40;
    // epoch → filter proto&SYN → groupBy dst → filter count ≥ threshold → nextOp
    const f1 = filterOp(
      tup => getMappedInt('ipv4.proto', tup) === 6 &&
             getMappedInt('l4.flags', tup) === 2,
      groupBy(
        t => filterGroups(['ipv4.dst'], t),
        counter,
        'cons',
        filterOp(
          tup => keyGeqInt('cons', threshold, tup),
          nextOp
        )
      )
    );
    return epoch(1.0, 'eid', f1);
  }
  
  // Sonata 2
  export function sshBruteForce(nextOp: Operator): Operator {
    const threshold = 40;
    // epoch → filter proto & dport=22 → dedup(src,dst,len) → groupBy (dst,len) → filter count ≥ threshold → nextOp
    const f1 = filterOp(
      tup => getMappedInt('ipv4.proto', tup) === 6 &&
             getMappedInt('l4.dport', tup) === 22,
      distinct(
        t => filterGroups(['ipv4.src','ipv4.dst','ipv4.len'], t),
        groupBy(
          t => filterGroups(['ipv4.dst','ipv4.len'], t),
          counter,
          'srcs',
          filterOp(
            tup => keyGeqInt('srcs', threshold, tup),
            nextOp
          )
        )
      )
    );
    return epoch(1.0, 'eid', f1);
  }
  
  // Sonata 3
  export function superSpreader(nextOp: Operator): Operator {
    const threshold = 40;
    // epoch → dedup(src,dst) → groupBy src → filter count ≥ threshold → nextOp
    const f1 = distinct(
      t => filterGroups(['ipv4.src','ipv4.dst'], t),
      groupBy(
        t => filterGroups(['ipv4.src'], t),
        counter,
        'dsts',
        filterOp(
          tup => keyGeqInt('dsts', threshold, tup),
          nextOp
        )
      )
    );
    return epoch(1.0, 'eid', f1);
  }
  
  // Sonata 4
  export function portScan(nextOp: Operator): Operator {
    const threshold = 40;
    // epoch → dedup(src,dport) → groupBy src → filter count ≥ threshold → nextOp
    const f1 = distinct(
      t => filterGroups(['ipv4.src','l4.dport'], t),
      groupBy(
        t => filterGroups(['ipv4.src'], t),
        counter,
        'ports',
        filterOp(
          tup => keyGeqInt('ports', threshold, tup),
          nextOp
        )
      )
    );
    return epoch(1.0, 'eid', f1);
  }
  
  // Sonata 5
  export function ddos(nextOp: Operator): Operator {
    const threshold = 45;
    // epoch → dedup(src,dst) → groupBy dst → filter count ≥ threshold → nextOp
    const f1 = distinct(
      t => filterGroups(['ipv4.src','ipv4.dst'], t),
      groupBy(
        t => filterGroups(['ipv4.dst'], t),
        counter,
        'srcs',
        filterOp(
          tup => keyGeqInt('srcs', threshold, tup),
          nextOp
        )
      )
    );
    return epoch(1.0, 'eid', f1);
  }
  
  // Sonata 6
  export function synFloodSonata(nextOp: Operator): Operator[] {
    const threshold = 3;
    const dur = 1.0;
  
    function synsOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 getMappedInt('l4.flags', tup) === 2,
          groupBy(t => filterGroups(['ipv4.dst'], t), counter, 'syns', nxt)
        )
      );
    }
    function synacksOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 getMappedInt('l4.flags', tup) === 18,
          groupBy(t => filterGroups(['ipv4.src'], t), counter, 'synacks', nxt)
        )
      );
    }
    function acksOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 getMappedInt('l4.flags', tup) === 16,
          groupBy(t => filterGroups(['ipv4.dst'], t), counter, 'acks', nxt)
        )
      );
    }
  
    // first join: syns+synacks  ⟷  acks
    const [joinA, joinB] = join(
      tup => [ filterGroups(['host'], tup), filterGroups(['syns+synacks'], tup) ],
      tup => [ renameFilteredKeys([['ipv4.dst','host']], tup), filterGroups(['acks'], tup) ],
      mapOp(
        tup => {
          const diff = getMappedInt('syns+synacks', tup) - getMappedInt('acks', tup);
          const t2 = new Map(tup);
          t2.set('syns+synacks-acks', { type:'Int', value: diff });
          return t2;
        },
        filterOp(tup => keyGeqInt('syns+synacks-acks', threshold, tup), nextOp)
      )
    );
  
    // second join: syns  ⟷  synacks → joinA
    const [joinC, joinD] = join(
      tup => [ renameFilteredKeys([['ipv4.dst','host']], tup), filterGroups(['syns'], tup) ],
      tup => [ renameFilteredKeys([['ipv4.src','host']], tup), filterGroups(['synacks'], tup) ],
      joinA
    );
  
    return [
      synsOp(joinC),
      synacksOp(joinD),
      acksOp(joinB)
    ];
  }
  
  // Sonata 7
  export function completedFlows(nextOp: Operator): Operator[] {
    const threshold = 1;
    const dur = 30.0;
  
    function synsOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 getMappedInt('l4.flags', tup) === 2,
          groupBy(t => filterGroups(['ipv4.dst'], t), counter, 'syns', nxt)
        )
      );
    }
    function finsOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 ((getMappedInt('l4.flags', tup) & 1) === 1),
          groupBy(t => filterGroups(['ipv4.src'], t), counter, 'fins', nxt)
        )
      );
    }
  
    const [op1, op2] = join(
      tup => [ renameFilteredKeys([['ipv4.dst','host']], tup), filterGroups(['syns'], tup) ],
      tup => [ renameFilteredKeys([['ipv4.src','host']], tup), filterGroups(['fins'], tup) ],
      mapOp(
        tup => {
          const diff = getMappedInt('syns', tup) - getMappedInt('fins', tup);
          const t2 = new Map(tup);
          t2.set('diff', { type:'Int', value: diff });
          return t2;
        },
        filterOp(tup => keyGeqInt('diff', threshold, tup), nextOp)
      )
    );
  
    return [
      synsOp(op1),
      finsOp(op2)
    ];
  }
  
  // Sonata 8
  export function slowloris(nextOp: Operator): Operator[] {
    const t1 = 5, t2 = 500, t3 = 90;
    const dur = 1.0;
  
    function nConnsOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6,
          distinct(
            t => filterGroups(['ipv4.src','ipv4.dst','l4.sport'], t),
            groupBy(
              t => filterGroups(['ipv4.dst'], t),
              counter,
              'n_conns',
              filterOp(
                tup => getMappedInt('n_conns', tup) >= t1,
                nxt
              )
            )
          )
        )
      );
    }
    function nBytesOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6,
          groupBy(
            t => filterGroups(['ipv4.dst'], t),
            (acc: OpResult, t: Tuple) => sumInts('ipv4.len', acc, t),
            'n_bytes',
            filterOp(
              tup => getMappedInt('n_bytes', tup) >= t2,
              nxt
            )
          )
        )
      );
    }
  
    const [op1, op2] = join(
      tup => [ filterGroups(['ipv4.dst'], tup), filterGroups(['n_conns'], tup) ],
      tup => [ filterGroups(['ipv4.dst'], tup), filterGroups(['n_bytes'], tup) ],
      mapOp(
        tup => {
          const bytesPerConn = Math.floor(
            getMappedInt('n_bytes', tup) / getMappedInt('n_conns', tup)
          );
          const t2 = new Map(tup);
          t2.set('bytes_per_conn', { type:'Int', value: bytesPerConn });
          return t2;
        },
        filterOp(
          tup => getMappedInt('bytes_per_conn', tup) <= t3,
          nextOp
        )
      )
    );
  
    return [
      nConnsOp(op1),
      nBytesOp(op2)
    ];
  }
  
  // join_test
  export function joinTest(nextOp: Operator): Operator[] {
    const dur = 1.0;
    function synsOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 getMappedInt('l4.flags', tup) === 2,
          nxt
        )
      );
    }
    function synacksOp(nxt: Operator): Operator {
      return epoch(
        dur, 'eid',
        filterOp(
          tup => getMappedInt('ipv4.proto', tup) === 6 &&
                 getMappedInt('l4.flags', tup) === 18,
          nxt
        )
      );
    }
  
    const [op1, op2] = join(
      tup => [
        renameFilteredKeys([['ipv4.src','host']], tup),
        renameFilteredKeys([['ipv4.dst','remote']], tup)
      ],
      tup => [
        renameFilteredKeys([['ipv4.dst','host']], tup),
        filterGroups(['time'], tup)
      ],
      nextOp
    );
  
    return [
      synsOp(op1),
      synacksOp(op2)
    ];
  }
  
  // q3
  export function q3(nextOp: Operator): Operator {
    return epoch(
      100.0, 'eid',
      distinct(t => filterGroups(['ipv4.src','ipv4.dst'], t), nextOp)
    );
  }
  
  // q4
  export function q4(nextOp: Operator): Operator {
    return epoch(
      10000.0, 'eid',
      groupBy(t => filterGroups(['ipv4.dst'], t), counter, 'pkts', nextOp)
    );
  }
  

export function runQueries(): void {
  const macSrc = new Uint8Array([0x00,0x11,0x22,0x33,0x44,0x55]);
  const macDst = new Uint8Array([0xAA,0xBB,0xCC,0xDD,0xEE,0xFF]);

  // build 20 test tuples
  const tuples: Tuple[] = Array.from({ length: 20 }, (_, i) => {
    const t = new Map<string,OpResult>();
    t.set('time',        { type:'Float', value: i + 0.0 });
    t.set('eth.src',     { type:'MAC',   value: macSrc });
    t.set('eth.dst',     { type:'MAC',   value: macDst });
    t.set('eth.ethertype',{ type:'Int',   value: 0x0800 });
    t.set('ipv4.hlen',   { type:'Int',   value: 20 });
    t.set('ipv4.proto',  { type:'Int',   value: 6 });
    t.set('ipv4.len',    { type:'Int',   value: 60 });
    t.set('ipv4.src',    { type:'IPv4',  value: '127.0.0.1' });
    t.set('ipv4.dst',    { type:'IPv4',  value: '127.0.0.1' });
    t.set('l4.sport',    { type:'Int',   value: 440 });
    t.set('l4.dport',    { type:'Int',   value: 50000 });
    t.set('l4.flags',    { type:'Int',   value: 10 });
    return t;
  });

  const queries: Operator[] = [
    ident(dumpOperator(false, process.stdout))
  ];

  for (const tup of tuples) {
    for (const q of queries) {
      q.next(tup);
    }
  }
  console.log('Done');
}
