// Files attached to homework or a notice. A signed https link opens in the phone's viewer.
// Without one (homework files today) the app says to open it on the website: it never builds a
// public link itself (SRS section 8, "Files and camera").
import React from "react";
import { Linking, Pressable, View } from "react-native";
import type { Attachment } from "@/core/api";
import { useT } from "@/core/i18n";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { Card } from "./parts";
import { colors } from "./theme";

export function Attachments({ items }: { items: Attachment[] | undefined }) {
  const { t } = useT();
  if (!items?.length) return null;
  return (
    <Card style={{ gap: 10 }}>
      <Text size={12} weight={800} color={colors.textSoft}>{t("attachmentsTitle").toUpperCase()}</Text>
      {items.map((a, i) => {
        const name = a.name || a.original_name || a.file_name || `File ${i + 1}`;
        const url = a.url && /^https:\/\//.test(a.url) ? a.url : null;
        return (
          <View key={a.id ?? i} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.indigoSoft, alignItems: "center", justifyContent: "center" }}>
              <Icon name="download" size={18} color={colors.indigo} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text size={14} weight={700} numberOfLines={1}>{name}</Text>
              {!url ? <Text size={12} weight={500} color={colors.textSoft}>{t("fileOnWebsite")}</Text> : null}
            </View>
            {url ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`${t("openFile")} ${name}`} onPress={() => Linking.openURL(url)} style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center" }}>
                <Text size={14} weight={800} color={colors.indigo}>{t("openFile")}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </Card>
  );
}
