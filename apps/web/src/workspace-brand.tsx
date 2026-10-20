import { RivetMark } from './rivet-mark';

export function WorkspaceBrand({ compact = false, size = 23 }: { compact?: boolean; size?: number }) {
  return <><RivetMark size={size}/>{!compact && <span className="brand-word">Rivet</span>}</>;
}
