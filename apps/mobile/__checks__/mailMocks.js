// Steerable fakes for the Mail screens: the API client, and the four native
// modules those screens use. Same rule as mocks.js — every fake here is a
// claim about how the real thing behaves, and the ones that came from reading
// the API rather than guessing say so.

const mailApi = {
  bootstrap: null, listMessages: null, searchMessages: null, getMessage: null,
  setRead: null, setFlag: null, deleteMessage: null, send: null,
};

jest.mock('../lib/mail', () => {
  const real = jest.requireActual('../lib/mail');
  return {
    ...real,   // the pure helpers stay real: a screen test should not pass
               // against a fake whenLabel while the real one is wrong
    bootstrap: (...a) => mailApi.bootstrap(...a),
    listMessages: (...a) => mailApi.listMessages(...a),
    searchMessages: (...a) => mailApi.searchMessages(...a),
    getMessage: (...a) => mailApi.getMessage(...a),
    setRead: (...a) => mailApi.setRead(...a),
    setFlag: (...a) => mailApi.setFlag(...a),
    deleteMessage: (...a) => mailApi.deleteMessage(...a),
    send: (...a) => mailApi.send(...a),
  };
});

// The WebView renders nothing here; what matters in a check is the document it
// was HANDED and the props it was given (JavaScript off, navigation intercepted).
const webview = { lastProps: null };
jest.mock('react-native-webview', () => ({
  WebView: (props) => { webview.lastProps = props; return null; },
}));

const picker = { next: { canceled: true } };
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(async () => picker.next),
}));

const files = { downloads: [], written: [], created: [], grant: { granted: true, directoryUri: 'content://tree/downloads' } };
// The path the SCREEN imports. Mocking 'expo-file-system' instead was how a
// deprecated download call passed every check and failed on the phone
// (18 Sept 2026) — a fake that offers a method the real module has removed
// proves the fake, not the code.
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64' },
  downloadAsync: jest.fn(async (url, target, opts) => {
    files.downloads.push({ url, target, headers: opts?.headers });
    return { status: 200, uri: target };
  }),
  readAsStringAsync: jest.fn(async () => 'BASE64DATA'),
  writeAsStringAsync: jest.fn(async (uri, data) => { files.written.push({ uri, data }); }),
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: jest.fn(async () => files.grant),
    createFileAsync: jest.fn(async (dir, name) => { files.created.push({ dir, name }); return `${dir}/${name}`; }),
  },
}));

// The keychain, where the chosen folder is remembered between launches.
const keychain = { store: {} };
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k) => keychain.store[k] ?? null),
  setItemAsync: jest.fn(async (k, v) => { keychain.store[k] = v; }),
  deleteItemAsync: jest.fn(async (k) => { delete keychain.store[k]; }),
}));

const sharing = { shared: [] };
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async (uri) => { sharing.shared.push(uri); }),
}));

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

// Alert.alert and Linking.openURL, spied on the SAME objects the screens
// import — react-native's own exports. Mocking the internal module paths
// (Libraries/Alert/Alert) did nothing here: the screens got the real Alert and
// every dialog check failed with an empty list.
const alerts = { calls: [] };
const opened = { urls: [] };
const RN = require('react-native');
beforeEach(() => {
  // Call counts do not reset themselves: the mock factories run once per file,
  // so "asked for a folder once" counted the previous test's call too.
  jest.clearAllMocks();
  jest.spyOn(RN.Alert, 'alert').mockImplementation((title, message, buttons) => {
    alerts.calls.push({ title, message, buttons });
  });
  jest.spyOn(RN.Linking, 'openURL').mockImplementation(async (url) => { opened.urls.push(url); });
});
afterEach(() => { jest.restoreAllMocks(); });

function pressAlertButton(text) {
  const last = alerts.calls[alerts.calls.length - 1];
  const button = last?.buttons?.find((b) => b.text === text);
  if (!button) throw new Error(`No "${text}" button in "${last?.title ?? 'no alert'}"`);
  return button.onPress?.();
}

module.exports = { mailApi, webview, picker, files, sharing, alerts, opened, keychain, pressAlertButton };
