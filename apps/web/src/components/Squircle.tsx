import { useLayoutEffect, useRef, useState } from 'react';
import { squirclePath } from '../lib/squircle.ts';

interface Props {
  /** Corner radius in rem, so it scales with the person's text size. */
  radius: number;
  /** Draw a hairline along the edge. */
  edge?: boolean;
  /** Draw a focus ring outside the shape when the host has keyboard focus. */
  focusRing?: boolean;
}

/**
 * The background, edge and focus ring of a squircle, drawn behind the
 * contents of its parent (which needs the `sq-host` class).
 *
 * The shape is a clip-path on a background layer rather than on the parent
 * itself, so the focus ring and shadows outside the shape aren't cut off.
 * Before the first measurement the layer has an ordinary border-radius, so
 * the very first paint is already rounded.
 */
export function SquircleLayers({ radius, edge = false, focusRing = false }: Props) {
  const fillRef = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ w: number; h: number; r: number } | null>(null);

  useLayoutEffect(() => {
    const host = fillRef.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // offsetWidth ignores transforms, so a pressed (scaled) button keeps its shape.
      const next = { w: host.offsetWidth, h: host.offsetHeight, r: radius * rootPx };
      setBox(prev => (prev && prev.w === next.w && prev.h === next.h && prev.r === next.r ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => { observer.disconnect(); };
  }, [radius]);

  const path = box ? squirclePath(box.w, box.h, box.r) : '';

  useLayoutEffect(() => {
    // Set through the style object (CSSOM), which the Content-Security-Policy
    // allows; an inline style attribute would be blocked.
    if (fillRef.current) fillRef.current.style.clipPath = path ? `path('${path}')` : '';
  }, [path]);

  return (
    <>
      <span ref={fillRef} className="sq-fill" aria-hidden="true" />
      {box && edge && (
        <svg className="sq-edge" aria-hidden="true" focusable="false">
          <path d={path} />
        </svg>
      )}
      {box && focusRing && (
        <svg className="sq-ring" aria-hidden="true" focusable="false">
          <path d={squirclePath(box.w + 6, box.h + 6, box.r + 3)} />
        </svg>
      )}
    </>
  );
}
