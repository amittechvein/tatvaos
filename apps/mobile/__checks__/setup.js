const { configure } = require('@testing-library/react-native');
configure({ asyncUtilTimeout: 4000 });
// Safe-area insets without a native module.
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
