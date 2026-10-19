// The asker's question travelling to the people it was sent to, and each
// answer coming back (docs/GRAPH.md). Only what really happens while the
// page is open is animated: a wave going out, an answer arriving; coming
// back later shows the settled picture. "A few" (under 5) is drawn as the
// field lighting up, never as single people. Drawing only: the component
// mounts it, so it can be tested with a recording canvas.
import type { CanvasScene } from './canvas-loop.ts';
import { along, bendFor, MAX_DRAWN, routingLayout, stagger, travel, type RoutingLayout } from './routing-layout.ts';

export interface RoutingInputs {
  /** People it reached; null: "a few" (under 5); undefined: not sent yet. */
  asked: number | null | undefined;
  answers: number;
  /** Asked from this tab just now: play the first wave's journey. */
  fresh: boolean;
}

/** `read` gives the latest numbers on every frame, so new ones never restart the drawing. */
export function routingScene(read: () => RoutingInputs): CanvasScene {
  let size = { width: 0, height: 0 };
  let picture: RoutingLayout = routingLayout(0, 0, 0);
  let drawnFor = -1;
  // Journeys: each person's path, and when it set off (null: already there).
  const departures: Array<number | null> = [];
  const returns: Array<{ from: number; start: number }> = [];
  let answersSeen = read().answers;
  let firstFrame = true;
  // "A few": one journey to the field as a whole, and when it set off.
  let fewLeftAt: number | null | undefined;

  const count = () => Math.min(read().asked ?? 0, MAX_DRAWN);
  const layoutFor = (n: number) => { picture = routingLayout(n, size.width, size.height); drawnFor = n; };

  return {
    resize(width, height) { size = { width, height }; layoutFor(count()); },
    draw({ ctx, t, colors, still }) {
      const { asked, answers, fresh } = read();
      const n = count();
      if (n !== drawnFor) layoutFor(n);
      // New people since the last frame set off now; the first frame's set
      // off only if the question was just asked here.
      const animate = !still && (!firstFrame || fresh);
      while (departures.length < n) departures.push(animate ? t + stagger(n) * departures.length : null);
      if (asked === null && fewLeftAt === undefined) fewLeftAt = animate ? t : null;
      firstFrame = false;
      // Each new answer comes back from someone who was asked.
      if (answers > answersSeen && !still) {
        for (let i = answersSeen; i < answers; i++) returns.push({ from: Math.floor(Math.random() * Math.max(1, n)), start: t + (i - answersSeen) * 0.25 });
      }
      answersSeen = answers;

      const { asker, centre, radius, people } = picture;
      const breathe = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.2);

      // "A few": the field lights up as a whole.
      if (asked === null) {
        const k = fewLeftAt === null || fewLeftAt === undefined ? 1 : travel(t - fewLeftAt);
        // The field lights up as the question arrives.
        const glow = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, radius);
        glow.addColorStop(0, colors.accent);
        glow.addColorStop(1, 'transparent');
        ctx.globalAlpha = 0.5 * k * (still ? 1 : 0.85 + 0.15 * Math.sin(t * 1.3));
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.45;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(asker.x, asker.y);
        for (let s = 1; s <= 24; s++) {
          const q = along(asker, centre, (s / 24) * k, 0.12);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        if (k < 1) {
          const head = along(asker, centre, k, 0.12);
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = colors.accent;
          ctx.beginPath();
          ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Paths, then the people at their ends, lit once reached.
      people.forEach((p, i) => {
        const leftAt = departures[i];
        const k = leftAt === null || leftAt === undefined ? 1 : travel(t - leftAt);
        if (k <= 0) return;
        const bend = bendFor(i);
        ctx.strokeStyle = colors.accent;
        ctx.globalAlpha = 0.14;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        ctx.moveTo(asker.x, asker.y);
        for (let s = 1; s <= 16; s++) {
          const q = along(asker, p, (s / 16) * k, bend);
          ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        if (k < 1) {
          const head = along(asker, p, k, bend);
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = colors.accent;
          ctx.beginPath();
          ctx.arc(head.x, head.y, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
        // Reached people glow, each softly on its own rhythm.
        const glow = still || k < 1 ? 1 : 0.8 + 0.2 * Math.sin(t * 1.6 + i * 1.7);
        ctx.globalAlpha = (0.25 + 0.7 * k) * glow;
        ctx.fillStyle = k >= 1 ? colors.accent : colors.ink;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
      });

      // Answers coming home.
      for (let i = returns.length - 1; i >= 0; i--) {
        const r = returns[i];
        if (!r) continue;
        const k = travel(t - r.start);
        if (k >= 1) { returns.splice(i, 1); continue; }
        if (k <= 0) continue;
        const from = people[r.from] ?? centre;
        const q = along(from, asker, k, -bendFor(r.from));
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // The asker: steady once it's out; breathing while it's being sent.
      ctx.fillStyle = colors.accent;
      ctx.globalAlpha = asked === undefined ? 0.12 + 0.18 * breathe : 0.18;
      ctx.beginPath();
      ctx.arc(asker.x, asker.y, asked === undefined ? 10 + 6 * breathe : 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(asker.x, asker.y, 5, 0, Math.PI * 2);
      ctx.fill();
    },
  };
}
