// The design system from SRS section 14 ("Design system" and "Design decisions, 6 Oct 2026").
// Every colour and size used by a screen comes from here.

export const colors = {
  navy: "#1B2363",
  indigo: "#2E31C7",
  saffron: "#F59E0B",
  yellow: "#FCD34D",
  bg: "#F4F6FB",
  card: "#FFFFFF",
  text: "#101828",
  textSoft: "#5D6B82",
  textMid: "#475467",
  line: "#E6EAF2",
  lineSoft: "#EEF1F6",
  disabled: "#D0D5DD",
  present: "#12A26B",
  presentText: "#0B7A50",
  presentBg: "#E8F7F0",
  absent: "#EF476F",
  absentText: "#C0264A",
  leave: "#F59E0B",
  late: "#2F8FE8",
  holiday: "#98A2B3",
  homework: "#6D5DF6",
  notices: "#14A3A0",
  indigoSoft: "#EEECFF",
  white: "#FFFFFF",
  whiteSoft: "rgba(255,255,255,0.72)",
} as const;

export const font = {
  medium: "Manrope_500Medium",
  semibold: "Manrope_600SemiBold",
  bold: "Manrope_700Bold",
  extrabold: "Manrope_800ExtraBold",
} as const;

export const size = {
  side: 16,
  cardRadius: 20,
  button: 54,
  buttonRadius: 16,
  smallButton: 44,
  smallButtonRadius: 12,
  input: 52,
  inputRadius: 14,
  tile: 56,
  tileRadius: 18,
  iconBox: 44,
  iconBoxRadius: 14,
  avatar: 40,
} as const;

// Cards: 0 1px 2px rgba(16,24,40,.06) + 0 12px 28px rgba(16,24,40,.10)
export const cardShadow = {
  shadowColor: "#101828",
  shadowOpacity: 0.08,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 6 },
  elevation: 3,
} as const;
