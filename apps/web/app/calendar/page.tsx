import { ComingSoon } from '@/components/ComingSoon';

export const metadata = { title: 'TatvaOS Calendar' };

export default function CalendarComingSoon() {
  return (
    <ComingSoon
      product="Calendar"
      blurb="Meetings, shared team calendars, room booking and reminders — with
             invitations that arrive in TatvaOS Mail and attendees drawn from
             your own directory."
    />
  );
}
