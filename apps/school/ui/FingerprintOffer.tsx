// "Use fingerprint next time?" — offered once per login after a password sign-in (FR-C05).
// Turning it on asks for the fingerprint once, so it only switches on when it works.
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { setOn, shouldOffer, unlock } from "@/core/biometric";
import { useT } from "@/core/i18n";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { Button } from "./parts";
import { cardShadow, colors, size } from "./theme";

export function FingerprintOffer({ accountId }: { accountId: string }) {
  const { t } = useT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    shouldOffer(accountId).then(setShow).catch(() => setShow(false));
  }, [accountId]);
  if (!show) return null;
  return (
    <View style={[{ marginHorizontal: size.side, marginTop: 16, backgroundColor: colors.white, borderRadius: size.cardRadius, padding: 14, gap: 12 }, cardShadow]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: colors.indigoSoft, alignItems: "center", justifyContent: "center" }}>
          <Icon name="fingerprint" size={22} color={colors.indigo} />
        </View>
        <View style={{ flex: 1 }}>
          <Text size={14} weight={800}>{t("useFingerprint")}</Text>
          <Text size={12} weight={500} color={colors.textSoft}>{t("useFingerprintSub")}</Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button small kind="outline" label={t("notNow")} style={{ flex: 1 }} onPress={async () => { await setOn(accountId, false); setShow(false); }} />
        <Button
          small
          kind="light"
          label={t("turnOn")}
          style={{ flex: 1 }}
          onPress={async () => {
            if (await unlock(t("unlockPrompt"), t("cancel"))) {
              await setOn(accountId, true);
              setShow(false);
            }
          }}
        />
      </View>
    </View>
  );
}
