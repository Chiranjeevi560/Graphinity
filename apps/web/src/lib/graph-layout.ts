// Where everything in the living graph sits and how it drifts: pure maths,
// no drawing, so it can be tested and reused by every graph on the site.
//
// Fields become clusters, biggest nearest the middle, placed along a golden-
// angle spiral so they never line up in rows. Each person sits among the
// clusters of the fields they know: someone who knows one field sits inside
// it, someone who knows two sits between them, a bridge. Links join people
// who share a field. Motion is a slow, smooth wander around each resting
// place, and links fade in and out: alive, never busy. docs/GRAPH.md.

export interface GraphField { slug: string; name: string; members: number }
export interface GraphData {
  /** Everyone with a profile, once. */
  members: number;
  fields: GraphField[];
  /** Each person as positions in `fields`. */
  people: number[][];
  activity: { lastDay: { questions: number; answers: number }; recent: Array<{ field: number; kind: 'question' | 'answer' }> };
}

export interface Cluster { x: number; y: number; r: number; members: number }
export interface GraphNode {
  /** Resting place. */
  x: number;
  y: number;
  fields: number[];
  /** Wander: how far, how fast, where in the cycle. */
  amp: number;
  speedX: number;
  speedY: number;
  phaseX: number;
  phaseY: number;
  size: number;
  you: boolean;
}
export interface GraphEdge { a: number; b: number; speed: number; phase: number }
export interface Layout { clusters: Cluster[]; nodes: GraphNode[]; edges: GraphEdge[] }

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Links per person, at most, to the nearest people sharing a field. */
const LINKS_PER_NODE = 2;

/** A small seeded random generator, so a layout is the same every time for the same data. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lays out the graph in a width × height box (CSS pixels). `you`, when
 * given, adds the viewer as one more node in their fields, drawn brighter.
 */
export function layout(data: Pick<GraphData, 'fields' | 'people'>, width: number, height: number, options: { you?: number[]; seed?: number } = {}): Layout {
  const random = seededRandom(options.seed ?? 1);
  const cx = width / 2;
  const cy = height / 2;
  const short = Math.min(width, height);
  const allMembers = Math.max(1, data.fields.reduce((sum, f) => sum + f.members, 0));

  // Biggest fields nearest the middle. Only fields with someone in them take
  // a place, so a young graph sits centred instead of where empty fields left room.
  const order = data.fields.map((f, i) => ({ i, members: f.members })).filter(f => f.members > 0).sort((a, b) => b.members - a.members || a.i - b.i);
  const clusters: Cluster[] = data.fields.map(() => ({ x: cx, y: cy, r: 0, members: 0 }));
  order.forEach(({ i, members }, rank) => {
    // The biggest exactly in the middle; the rest spiral outwards to the edge.
    const spread = order.length > 1 ? Math.sqrt(rank / (order.length - 1)) : 0;
    const angle = rank * GOLDEN_ANGLE;
    clusters[i] = {
      x: cx + Math.cos(angle) * spread * width * 0.4,
      y: cy + Math.sin(angle) * spread * height * 0.38,
      // Area in proportion to the field's share of everyone: one big field
      // fills the space, many fields share it. Never smaller than a few dots.
      r: short * Math.max(0.05, 0.42 * Math.sqrt(members / allMembers)),
      members,
    };
  });

  const people = options.you ? [...data.people, options.you] : data.people;
  const nodes: GraphNode[] = [];
  people.forEach((fields, index) => {
    const known = fields.filter(f => clusters[f] !== undefined);
    if (known.length === 0) return;
    const centre = known.reduce((sum, f) => {
      const c = clusters[f] as Cluster;
      return { x: sum.x + c.x / known.length, y: sum.y + c.y / known.length };
    }, { x: 0, y: 0 });
    // Denser towards the middle, thinning out at the edge, like a real
    // cluster; tighter for people between clusters.
    const home = clusters[known[0] as number] as Cluster;
    const spreadOut = Math.min(1.15, Math.sqrt(-2 * Math.log(1 - random() * 0.97)) * 0.45);
    const radius = home.r * (known.length === 1 ? 1 : 0.55) * spreadOut;
    const angle = random() * Math.PI * 2;
    const you = options.you !== undefined && index === people.length - 1;
    nodes.push({
      x: clamp(centre.x + Math.cos(angle) * radius, 8, width - 8),
      y: clamp(centre.y + Math.sin(angle) * radius, 8, height - 8),
      fields: known,
      amp: 2 + random() * 5,
      // One wander every 18 to 40 seconds: noticed, not watched.
      speedX: (Math.PI * 2) / (18 + random() * 22),
      speedY: (Math.PI * 2) / (18 + random() * 22),
      phaseX: random() * Math.PI * 2,
      phaseY: random() * Math.PI * 2,
      size: you ? 5 : 1.6 + random() * 1.4 + (known.length > 1 ? 0.6 : 0),
      you,
    });
  });

  // Each person links to their nearest people in each shared field.
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  nodes.forEach((n, a) => {
    for (const f of n.fields) {
      const near = nodes
        .map((m, b) => ({ b, d: (m.x - n.x) ** 2 + (m.y - n.y) ** 2, shares: b !== a && m.fields.includes(f) }))
        .filter(m => m.shares)
        .sort((p, q) => p.d - q.d)
        .slice(0, LINKS_PER_NODE);
      for (const { b } of near) {
        const key = a < b ? `${String(a)}-${String(b)}` : `${String(b)}-${String(a)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ a, b, speed: (Math.PI * 2) / (12 + random() * 20), phase: random() * Math.PI * 2 });
      }
    }
  });
  return { clusters, nodes, edges };
}

/** Where a node is at time t (seconds): a slow, smooth wander around its resting place. */
export function nodeAt(node: GraphNode, t: number): { x: number; y: number } {
  return {
    x: node.x + Math.sin(t * node.speedX + node.phaseX) * node.amp,
    y: node.y + Math.cos(t * node.speedY + node.phaseY) * node.amp,
  };
}

/**
 * How visible a link is at time t, 0 to 1: each fades in and out on its own
 * slow cycle and rests unseen for part of it, so links appear and disappear.
 */
export function edgeAt(edge: GraphEdge, t: number): number {
  return Math.max(0, Math.sin(t * edge.speed + edge.phase));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
