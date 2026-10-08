// The TatvaOS School logo from the brand kit, drawn with react-native-svg at its own proportions.
// Kit rules: "-color" only on white or very light backgrounds, "-ondark" on navy; never stretched
// or recoloured; at least 120 px wide for the horizontal logo and 96 px for the vertical one.
import React from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { brand, BrandLogo as Name } from "./brand";

const MIN_WIDTH: Record<Name, number> = { horizontalColor: 120, horizontalOndark: 120, verticalColor: 96, verticalOndark: 96 };

export function BrandLogo({ name, width }: { name: Name; width: number }) {
  const w = Math.max(width, MIN_WIDTH[name]);
  const h = Math.round(w / brand[name].ratio);
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="TatvaOS School" style={{ width: w, height: h }}>
      <SvgXml xml={brand[name].xml} width={w} height={h} />
    </View>
  );
}
