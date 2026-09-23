/**
 * Signs the Android RELEASE build with TatvaOS's own upload key when asked to,
 * so the file can go to Google Play.
 *
 * ── WHY, 21 SEPTEMBER 2026 ────────────────────────────────────────────────
 *  Amit: "how to upload app on play store". Every release build until then was
 *  signed with Expo's template debug key - storePassword 'android', a key every
 *  Android developer in the world has. Google Play refuses a bundle signed with
 *  it, and anyone could have signed a lookalike with the same key.
 *
 * ── HOW TO USE IT ────────────────────────────────────────────────────────
 *    gradlew bundleRelease -PtatvaosUpload=true ...      the file for Play
 *    gradlew assembleRelease ...                         a phone test build, as before
 *
 *  OPT-IN, on purpose. The phone test builds stay on the debug key, so the app
 *  already on Amit's Samsung can still be updated in place. A signature change
 *  forces an uninstall, which signs the person out - and on 21 Sept the app was
 *  found uninstalled from that phone for a reason nobody had written down.
 *
 * ── WHERE THE KEY LIVES: NOT HERE ────────────────────────────────────────
 *  In a folder outside every checkout, by default ~/.tatvaos-signing, or
 *  wherever TATVAOS_SIGNING_DIR points:
 *      tatvaos-upload.jks         the key (PKCS12, alias tatvaos-upload)
 *      upload-password.txt        its password, one line
 *  apps/mobile/.gitignore already refuses *.keystore and keystore.properties;
 *  .jks is added beside them. Lose the key and Google can reset the upload key
 *  on request (Play App Signing keeps the real signing key), but that takes days.
 *
 *  Asked for and MISSING is a build failure that names the folder, never a
 *  quiet fall back to the debug key: a debug-signed bundle only fails later,
 *  in the Play Console, with a message that does not say why.
 *
 *  Throws if Expo's template stops having the blocks this edits, rather than
 *  producing a build that silently signs with the wrong key.
 */

const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// tatvaos-upload-signing';

const SIGNING = `
        ${MARK}: see plugins/withUploadSigning.js
        upload {
            def tvDir = System.getenv('TATVAOS_SIGNING_DIR') ?: "\${System.getProperty('user.home')}/.tatvaos-signing"
            def tvPass = file("\${tvDir}/upload-password.txt")
            if (tvPass.exists()) {
                storeFile file("\${tvDir}/tatvaos-upload.jks")
                storePassword tvPass.text.trim()
                keyAlias 'tatvaos-upload'
                keyPassword tvPass.text.trim()
            }
        }`;

const RELEASE_LINE = /(release\s*\{[^}]*?)signingConfig signingConfigs\.debug/;

const RELEASE = `$1${MARK}: the upload key only when asked for (-PtatvaosUpload=true)
            if (findProperty('tatvaosUpload')) {
                if (!signingConfigs.upload.storeFile?.exists()) {
                    throw new GradleException("tatvaosUpload was asked for, but there is no upload key. " +
                        "Expected tatvaos-upload.jks and upload-password.txt in " +
                        (System.getenv('TATVAOS_SIGNING_DIR') ?: System.getProperty('user.home') + '/.tatvaos-signing'))
                }
                signingConfig signingConfigs.upload
            } else {
                signingConfig signingConfigs.debug
            }`;

function applyUploadSigning(src) {
  if (src.includes(MARK)) return src; // idempotent: prebuild without --clean
  const debugBlock = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/;
  if (!debugBlock.test(src) || !RELEASE_LINE.test(src)) {
    throw new Error(
      'withUploadSigning: android/app/build.gradle no longer has the `signingConfigs { debug { ... } }` '
      + 'and `release { signingConfig signingConfigs.debug` shapes this plugin edits. Update the plugin; '
      + 'do not ship a release build until it signs with the upload key again.',
    );
  }
  return src.replace(debugBlock, `$1${SIGNING}`).replace(RELEASE_LINE, RELEASE);
}

module.exports = function withUploadSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyUploadSigning(cfg.modResults.contents);
    return cfg;
  });
};
module.exports.applyUploadSigning = applyUploadSigning;
