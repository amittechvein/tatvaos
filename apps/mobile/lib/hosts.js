/**
 * Where the app talks to. One place, so a development build can point at
 * something other than production without editing source.
 *
 * ---------------------------------------------------------------------------
 *  WHY THIS FILE EXISTS AT ALL.
 *
 *  The hosts used to be literals in two files: `API_BASE` in api.js, and a URL
 *  on every row of the product table in theme.js. Changing "the host" meant
 *  changing six strings in two places and hoping. The welcome document listed
 *  this as a small job on api.js; it was not, because theme.js was the half
 *  nobody had counted.
 *
 *  The values live in app.json under `expo.extra.hosts`, which is the source
 *  of truth and is visible in the config rather than buried in code.
 *
 *  ⚠ NOT YET ESTABLISHED, and worth knowing before you chase a ghost: whether
 *  editing app.json is enough on its own. Gradle has a `createExpoConfig` task,
 *  so the config is embedded at BUILD time; whether a development build reads
 *  the embedded copy or the one Metro serves has not been tested here. If you
 *  change a host and the app ignores you, rebuild before assuming this file is
 *  broken — and then write down which it was, because that answer belongs in
 *  the welcome document.
 *
 *  The fallbacks below are production, deliberately. A missing config should
 *  leave the app working against the real thing rather than crashing or
 *  silently pointing at nothing.
 * ---------------------------------------------------------------------------
 */

import Constants from 'expo-constants';

const PRODUCTION = {
  core:     'https://core.tatvaos.com',
  mail:     'https://mail.tatvaos.com',
  connect:  'https://connect.tatvaos.com',
  space:    'https://space.tatvaos.com',
  calendar: 'https://calendar.tatvaos.com',
};

const configured = Constants?.expoConfig?.extra?.hosts ?? {};

/**
 * Per key, not wholesale: overriding `core` alone must not silently drop the
 * other four. A spread would do exactly that and the missing tiles would look
 * like an entitlement problem.
 */
export const hosts = {
  core:     configured.core     || PRODUCTION.core,
  mail:     configured.mail     || PRODUCTION.mail,
  connect:  configured.connect  || PRODUCTION.connect,
  space:    configured.space    || PRODUCTION.space,
  calendar: configured.calendar || PRODUCTION.calendar,
};

/**
 * True when every host is the production default — i.e. nothing was
 * configured, or someone configured production explicitly. Logged once at
 * startup by api.js, because "which server am I actually talking to" is the
 * first question of every confusing bug report, and the answer should not
 * require reading the config.
 */
export const isProduction = Object.keys(PRODUCTION)
  .every((k) => hosts[k] === PRODUCTION[k]);
