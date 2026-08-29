import { useState, useEffect } from 'react';
export function Fine({ room }: { room: unknown }) {
  const [a, setA] = useState(0);
  useEffect(() => { setA(1); }, []);
  if (!room) return null;
  return <div>{a}</div>;
}
