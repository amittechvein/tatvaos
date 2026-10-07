import React, { useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import { Text } from "./Text";

const tints = [
  ["#F9E3C2", "#8A5A00"],
  ["#DCEFE6", "#1F5E4A"],
  ["#E3E6FB", "#2E31C7"],
  ["#FBE3EA", "#C0264A"],
];

/** The child's photo, or the first letter on a soft colour (the same colour for the same name). */
export function ChildAvatar({ name, photoUrl, size = 40 }: { name: string; photoUrl?: string | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (photoUrl && !failed) {
    return <Image source={{ uri: photoUrl }} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2 }} contentFit="cover" />;
  }
  const [bg, fg] = tints[[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % tints.length];
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center" }}>
      <Text size={Math.round(size * 0.4)} weight={800} color={fg}>
        {(name.trim()[0] ?? "?").toUpperCase()}
      </Text>
    </View>
  );
}
