import { useEffect, useRef } from 'react';
import { runCanvas } from '../lib/canvas-loop.ts';
import { routingScene } from '../lib/routing-scene.ts';

interface Props {
  /** People it reached; null: "a few" (under 5); undefined: not sent yet. */
  asked: number | null | undefined;
  answers: number;
  /** Asked from this tab just now: play the first wave's journey. */
  fresh: boolean;
  caption: string;
}

/**
 * The asker's question travelling to the people it was sent to, and each
 * answer coming back. Only what really happens while the page is open is
 * animated: a wave going out, an answer arriving. Coming back later shows
 * the settled picture. A few (under 5) is drawn as the field lighting up,
 * never as single people.
 */
export function RoutingGraph(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  // Read by the drawing loop on each frame, so new numbers never restart it.
  useEffect(() => { latest.current = props; });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return runCanvas(canvas, routingScene(() => latest.current));
  }, []);

  return (
    <figure className="routing-graph">
      <canvas ref={canvasRef} className="routing-graph-canvas" aria-hidden="true" />
      <figcaption className="text-subhead secondary">{props.caption}</figcaption>
    </figure>
  );
}
