// The graph of everyone, drifting (docs/GRAPH.md): fields as clusters,
// people as nodes, links fading in and out, and the last day's real
// questions and answers lighting up the cluster they happened in. Drawing
// only: the component mounts it, so it can be tested with a recording canvas.
import type { CanvasScene } from './canvas-loop.ts';
import { edgeAt, layout, nodeAt, type GraphData, type Layout } from './graph-layout.ts';

const PULSE_SECONDS = 1.8;
interface Pulse {
  node: number;
  to: number | null;
  start: number;
}

export function livingScene(data: GraphData, you: number[] | undefined): CanvasScene {
  let graph: Layout = { clusters: [], nodes: [], edges: [] };
  const pulses: Pulse[] = [];
  let nextPulse = 1.2;
  let played = 0;

  // The last day's real activity, oldest first, one at a time: a question
  // lights up someone in its field; an answer travels along a link.
  function addPulse(t: number) {
    const recent = data.activity.recent;
    const event = recent[recent.length - 1 - (played++ % Math.max(1, recent.length))];
    if (!event) return;
    const inField = graph.nodes.flatMap((n, i) => (n.fields.includes(event.field) ? [i] : []));
    const node = inField[Math.floor(Math.random() * inField.length)];
    if (node === undefined) return;
    const link = event.kind === 'answer' ? graph.edges.find(e => e.a === node || e.b === node) : undefined;
    pulses.push({ node, to: link ? (link.a === node ? link.b : link.a) : null, start: t });
  }

  return {
    resize(width, height) {
      graph = layout(data, width, height, you ? { you } : {});
    },
    draw({ ctx, t, colors, still }) {
      if (!still) {
        if (t >= nextPulse) {
          addPulse(t);
          nextPulse = t + 2.4 + Math.random() * 1.6;
        }
        while (pulses[0] && t - pulses[0].start > PULSE_SECONDS) pulses.shift();
      }
      const at = graph.nodes.map(n => (still ? n : nodeAt(n, t)));
      // Links: fading in and out; the viewer's own in the accent colour.
      ctx.lineWidth = 0.75;
      for (const e of graph.edges) {
        const a = at[e.a],
          b = at[e.b];
        if (!a || !b) continue;
        const mine = graph.nodes[e.a]?.you === true || graph.nodes[e.b]?.you === true;
        const alpha = still ? 0.35 : edgeAt(e, t);
        if (alpha <= 0.01) continue;
        ctx.strokeStyle = mine ? colors.accent : colors.ink;
        ctx.globalAlpha = alpha * (mine ? 0.6 : 0.3);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      // People; the viewer brighter, with a soft halo.
      graph.nodes.forEach((n, i) => {
        const p = at[i];
        if (!p) return;
        if (n.you) {
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = colors.accent;
          ctx.beginPath();
          ctx.arc(p.x, p.y, n.size * 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = n.you ? 1 : 0.5;
        ctx.fillStyle = n.you ? colors.accent : colors.ink;
        ctx.beginPath();
        ctx.arc(p.x, p.y, n.size, 0, Math.PI * 2);
        ctx.fill();
      });
      // Activity: a ring that grows and fades; an answer's dot along its link.
      for (const pulse of pulses) {
        const age = t - pulse.start;
        const from = at[pulse.node];
        if (!from) continue;
        const life = Math.min(1, age / PULSE_SECONDS);
        ctx.strokeStyle = colors.accent;
        ctx.fillStyle = colors.accent;
        ctx.globalAlpha = 0.6 * (1 - life);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(from.x, from.y, 3 + life * 14, 0, Math.PI * 2);
        ctx.stroke();
        const to = pulse.to === null ? null : at[pulse.to];
        if (to) {
          const k = Math.min(1, age / (PULSE_SECONDS * 0.7));
          ctx.globalAlpha = 0.9 * (1 - life * 0.6);
          ctx.beginPath();
          ctx.arc(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, 2.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
  };
}
