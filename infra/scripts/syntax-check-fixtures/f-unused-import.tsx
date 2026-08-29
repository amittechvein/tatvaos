import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Kit';
export function Thing() {
  const [a, setA] = useState(0);
  useEffect(() => { setA(1); }, []);
  // Button is mentioned here in a comment, and in a string below, and
  // neither is a use.
  return <div title="Button">{a}</div>;
}
