import React from "react";
import { SvgXml } from "react-native-svg";
import { icons, IconName } from "./icons";

/** One of the design's icons. Line icons take `color` (they draw in currentColor). */
export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color?: string }) {
  return <SvgXml xml={icons[name]} width={size} height={size} color={color} />;
}
