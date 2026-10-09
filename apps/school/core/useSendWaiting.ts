// Sends the active login's attendance saves that waited for a connection (core/attendanceQueue.ts)
// and tells the teacher what happened to each: sent, someone else's newer save kept, or refused.
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useAccounts } from "./accounts";
import { api } from "./api";
import * as Queue from "./attendanceQueue";
import { timeIndia } from "./format";
import { useT } from "./i18n";

/** Sends this login's waiting attendance saves and says what happened to each. */
export function useSendWaiting() {
  const { active, token } = useAccounts();
  const { t } = useT();
  const qc = useQueryClient();
  return async () => {
    if (!active || !token) return;
    const out = await Queue.flush(active.id, (s) => api.saveAttendance(active.school.host, token, s), active.userId);
    const lines = out.flatMap((o) =>
      o.kind === "sent" ? [t("queuedSent", { label: o.item.label })]
        : o.kind === "theirs" ? [t("theirSaveKept", { by: o.by ?? t("someone"), label: o.item.label, time: timeIndia(o.at) })]
        : o.kind === "refused" ? [t("queuedRefused", { label: o.item.label, message: o.message })]
        : []);
    if (out.some((o) => o.kind !== "kept")) qc.invalidateQueries({ queryKey: [active.id] });
    if (lines.length) Alert.alert(t("takeAttendance"), lines.join("\n\n"));
    return out;
  };
}

