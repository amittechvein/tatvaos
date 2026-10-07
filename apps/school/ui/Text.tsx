import React from "react";
import { Text as RNText, TextProps, TextStyle } from "react-native";
import { useT } from "@/core/i18n";
import { colors, font } from "./theme";

type Weight = 500 | 600 | 700 | 800;
const manrope: Record<Weight, string> = { 500: font.medium, 600: font.semibold, 700: font.bold, 800: font.extrabold };

/**
 * All app text. English uses Manrope; Hindi, Bengali and Punjabi use the phone's own Noto fonts
 * (Manrope has no Indic letters), at the matching weight. Text scales with the phone's font size
 * (NF-11), capped so layouts still hold at the largest setting.
 */
export function Text({ size = 14, weight = 600, color = colors.text, style, ...rest }: TextProps & { size?: number; weight?: Weight; color?: string }) {
  const { lang } = useT();
  const family: TextStyle = lang === "en" ? { fontFamily: manrope[weight] } : { fontWeight: String(weight) as TextStyle["fontWeight"] };
  return <RNText maxFontSizeMultiplier={1.6} {...rest} style={[{ fontSize: size, color }, family, style]} />;
}
