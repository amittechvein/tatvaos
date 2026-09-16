/**
 * Load the meeting the dashboard card should show, and keep it current.
 *
 * States, each distinct on purpose:
 *   loading  first answer not back yet
 *   ready    answered; `meeting` is the one to show, or null for "nothing"
 *   failed   could not ask — NOT the same as nothing scheduled, and the card
 *            says so (the same distinction screens/Meetings.js draws)
 *
 * Refreshes when the dashboard mounts (so coming back from a meeting re-asks)
 * and when the app returns to the foreground: nothing pushes "your meeting
 * started" to the phone yet, and a card left over from this morning is a card
 * that joins the wrong meeting.
 *
 * A refresh keeps the card it already has on screen until the new answer
 * lands, so the card does not flash to a spinner every time the app is opened.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { listMeetings } from '../lib/connect';
import { pickNextMeeting } from '../lib/nextMeeting';

// Never titles, names or tokens — a count and the kind of answer is enough to
// tell "no card because nothing is scheduled" from "no card because the call
// failed", which is the question this log exists to answer.
const log = (line) => console.log(`[home] ${line}`);

export function useNextMeeting(token) {
  const [state, setState] = useState({ status: 'loading', meeting: null });

  // Each load takes a number; only the latest may write. Without this, a slow
  // answer from before a refresh (or from a session that has since signed out)
  // can land last and overwrite the correct card.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading', meeting: null }));
    try {
      const list = await listMeetings(token, 'upcoming');
      if (mine !== latest.current) return;
      const meeting = pickNextMeeting(list);
      log(`${list.length} upcoming, card: ${meeting ? meeting.status : 'none'}`);
      setState({ status: 'ready', meeting });
    } catch (e) {
      if (mine !== latest.current) return;
      log(`next meeting load failed: ${e?.message ?? e}`);
      setState({ status: 'failed', meeting: null });
    }
  }, [token]);

  useEffect(() => {
    load();
    // Unmounting bumps the counter, so an answer still in flight is dropped.
    return () => { latest.current += 1; };
  }, [load]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => { if (next === 'active') load(); });
    return () => sub.remove();
  }, [load]);

  return { ...state, reload: load };
}
