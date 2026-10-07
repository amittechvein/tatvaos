// The chosen language and t(). Starts from the phone's language when it is one of ours
// (Hindi, Bengali, Punjabi), else English; the choice is kept in secure storage.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { getLocales } from "expo-localization";
import { LANGS, Lang, StringKey, strings } from "./strings";

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (k: StringKey, vars?: Record<string, string | number>) => string };
const I18nContext = createContext<Ctx | null>(null);

function phoneLang(): Lang {
  const code = getLocales()[0]?.languageCode ?? "en";
  return (LANGS as string[]).includes(code) ? (code as Lang) : "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(phoneLang());
  useEffect(() => {
    SecureStore.getItemAsync("lang")
      .then((v) => v && (LANGS as string[]).includes(v) && setLangState(v as Lang))
      .catch(() => {});
  }, []);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    SecureStore.setItemAsync("lang", l).catch(() => {});
  }, []);
  const t = useCallback(
    (k: StringKey, vars?: Record<string, string | number>) => {
      let s = strings[lang][k] ?? strings.en[k];
      if (vars) for (const [n, v] of Object.entries(vars)) s = s.split(`{${n}}`).join(String(v));
      return s;
    },
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT() {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useT outside I18nProvider");
  return c;
}

/** "10 October" in the chosen language. */
export function useDates() {
  const { t } = useT();
  const months = t("months").split(",");
  const weekdays = t("weekdays").split(",");
  return {
    months,
    weekdaysShort: t("weekdaysShort").split(","),
    dayMonth: (iso: string | null | undefined) => {
      if (!iso) return "";
      const [, m, d] = iso.slice(0, 10).split("-").map(Number);
      return `${d} ${months[m - 1]}`;
    },
    longToday: (iso: string) => {
      const [y, m, d] = iso.split("-").map(Number);
      const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      return `${weekdays[wd]}, ${d} ${months[m - 1]}`;
    },
  };
}
