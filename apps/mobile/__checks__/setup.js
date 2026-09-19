const { configure } = require('@testing-library/react-native');
// 15 s, not 4. The Mail list waits on two sequential calls (bootstrap, then the
// folder's messages) and on 18 Sept 2026 it took ~7 s while the full suite ran
// on this laptop — the same test passes in well under a second on its own. A
// flaky check is worse than a slow one: it teaches people to re-run rather than
// read. This costs nothing when a wait succeeds (waitFor returns as soon as the
// condition holds); only a genuine failure now takes longer to report.
configure({ asyncUtilTimeout: 15000 });
// Safe-area insets without a native module.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
