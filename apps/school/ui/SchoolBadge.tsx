import React, { useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import type { School } from "@/core/api";
import { Text } from "./Text";
import { colors } from "./theme";

/** Initials of a school name: "Demo Public School" → "DPS". */
export function initials(name: string) {
  // "A.A.M. Children's Academy" → "AAM": dots split letters, an apostrophe does not
  const words = name.replace(/['’]/g, "").replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return (words.slice(0, 3).map((w) => w[0]).join("") || name.slice(0, 2)).toUpperCase();
}

/**
 * The school's logo, or its initials on navy when it has none or the logo fails to load. Logo
 * links are short-lived signed links, so they are loaded as given and never stored for later.
 */
export function SchoolBadge({ school, size = 44, radius }: { school: Pick<School, "name" | "logoUrl">; size?: number; radius?: number }) {
  const [failed, setFailed] = useState(false);
  const r = radius ?? Math.round(size * 0.3);
  if (school.logoUrl && !failed) {
    return (
      <Image
        source={{ uri: school.logoUrl }}
        onError={() => setFailed(true)}
        contentFit="contain"
        accessibilityIgnoresInvertColors
        style={{ width: size, height: size, borderRadius: r, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line }}
      />
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: r, backgroundColor: colors.navy, alignItems: "center", justifyContent: "center" }}>
      <Text size={Math.round(size * 0.28)} weight={800} color={colors.white}>
        {initials(school.name)}
      </Text>
    </View>
  );
}
