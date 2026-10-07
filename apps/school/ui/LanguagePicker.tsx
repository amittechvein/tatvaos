import React from "react";
import { Modal, Pressable, View } from "react-native";
import { useT } from "@/core/i18n";
import { LANGS, strings } from "@/core/strings";
import { Text } from "./Text";
import { colors } from "./theme";

/** English, Hindi, Bengali, Punjabi (FR-C10, NF-10). Each name is shown in its own script. */
export function LanguagePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, setLang, t } = useT();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityRole="button" accessibilityLabel={t("cancel")} onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(16,24,40,0.45)", justifyContent: "flex-end" }}>
        <Pressable style={{ backgroundColor: colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 16, paddingBottom: 32, gap: 10 }}>
          <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: colors.disabled, alignSelf: "center", marginBottom: 6 }} />
          <Text size={20} weight={800} style={{ paddingHorizontal: 4 }}>
            {t("chooseLanguage")}
          </Text>
          {LANGS.map((l) => (
            <Pressable
              key={l}
              accessibilityRole="radio"
              accessibilityState={{ selected: l === lang }}
              onPress={() => {
                setLang(l);
                onClose();
              }}
              style={{ minHeight: 54, borderRadius: 16, borderWidth: l === lang ? 2 : 1, borderColor: l === lang ? colors.indigo : colors.line, paddingHorizontal: 16, justifyContent: "center" }}
            >
              <Text size={16} weight={700}>
                {strings[l].language}
              </Text>
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
