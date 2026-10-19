import { useEffect, useRef } from 'react';
import { runCanvas } from '../lib/canvas-loop.ts';
import type { GraphData } from '../lib/graph-layout.ts';
import { livingScene } from '../lib/living-scene.ts';

/**
 * The graph of everyone, drifting: fields as clusters, people as nodes,
 * links fading in and out, and recent real questions and answers lighting
 * up the cluster they happened in. Purely visual: the caption carries the
 * same facts in words.
 */
export function LivingGraph({ data, you, caption }: { data: GraphData; you?: number[] | undefined; caption: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return runCanvas(canvas, livingScene(data, you));
  }, [data, you]);

  return (
    <figure className="living-graph">
      <canvas ref={canvasRef} className="living-graph-canvas" aria-hidden="true" />
      <figcaption className="text-footnote secondary">{caption}</figcaption>
    </figure>
  );
}
