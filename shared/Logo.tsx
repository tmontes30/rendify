/** Logo de Rendiciones (mismo ícono que el favicon de la web). */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id="rendiciones-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b84ff" />
          <stop offset="1" stopColor="#2a4fd6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#rendiciones-logo)" />
      <path d="M9 10h14M9 16h14M9 22h8" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
