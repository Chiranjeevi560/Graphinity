import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Link } from '../lib/router.ts';
import { SquircleLayers } from './Squircle.tsx';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

export function Button({ variant = 'primary', className, children, type = 'button', ...rest }: Props) {
  return (
    <button type={type} className={`btn btn-${variant} sq-host${className ? ` ${className}` : ''}`} {...rest}>
      <SquircleLayers radius={0.75} focusRing />
      <span className="btn-label">{children}</span>
    </button>
  );
}

/** A link that looks like a button, for navigation (a real <a>, so it opens in a new tab too). */
export function LinkButton({
  to,
  variant = 'primary',
  className,
  children,
}: {
  to: string;
  variant?: 'primary' | 'secondary';
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className={`btn btn-${variant} sq-host link-button${className ? ` ${className}` : ''}`}>
      <SquircleLayers radius={0.75} focusRing />
      <span className="btn-label">{children}</span>
    </Link>
  );
}
