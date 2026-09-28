// The sign-in screen's Mobile OTP tab.
//
// Amit, 23 Sept 2026: "give option to login with mobile no via otp". The
// screen had no check at all before this; these hold the shape of the flow —
// tab, number, Send code, the code field appearing, Sign in, MFA handed up —
// and the two things a person would notice going wrong: an on-screen test
// code not being shown, and the server's password wording leaking into an
// OTP failure.

jest.mock('../api', () => ({
  login: jest.fn(), verifyMfa: jest.fn(), restore: jest.fn(async () => null),
  signOut: jest.fn(), me: jest.fn(), onSessionChange: jest.fn(() => () => {}),
  requestOtp: jest.fn(), loginWithOtp: jest.fn(),
}));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('../screens/Meeting', () => () => null);
jest.mock('../screens/Meetings', () => () => null);
jest.mock('../screens/GuestJoin', () => () => null);
jest.mock('../screens/ScheduleMeeting', () => () => null);
jest.mock('../screens/Mail', () => () => null);
jest.mock('../screens/MailMessage', () => () => null);
jest.mock('../screens/MailCompose', () => () => null);
jest.mock('../components/NextMeetingCard', () => () => null);
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const api = require('../api');
const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react-native');
const { Login } = require('../App');

const mount = (over = {}) => render(
  <Login onSignedIn={jest.fn()} onChallenge={jest.fn()} onGuest={jest.fn()} {...over} />,
);

beforeEach(() => {
  api.requestOtp.mockReset();
  api.loginWithOtp.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the screen opens on Email, and the OTP tab swaps the form', () => {
  const r = mount();
  expect(r.getByLabelText('Show password')).toBeTruthy();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  expect(r.queryByLabelText('Show password')).toBeNull();
  expect(r.getByLabelText('Mobile number')).toBeTruthy();
  expect(r.getByLabelText('Send code')).toBeTruthy();
});

test('Send code asks the server with the number, then shows the code field and locks the number', async () => {
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: null });
  const r = mount();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+91 98765 43210');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });

  expect(api.requestOtp).toHaveBeenCalledWith('+91 98765 43210');
  expect(r.getByLabelText('6-digit code')).toBeTruthy();
  expect(r.getByText(/6-digit code is on its way/)).toBeTruthy();
  // Locked: the code belongs to this number.
  expect(r.getByLabelText('Mobile number').props.editable).toBe(false);
  // No stray "the SMS did not go out" box when there is no on-screen code.
  expect(r.queryByText(/On-screen codes/)).toBeNull();
});

test('a code the server shows on screen IS shown on screen', async () => {
  // The one test-environment affordance. Hidden, and a tester sits waiting
  // for an SMS that the server already said it did not send.
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: '482913' });
  const r = mount();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+919999900001');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });
  expect(r.getByText(/482913/)).toBeTruthy();
});

test('Sign in is off until six digits; non-digits are dropped', async () => {
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: null });
  const r = mount();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+919999900001');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });

  fireEvent.changeText(r.getByLabelText('6-digit code'), '12a3');
  expect(r.getByLabelText('6-digit code').props.value).toBe('123');
  expect(r.getByLabelText('Sign in with the code').props.accessibilityState?.disabled ?? true).toBe(true);
  fireEvent.changeText(r.getByLabelText('6-digit code'), '1234567');
  expect(r.getByLabelText('6-digit code').props.value).toBe('123456');
});

