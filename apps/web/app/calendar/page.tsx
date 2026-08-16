import { redirect } from 'next/navigation';

/** The week is the working default — a day is too narrow, a month too coarse. */
export default function CalendarIndex() {
  redirect('/calendar/week');
}
