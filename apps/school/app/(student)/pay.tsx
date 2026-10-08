// Pay fees online (FR-S07, B-08, D-M10). Pays everything due now: the server adds fines up to
// today and enforces oldest-first. Razorpay's own checkout page runs inside the app, so the app
// never sees card or UPI details. Whatever checkout says, the receipt is shown only when the
// school's server says the payment is "paid"; "confirming" means the money is seen, do not pay
// again. Screenshots are blocked on this screen (NF-06).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { router } from "expo-router";
import { WebView } from "react-native-webview";
import { usePreventScreenCapture } from "expo-screen-capture";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, fileRequest } from "@/core/api";
import { useActive, useMe } from "@/core/useSchool";
import { inr } from "@/core/format";
import { openPdf } from "@/core/files";
import { useT } from "@/core/i18n";
import { Text } from "@/ui/Text";
import { Button, Card, Notice } from "@/ui/parts";
import { Screen } from "@/ui/Screen";
import { colors, size } from "@/ui/theme";

type Order = Awaited<ReturnType<typeof api.createOrder>>;
type Phase =
  | { kind: "preparing" }
  | { kind: "ready"; order: Order }
  | { kind: "checkout"; order: Order }
  | { kind: "checking"; order: Order; note?: "confirming" }
  | { kind: "paid"; receipt: { id: number; receipt_no: string; total_amount: number } }
  | { kind: "ended"; message: string; tone: "error" | "warn" | "info" };

const POLL_MS = 3000;
const POLL_TRIES = 40; // about 2 minutes

