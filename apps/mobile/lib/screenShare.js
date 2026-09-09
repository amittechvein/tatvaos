/**
 * Starting and stopping a screen share, and — the reason this file exists —
 * failing VISIBLY when the person refuses consent.
 *
 * Proven on an emulator 9 September 2026 (see docs/onboarding/mobile/WELCOME.md
 * §5). Not yet run on hardware.
 *
 * ---------------------------------------------------------------------------
 *  THIS NEVER THROWS FOR A DENIAL. It returns a result you have to look at.
 *
 *  `login()` in api.js already returns { kind: 'mfa' } or { kind: 'session' }
 *  rather than throwing, for the same reason: the branch that looks like
 *  success and is not must be impossible to walk past. A rejected promise gets
 *  swallowed by a `catch` written for network errors and the person sees
 *  nothing. A `kind` has to be switched on.
 *
 *  Every result also carries `message` — a finished sentence to put on screen.
 *  That is deliberate: "fail visibly" is not satisfied by returning an error
 *  object and hoping each caller writes good wording. The wording lives here,
 *  once, and is the same everywhere.
 * ---------------------------------------------------------------------------
 */

import { PermissionsAndroid, Platform } from 'react-native';
import { registerGlobals } from '@livekit/react-native';
import { mediaDevices } from '@livekit/react-native-webrtc';

import { isRefusal, describeError } from './refusal';

//  At module scope on purpose. It installs the browser-shaped globals the
//  WebRTC stack expects, and if the native module is missing this fails loudly
//  at import rather than quietly at the moment somebody presses the button.
registerGlobals();

const log = (line) => console.log(`[share] ${line}`);

/**
 * Android 13+ will not show the persistent notification without this grant,
 * and without the notification the OS kills the capture a few minutes in. That
 * presents as "the share randomly stopped", so the outcome is logged either
 * way and a refusal does NOT stop us trying — a share that runs for a while is
 * more useful than no share, and the caller is told.
 */
async function askForNotifications() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return true;
  try {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  } catch (e) {
    log(`POST_NOTIFICATIONS request threw: ${describeError(e)}`);
    return false;
  }
}

/**
 * Start a screen share.
 *
 * @param {{ onEnded?: () => void }} [options]
 *   onEnded fires if the capture stops without stopScreenShare being called —
 *   the system taking it away. Without it that is silent, which is the failure
 *   shape this codebase keeps producing.
 *
 * @returns one of:
 *   { kind: 'started',     stream, track, notified, message }
 *   { kind: 'denied',      message }   the person refused consent
 *   { kind: 'unavailable', message }   no screen capture on this platform
 *   { kind: 'failed',      message, detail }  anything else
 */
export async function startScreenShare({ onEnded } = {}) {
  if (Platform.OS !== 'android') {
    // iOS needs a Broadcast Upload Extension, which does not exist yet. Saying
    // so beats a confusing native error.
    log('not attempted: screen sharing is Android-only in this build');
    return {
      kind: 'unavailable',
      message: 'Screen sharing is not available on this device yet.',
    };
  }

  const notified = await askForNotifications();
  log(notified
    ? 'POST_NOTIFICATIONS granted'
    : 'POST_NOTIFICATIONS refused — no persistent notification, so Android may stop the share');

  log('requesting screen capture; the system consent screen is next');

  let stream;
  try {
    stream = await mediaDevices.getDisplayMedia();
  } catch (err) {
    if (isRefusal(err)) {
      log(`refused by the person — ${describeError(err)}`);
      return {
        kind: 'denied',
        message: 'Screen sharing needs your permission. Nothing was shared.',
      };
    }
    log(`failed — ${describeError(err)}`);
    return {
      kind: 'failed',
      message: 'Screen sharing could not start. Nothing was shared.',
      detail: describeError(err),
    };
  }

  const track = stream?.getTracks?.()[0];
  if (!track) {
    // Consent given and nothing to send. Rare, and it would otherwise look
    // like a working share that transmits a blank screen.
    log('granted but no track was returned');
    stream?.getTracks?.().forEach((t) => t.stop());
    return {
      kind: 'failed',
      message: 'Screen sharing started but produced nothing. Nothing was shared.',
      detail: 'no track in the returned stream',
    };
  }

  log(`started — track ${track.id} readyState=${track.readyState}, notification ${notified ? 'shown' : 'NOT shown'}`);

  if (onEnded) {
    try {
      track.addEventListener('ended', () => {
        log('capture ended without a stop call — the system took it');
        onEnded();
      });
    } catch (e) {
      log(`could not watch for the capture ending: ${describeError(e)}`);
    }
  }

  return {
    kind: 'started',
    stream,
    track,
    notified,
    message: notified
      ? 'Your screen is being shared.'
      : 'Your screen is being shared, but notifications are turned off, so Android may stop it.',
  };
}

/** Stop a share started by startScreenShare. Safe to call twice. */
export function stopScreenShare(result) {
  const tracks = result?.stream?.getTracks?.() ?? [];
  if (tracks.length === 0) {
    log('stop called with nothing running');
    return;
  }
  tracks.forEach((t) => t.stop());
  log('stopped');
}
