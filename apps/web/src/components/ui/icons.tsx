import type { ReactNode } from 'react';

/** The boards' inline icons (24 × 24 stroke icons). */
export function Icon({
  children,
  size = 18,
  stroke = 'currentColor',
  strokeWidth = 2,
  fill = 'none',
  className,
}: {
  children: ReactNode;
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** The icon paths used outside the sidebar (the toast); the sidebar draws its own glyphs. */
export const paths = {
  check: <path d="m5 12 5 5L20 7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />
    </>
  ),
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </>
  ),
} as const;