/** The checkout page: Razorpay's script, opened at once, reporting back to the app. */
function checkoutHtml(options: Record<string, unknown>) {
  const json = JSON.stringify(options).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F4F6FB">
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
  function send(m){ window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  try {
    var opts = ${json};
    opts.handler = function (r) { send({ type: "success", r: r }); };
    opts.modal = { ondismiss: function () { send({ type: "dismiss" }); }, confirm_close: true };
    var rzp = new Razorpay(opts);
    rzp.on("payment.failed", function (e) { send({ type: "failed", reason: (e && e.error && e.error.description) || "" }); });
    rzp.open();
  } catch (e) { send({ type: "error", reason: String(e) }); }
</script></body></html>`;
}

export default function Pay() {
  usePreventScreenCapture();
  const { t } = useT();
  const qc = useQueryClient();
  const { active, host, token, id } = useActive();
  const fees = useMe("fees", api.fees);
  const [phase, setPhase] = useState<Phase>({ kind: "preparing" });
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  // everything due now, each at its balance without the fine (the server adds fines)
  const items = useMemo(
    () =>
      (fees.data?.items ?? [])
        .filter((i) => i.active && i.due > 0 && (i.status === "overdue" || i.status === "due_today"))
        .map((i) => ({ student_fee_item_id: i.id, amount: Math.round((i.due - i.fine) * 100) / 100 }))
        .filter((i) => i.amount > 0),
    [fees.data],
  );

  useEffect(() => {
    if (!fees.data || phase.kind !== "preparing") return;
    if (!items.length) return setPhase({ kind: "ended", message: t("nothingDue"), tone: "info" });
    api
      .createOrder(host, token!, items)
      .then((order) => alive.current && setPhase({ kind: "ready", order }))
      .catch((e) => alive.current && setPhase({ kind: "ended", message: e instanceof ApiError ? e.message : t("errorGeneric"), tone: "error" }));
  }, [fees.data, items, host, token, phase.kind, t]);

  const refreshFees = () => {
    qc.invalidateQueries({ queryKey: [id, "fees"] });
    qc.invalidateQueries({ queryKey: [id, "receipts"] });
  };

  /** Ask the server until the payment is final; only "paid" shows a receipt. */
  const settle = async (order: Order, afterCheckout: "success" | "dismiss" | "failed", reason?: string) => {
    setPhase({ kind: "checking", order });
    for (let i = 0; i < POLL_TRIES && alive.current; i++) {
      try {
        const s = await api.paymentStatus(host, token!, order.order_id);
        if (s.status === "paid" && s.receipt) {
          refreshFees();
          return setPhase({ kind: "paid", receipt: s.receipt });
        }
        if (s.status === "confirming") setPhase({ kind: "checking", order, note: "confirming" });
        if (s.status === "failed" || s.status === "refunded") {
          refreshFees();
          return setPhase({ kind: "ended", message: reason || t("payFailed"), tone: "error" });
        }
        // still pending: if checkout was closed without paying, stop asking after one look
        if (s.status === "pending" && afterCheckout !== "success") {
          return setPhase({ kind: "ended", message: afterCheckout === "dismiss" ? t("payCancelled") : reason || t("payFailed"), tone: "warn" });
        }
      } catch {
        // a dropped connection while asking: keep asking
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (alive.current) setPhase({ kind: "ended", message: t("payStillWaiting"), tone: "warn" });
  };

  const onMessage = async (raw: string, order: Order) => {
    let m: { type: string; r?: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }; reason?: string };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "success" && m.r) {
      // tell the server; its answer is not trusted on its own, the status call decides
      api.verifyPayment(host, token!, m.r).catch(() => {});
      return settle(order, "success");
    }
    if (m.type === "dismiss") return settle(order, "dismiss");
    if (m.type === "failed") return settle(order, "failed", m.reason);
    setPhase({ kind: "ended", message: t("errorGeneric"), tone: "error" });
  };

  if (phase.kind === "checkout") {
    const o = phase.order;
    const html = checkoutHtml({
      key: o.key,
      order_id: o.order_id,
      currency: o.currency || "INR",
      name: active?.school.name ?? "TatvaOS School",
      description: t("payTitle"),
      prefill: { name: o.student?.name, email: o.student?.email ?? undefined, contact: o.student?.mobile_no ?? undefined },
      theme: { color: colors.indigo },
    });
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <WebView
          originWhitelist={["*"]}
          source={{ html, baseUrl: "https://checkout.razorpay.com" }}
          javaScriptEnabled
          domStorageEnabled
          onMessage={(e) => onMessage(e.nativeEvent.data, o)}
          // UPI apps open outside the app; the web page stays for card and net banking
          onShouldStartLoadWithRequest={(req) => {
            if (/^(https?:|about:|data:)/i.test(req.url)) return true;
            Linking.openURL(req.url).catch(() => {});
            return false;
          }}
          startInLoadingState
          renderLoading={() => <ActivityIndicator style={{ marginTop: 40 }} color={colors.indigo} />}
        />
      </View>
    );
  }

  return (
    <Screen title={t("payTitle")}>
      <View style={{ padding: size.side, gap: 16 }}>
        {phase.kind === "preparing" ? (
          <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <ActivityIndicator color={colors.indigo} />
            <Text size={14} weight={600}>{t("payPreparing")}</Text>
          </Card>
        ) : null}

        {phase.kind === "ready" ? (
          <>
            <Card style={{ gap: 6 }}>
              <Text size={13} weight={600} color={colors.textSoft}>{t("totalDueNow")}</Text>
              <Text size={34} weight={800}>{inr(phase.order.amount)}</Text>
              <Text size={12} weight={500} color={colors.textSoft}>{t("payTotalNote")}</Text>
            </Card>
            <Button label={t("pay", { amount: inr(phase.order.amount) })} onPress={() => setPhase({ kind: "checkout", order: phase.order })} />
            <Text size={12} weight={600} color={colors.textSoft} style={{ textAlign: "center" }}>{t("securePayment")}</Text>
          </>
        ) : null}

        {phase.kind === "checking" ? (
          <Card style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <ActivityIndicator color={colors.indigo} />
              <Text size={14} weight={700} style={{ flex: 1 }}>{t("payWaiting")}</Text>
            </View>
            {phase.note === "confirming" ? <Notice tone="warn" text={t("payConfirming")} /> : null}
          </Card>
        ) : null}

        {phase.kind === "paid" ? (
          <>
            <Card style={{ gap: 6, alignItems: "center", paddingVertical: 24 }}>
              <Text size={20} weight={800} color={colors.presentText}>{t("paySuccess")}</Text>
              <Text size={28} weight={800}>{inr(phase.receipt.total_amount)}</Text>
              <Text size={13} weight={600} color={colors.textSoft}>{t("paySuccessSub", { no: phase.receipt.receipt_no })}</Text>
            </Card>
            <Button
              label={t("viewReceipt")}
              kind="light"
              onPress={async () => {
                const r = fileRequest(host, `/api/finance/receipts/${phase.receipt.id}/pdf`, token!);
                await openPdf(r.url, `Receipt ${phase.receipt.receipt_no}`, r.headers).catch(() => {});
              }}
            />
            <Button label={t("doneLabel")} onPress={() => router.back()} />
          </>
        ) : null}

        {phase.kind === "ended" ? (
          <>
            <Notice tone={phase.tone} text={phase.message} />
            <Button label={t("doneLabel")} kind="outline" onPress={() => router.back()} />
          </>
        ) : null}
      </View>
    </Screen>
  );
}
