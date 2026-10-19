import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { runCanvas } from '../lib/canvas-loop.ts';
import { clustersFor, fieldOrder, type GraphData } from '../lib/graph-layout.ts';
import { fieldLabel, fieldNeighbourhood } from '../lib/graph-words.ts';
import { livingScene } from '../lib/living-scene.ts';

/**
 * The graph of everyone, drifting: fields as clusters, people as nodes,
 * links fading in and out, and recent real questions and answers lighting
 * up the cluster they happened in. The picture is hidden from screen
 * readers; over it sits one button per field, at its cluster (spec §20.1).
 * Tab reaches the biggest field, arrows move between fields by size, and
 * opening one says in words who knows it and where else they reach.
 */
export function LivingGraph({ data, you, caption }: { data: GraphData; you?: number[] | undefined; caption: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const order = fieldOrder(data.fields);
  // Roving focus: one Tab stop, on the field last visited (the biggest at first).
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const detailId = useId();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    return runCanvas(canvas, livingScene(data, you));
  }, [data, you]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
    };
  }, []);

  const clusters = clustersFor(data.fields, size.width, size.height);
  const at = Math.min(current, order.length - 1);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, rank: number) {
    const last = order.length - 1;
    const next = {
      ArrowRight: rank + 1,
      ArrowDown: rank + 1,
      ArrowLeft: rank - 1,
      ArrowUp: rank - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const to = Math.max(0, Math.min(last, next));
    setCurrent(to);
    buttons.current[to]?.focus();
  }

  return (
    <figure className="living-graph">
      <div ref={stageRef} className="living-graph-stage">
        <canvas ref={canvasRef} className="living-graph-canvas" aria-hidden="true" />
        {size.width > 0 && order.length > 0 && (
          <nav aria-label="Fields in the graph" className="graph-nav">
            <ul>
              {order.map((index, rank) => {
                const field = data.fields[index];
                const c = clusters[index];
                if (!field || !c) return null;
                return (
                  <li key={field.slug}>
                    <button
                      ref={el => {
                        buttons.current[rank] = el;
                      }}
                      type="button"
                      className="graph-node"
                      tabIndex={rank === at ? 0 : -1}
                      aria-expanded={open === index}
                      aria-controls={detailId}
                      style={
                        {
                          left: `${String(c.x)}px`,
                          top: `${String(c.y)}px`,
                          '--node-size': `${String(c.r * 2)}px`,
                        } as CSSProperties
                      }
                      onFocus={() => {
                        setCurrent(rank);
                      }}
                      onClick={() => {
                        setOpen(open === index ? null : index);
                      }}
                      onKeyDown={e => {
                        onKeyDown(e, rank);
                      }}
                    >
                      <span className="visually-hidden">{fieldLabel(field)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
      <figcaption className="text-footnote secondary">{caption}</figcaption>
      <p id={detailId} className="text-footnote graph-detail" aria-live="polite">
        {open === null ? '' : fieldNeighbourhood(data, open)}
      </p>
    </figure>
  );
}
