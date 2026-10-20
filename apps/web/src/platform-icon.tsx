import { Cable } from 'lucide-react';
import './platform-icon.css';

// Brand artwork is outside this source candidate's approved boundary.
export function PlatformIcon({ size = 24 }: { provider: string; size?: number }) {
  return <Cable size={size} aria-hidden="true"/>;
}
