import { useState, useEffect } from 'react';
export function Thing({ room }: { room: unknown }) {
  const [a, setA] = useState(0);
  if (!room) return null;
  const [b, setB] = useState(1);
  useEffect(() => { setA(1); setB(2); }, []);
  return <div>{a}{b}</div>;
}