test('a session signs in; an MFA challenge is handed up, NOT treated as a sign-in', async () => {
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: null });
  const onSignedIn = jest.fn();
  const onChallenge = jest.fn();
  const r = mount({ onSignedIn, onChallenge });
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+919999900001');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });

  api.loginWithOtp.mockResolvedValue({ kind: 'mfa', challenge: 'CH' });
  fireEvent.changeText(r.getByLabelText('6-digit code'), '123456');
  await act(async () => { fireEvent.press(r.getByLabelText('Sign in with the code')); });
  expect(api.loginWithOtp).toHaveBeenCalledWith('+919999900001', '123456');
  expect(onChallenge).toHaveBeenCalledWith('CH');
  expect(onSignedIn).not.toHaveBeenCalled();

  api.loginWithOtp.mockResolvedValue({ kind: 'session', session: { accessToken: 'AT' } });
  await act(async () => { fireEvent.press(r.getByLabelText('Sign in with the code')); });
  expect(onSignedIn).toHaveBeenCalledWith({ accessToken: 'AT' });
});

test('THE PASSWORD SENTENCE DOES NOT LEAK into an OTP failure', async () => {
  // The server answers every refused code with its password wording. Shown
  // as-is, a person who never typed a password is told their password is
  // wrong. Reworded for that exact sentence only.
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: null });
  api.loginWithOtp.mockRejectedValue(new Error('That email address and password combination was not recognised.'));
  const r = mount();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+919999900001');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });
  fireEvent.changeText(r.getByLabelText('6-digit code'), '000000');
  await act(async () => { fireEvent.press(r.getByLabelText('Sign in with the code')); });
  expect(r.queryByText(/password/i)).toBeNull();
  expect(r.getByText(/code was not accepted/)).toBeTruthy();
});

test('any OTHER server sentence is shown as sent', async () => {
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: null });
  api.loginWithOtp.mockRejectedValue(new Error('This organisation is suspended.'));
  const r = mount();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+919999900001');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });
  fireEvent.changeText(r.getByLabelText('6-digit code'), '000000');
  await act(async () => { fireEvent.press(r.getByLabelText('Sign in with the code')); });
  expect(r.getByText('This organisation is suspended.')).toBeTruthy();
});

test('resend counts down from 60 on the phone, since the server never says it throttled', async () => {
  jest.useFakeTimers();
  api.requestOtp.mockResolvedValue({ sent: true, message: 'm', devCode: null });
  const r = mount();
  fireEvent.press(r.getByLabelText('Sign in with mobile OTP'));
  fireEvent.changeText(r.getByLabelText('Mobile number'), '+919999900001');
  await act(async () => { fireEvent.press(r.getByLabelText('Send code')); });
  expect(r.getByText('Resend in 60s')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(59_000); });
  expect(r.getByText('Resend in 1s')).toBeTruthy();
  await act(async () => { jest.advanceTimersByTime(1_000); });
  expect(r.getByText('Resend code')).toBeTruthy();
  jest.useRealTimers();
});

// A client's screenshot, 24 Sept 2026: on a short phone the keyboard sat over
// the password box and there was nothing to scroll. The page must scroll.
test('the sign-in page scrolls, so a keyboard cannot hide the password box', () => {
  const r = mount();
  const page = r.getByLabelText('Sign-in page');
  expect(page.props.keyboardShouldPersistTaps).toBe('handled');
  // The password box is INSIDE the scroller, not beside it.
  const inside = r.getByLabelText('Password');
  let node = inside.parent; let found = false;
  while (node) { if (node === page) { found = true; break; } node = node.parent; }
  expect(found).toBe(true);
});

// Measured on the Samsung, 24 Sept 2026: the keyboard does not shrink the
// window on this edge-to-edge build, so the root must pad itself by the
// keyboard's height (that is what put the login password box, and the
// message screen's reply box, under the keyboard).
test('the app root moves out of the keyboard\'s way by padding, on Android', async () => {
  const App = require('../App').default;
  const r = render(<App />);
  await act(async () => {});
  // The label finds the host view; the behaviour lives on the composite.
  const { KeyboardAvoidingView } = require('react-native');
  const root = r.UNSAFE_getAllByType(KeyboardAvoidingView).find((k) => k.props.accessibilityLabel === 'App');
  expect(root).toBeTruthy();
  expect(root.props.behavior).toBe('padding');
  expect(root.props.enabled).toBe(true);
});
