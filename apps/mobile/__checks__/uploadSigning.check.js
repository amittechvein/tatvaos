// plugins/withUploadSigning.js — the edit that decides which key signs a
// release build. A mistake here is silent until the Play Console refuses the
// file, or worse, until a build goes out signed with the world's debug key.

const { applyUploadSigning } = require('../plugins/withUploadSigning');

// The two blocks exactly as Expo's template writes them (SDK 54, 21 Sept 2026).
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
        }
    }
}`;

test('adds an upload signing config beside debug, reading the key from outside the repo', () => {
  const out = applyUploadSigning(TEMPLATE);
  expect(out).toMatch(/signingConfigs\s*\{\s*debug\s*\{[^}]*\}\s*\/\/ tatvaos-upload-signing[^\n]*\n\s*upload \{/);
  expect(out).toContain("keyAlias 'tatvaos-upload'");
  expect(out).toContain('.tatvaos-signing');
  expect(out).toContain('TATVAOS_SIGNING_DIR');
  // The password is READ from a file at build time; nothing secret is written here.
  expect(out).not.toMatch(/storePassword\s+'(?!android')/);
});

test('release uses the upload key ONLY when asked, and debug otherwise', () => {
  const out = applyUploadSigning(TEMPLATE);
  const release = out.slice(out.indexOf('release {'));
  expect(release).toMatch(/if \(findProperty\('tatvaosUpload'\)\) \{[\s\S]*signingConfig signingConfigs\.upload[\s\S]*\} else \{\s*signingConfig signingConfigs\.debug/);
  // The debug build type is untouched.
  expect(out).toMatch(/debug \{\s*signingConfig signingConfigs\.debug\s*\}/);
});

test('asked for and missing is a build failure that names the folder, not a quiet debug fallback', () => {
  const out = applyUploadSigning(TEMPLATE);
  expect(out).toContain('throw new GradleException("tatvaosUpload was asked for, but there is no upload key.');
  const release = out.slice(out.indexOf('release {'));
  // The throw comes BEFORE the upload config is chosen.
  expect(release.indexOf('throw new GradleException')).toBeLessThan(release.indexOf('signingConfig signingConfigs.upload'));
});

test('applying twice changes nothing (prebuild without --clean edits in place)', () => {
  const once = applyUploadSigning(TEMPLATE);
  expect(applyUploadSigning(once)).toBe(once);
  expect(once.match(/tatvaos-upload-signing/g)).toHaveLength(2);
});

test('a template it does not recognise is refused, not half-edited', () => {
  expect(() => applyUploadSigning('android { buildTypes { release { } } }')).toThrow(/withUploadSigning/);
  const noReleaseDebug = TEMPLATE.replace(/release \{[\s\S]*?signingConfig signingConfigs\.debug/, 'release {');
  expect(() => applyUploadSigning(noReleaseDebug)).toThrow(/withUploadSigning/);
});
