import type { ButtonHTMLAttributes } from 'react';
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
