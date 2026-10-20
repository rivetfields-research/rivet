// The existing Rivetfields platform mark; preserve its geometry.
export function RivetMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M8 23V13.5C8 8.25 11.75 5 17 5H23V11H17C15 11 14 12.1 14 14V23H8Z" fill="currentColor" />
      <path d="M18 16H24V22C24 25.3 21.3 28 18 28H12V22H16C17.1 22 18 21.1 18 20V16Z" fill="currentColor" opacity=".42" />
    </svg>
  );
}
