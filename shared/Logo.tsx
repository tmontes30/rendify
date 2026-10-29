/** Logo de Rendiciones. "admin" = versión gris del panel del owner. */
export function Logo({ size = 32, variant = 'brand' }: { size?: number; variant?: 'brand' | 'admin' }) {
  const [from, to] = variant === 'admin' ? ['#a3abb9', '#5d6677'] : ['#5b84ff', '#2a4fd6'];
  const id = `rendiciones-logo-${variant}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={from} />
          <stop offset="1" stopColor={to} />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <path d="M9 10h14M9 16h14M9 22h8" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
