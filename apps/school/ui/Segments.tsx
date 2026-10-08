// Two or three options side by side (Homework | Assignments).
import React from "react";
import { Pressable, View } from "react-native";
import { Text } from "./Text";
import { colors, size } from "./theme";

export function Segments<K extends string>({ value, options, onChange }: { value: K; options: { key: K; label: string }[]; onChange: (k: K) => void }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", margin: size.side, marginBottom: 0, padding: 4, borderRadius: 14, backgroundColor: colors.lineSoft }}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => !on && onChange(o.key)}
            style={{ flex: 1, minHeight: 44, borderRadius: 11, alignItems: "center", justifyContent: "center", backgroundColor: on ? colors.white : "transparent" }}
          >
            <Text size={14} weight={on ? 800 : 600} color={on ? colors.text : colors.textSoft}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
