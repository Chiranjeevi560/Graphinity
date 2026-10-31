// A trust network that a crowd of fake accounts can't inflate (Levien's Advogato;
// master charter §4.4). Trust flows from moderator seeds through endorsements. Each
// node may pass on a capacity falling with hop distance, so by the max-flow min-cut
// theorem all trust reaching a Sybil clique is bounded by the capacity of the
// few real accounts endorsing it, however many fakes there are. Dinic, O(V²E) worst
// case and near-linear on these unit-like graphs.
import { at } from '../ml/num.ts';

export interface FlowEdge {
  to: number;
  capacity: number;
  reverse: number;
}

export class Dinic {
  readonly graph: FlowEdge[][];
  private level: Int32Array;
  private iter: Int32Array;
  constructor(nodes: number) {
    this.graph = Array.from({ length: nodes }, () => []);
    this.level = new Int32Array(nodes);
    this.iter = new Int32Array(nodes);
  }
  addEdge(from: number, to: number, capacity: number): void {
    const a = this.graph[from];
    const b = this.graph[to];
    if (!a || !b) throw new RangeError('no such node');
    a.push({ to, capacity, reverse: b.length });
    b.push({ to: from, capacity: 0, reverse: a.length - 1 });
  }
  private bfs(s: number, t: number): boolean {
    this.level.fill(-1);
    this.level[s] = 0;
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const v = at(queue, head);
      for (const e of this.graph[v] ?? [])
        if (e.capacity > 1e-9 && at(this.level, e.to) < 0) {
          this.level[e.to] = at(this.level, v) + 1;
          queue.push(e.to);
        }
    }
    return (this.level[t] ?? -1) >= 0;
  }
  private dfs(v: number, t: number, pushed: number): number {
    if (v === t) return pushed;
    const edges = this.graph[v] ?? [];
    for (; at(this.iter, v) < edges.length; this.iter[v] = at(this.iter, v) + 1) {
      const e = edges[at(this.iter, v)];
      if (!e || e.capacity <= 1e-9 || at(this.level, e.to) !== at(this.level, v) + 1) continue;
      const got = this.dfs(e.to, t, Math.min(pushed, e.capacity));
      if (got > 1e-9) {
        e.capacity -= got;
        const back = this.graph[e.to]?.[e.reverse];
        if (back) back.capacity += got;
        return got;
      }
    }
    return 0;
  }
  maxFlow(s: number, t: number): number {
    let flow = 0;
    while (this.bfs(s, t)) {
      this.iter.fill(0);
      for (;;) {
        const f = this.dfs(s, t, Infinity);
        if (f <= 1e-9) break;
        flow += f;
      }
    }
    return flow;
  }
}

export const C0 = 800;
export const DECAY = 4;
export const capacityAt = (distance: number) => Math.max(1, C0 / DECAY ** distance);

/**
 * The trust reaching `targets` from `seeds`. Each node splits into in → out with its
 * hop's capacity; endorsements run out → in, unbounded, so only node capacities cut.
 */
export function trustInto(
  nodes: number,
  endorsements: ReadonlyArray<readonly [number, number]>,
  seeds: readonly number[],
  targets: readonly number[],
): number {
  const adj: number[][] = Array.from({ length: nodes }, () => []);
  for (const [a, b] of endorsements) adj[a]?.push(b);
  const distance = new Int32Array(nodes).fill(-1);
  const queue = [...seeds];
  for (const s of seeds) distance[s] = 0;
  for (let head = 0; head < queue.length; head++) {
    const v = at(queue, head);
    for (const u of adj[v] ?? [])
      if (at(distance, u) < 0) {
        distance[u] = at(distance, v) + 1;
        queue.push(u);
      }
  }
  const source = 2 * nodes;
  const sink = 2 * nodes + 1;
  const flow = new Dinic(2 * nodes + 2);
  for (let v = 0; v < nodes; v++) {
    const d = distance[v] ?? -1;
    if (d >= 0) flow.addEdge(2 * v, 2 * v + 1, capacityAt(d));
  }
  for (const [a, b] of endorsements) flow.addEdge(2 * a + 1, 2 * b, Infinity);
  for (const s of seeds) flow.addEdge(source, 2 * s, Infinity);
  for (const t of targets) flow.addEdge(2 * t + 1, sink, Infinity);
  return flow.maxFlow(source, sink);
}
