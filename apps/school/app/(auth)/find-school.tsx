// 1b Find your school (FR-C01). No location access and no "nearby" list: the list stays empty
// until 3 letters are typed. A school code (the school's TatvaOS code, e.g. DEMO) or the school's
// QR link (https://school.tatvaos.com/s/<CODE>) also finds it. The camera is asked for only when
// Scan QR is tapped. The chosen school is saved on the phone at Continue.

import React, { useEffect, useState } from "react";
import { FlatList, Modal, Pressable, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useQuery } from "@tanstack/react-query";
import { CameraView, useCameraPermissions } from "expo-camera";
import { api, ApiError, School } from "@/core/api";
import { useAccounts } from "@/core/accounts";
import { codeFrom } from "@/core/schoolCode";
import { useT } from "@/core/i18n";
import { Icon } from "@/ui/Icon";
import { Text } from "@/ui/Text";
import { SchoolBadge } from "@/ui/SchoolBadge";
import { BackButton, Button, Field, Notice } from "@/ui/parts";
import { colors, size } from "@/ui/theme";

function useDebounced(value: string, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export default function FindSchool() {
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ code?: string }>();
  const { chooseSchool } = useAccounts();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<School | null>(null);
  const [byCode, setByCode] = useState<School | null>(null);
  const [codeOpen, setCodeOpen] = useState(params.code === "1");
  const [scanOpen, setScanOpen] = useState(false);

  const q = useDebounced(query.trim(), 350);
  const search = useQuery({ queryKey: ["schools", q], queryFn: () => api.searchSchools(q), enabled: q.length >= 3 });
  const list = [...(byCode ? [byCode] : []), ...(q.length >= 3 ? (search.data ?? []).filter((s) => s.code !== byCode?.code) : [])];

  const found = (s: School) => {
    setByCode(s);
    setPicked(s);
    setCodeOpen(false);
    setScanOpen(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* white header: dark status bar icons, or they vanish on white */}
      <StatusBar style="dark" />
      <View style={{ backgroundColor: colors.white, paddingTop: insets.top + 12, paddingHorizontal: size.side, paddingBottom: 16, gap: 14, borderBottomWidth: 1, borderBottomColor: colors.line }}>
        <BackButton />
        <View style={{ gap: 4 }}>
          <Text accessibilityRole="header" size={24} weight={800}>
            {t("findSchool")}
          </Text>
          <Text size={14} weight={500} color={colors.textSoft}>
            {t("findSchoolSub")}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: size.input, borderRadius: size.inputRadius, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, backgroundColor: colors.bg }}>
          <Icon name="search" size={20} color={colors.textSoft} />
          <TextInput
            accessibilityLabel={t("searchPlaceholder")}
            placeholder={t("searchPlaceholder")}
            placeholderTextColor="#7A8394"
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            returnKeyType="search"
            style={{ flex: 1, fontSize: 16, color: colors.text, fontFamily: "Manrope_600SemiBold", paddingVertical: 12 }}
          />
        </View>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button small kind="outline" label={t("schoolCode")} onPress={() => setCodeOpen(true)} style={{ flex: 1 }} icon={<Icon name="code" size={18} color={colors.text} />} />
          <Button small kind="outline" label={t("scanQr")} onPress={() => setScanOpen(true)} style={{ flex: 1 }} icon={<Icon name="qr" size={18} color={colors.text} />} />
        </View>
      </View>

      <FlatList
        data={list}
        keyExtractor={(s) => s.code}
        contentContainerStyle={{ padding: size.side, gap: 10 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 10, paddingBottom: 2 }}>
            <Text size={12} weight={800} color={colors.textSoft}>
              {q.length >= 3 || byCode ? t("searchResults") : t("typeThree")}
            </Text>
            {search.error ? <Notice tone="error" text={(search.error as ApiError).message} /> : null}
            {q.length >= 3 && search.isSuccess && list.length === 0 ? <Notice text={t("noSchool")} /> : null}
          </View>
        }
        renderItem={({ item }) => {
          const on = picked?.code === item.code;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${item.name}${item.city ? `, ${item.city}` : ""}`}
              onPress={() => setPicked(item)}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: size.cardRadius, backgroundColor: colors.white, borderWidth: on ? 2 : 1, borderColor: on ? colors.indigo : colors.line }}
            >
              <SchoolBadge school={item} size={44} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text size={15} weight={700} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text size={12} weight={600} color={colors.textSoft} numberOfLines={1}>
                  {item.city ?? item.code}
                </Text>
              </View>
              <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: on ? 7 : 2, borderColor: on ? colors.indigo : "#C5CBD6", backgroundColor: colors.white }} />
            </Pressable>
          );
        }}
      />

      <View style={{ paddingHorizontal: size.side, paddingBottom: insets.bottom + 16, paddingTop: 8 }}>
        <Button
          label={t("continue")}
          disabled={!picked}
          onPress={async () => {
            if (!picked) return;
            await chooseSchool(picked);
            router.push("/sign-in");
          }}
        />
      </View>

      <CodeSheet open={codeOpen} onClose={() => setCodeOpen(false)} onFound={found} />
      {scanOpen ? <QrScanner onClose={() => setScanOpen(false)} onFound={found} /> : null}
    </View>
  );
}

function CodeSheet({ open, onClose, onFound }: { open: boolean; onClose: () => void; onFound: (s: School) => void }) {
  const { t } = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    const c = codeFrom(code);
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      onFound(await api.schoolByCode(c));
      setCode("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(16,24,40,0.45)", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: colors.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 16, paddingBottom: 32, gap: 14 }}>
          <Text accessibilityRole="header" size={20} weight={800}>
            {t("enterCode")}
          </Text>
          <Field
            label={t("schoolCode")}
            placeholder={t("codePlaceholder")}
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            returnKeyType="go"
            onSubmitEditing={check}
          />
          <Text size={12} weight={600} color={colors.textSoft}>
            {t("codeHelp")}
          </Text>
          {error ? <Notice tone="error" text={error} /> : null}
          <Button label={t("check")} onPress={check} busy={busy} disabled={!code.trim()} />
          <Button label={t("cancel")} kind="outline" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function QrScanner({ onClose, onFound }: { onClose: () => void; onFound: (s: School) => void }) {
  const { t } = useT();
  const [perm, requestPerm] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (perm && !perm.granted && perm.canAskAgain) requestPerm();
  }, [perm, requestPerm]);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {perm?.granted ? (
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              busy
                ? undefined
                : async ({ data }) => {
                    setBusy(true);
                    try {
                      onFound(await api.schoolByCode(codeFrom(data)));
                    } catch (e) {
                      setError(e instanceof ApiError ? e.message : t("errorGeneric"));
                      setTimeout(() => setBusy(false), 1500);
                    }
                  }
            }
          />
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <View style={{ position: "absolute", left: 16, right: 16, bottom: 40, gap: 10 }}>
          {error ? <Notice tone="error" text={error} /> : null}
          <Button label={t("cancel")} kind="outline" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
