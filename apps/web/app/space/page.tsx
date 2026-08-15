import { redirect } from 'next/navigation';

/** /space is nobody's destination — the personal root is. */
export default function SpaceIndex() {
  redirect('/space/personal');
}
