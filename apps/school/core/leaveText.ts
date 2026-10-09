// How a student leave request is written on the teacher screens: name, dates, days, class.
import type { StaffLeave } from "./api";
import { useDates, useT } from "./i18n";

export const leaveName = (l: StaffLeave) => [l.first_name, l.last_name].filter(Boolean).join(" ");

export function useLeaveText() {
  const { t } = useT();
  const { dayMonth } = useDates();
  return {
    dates: (l: StaffLeave) => (l.start_date === l.end_date ? dayMonth(l.start_date) : `${dayMonth(l.start_date)} – ${dayMonth(l.end_date)}`),
    days: (l: StaffLeave) => (Number(l.total_days) === 1 ? t("day", { n: 1 }) : t("days", { n: Number(l.total_days) })),
    klass: (l: StaffLeave) => [l.class_name, l.section_name].filter(Boolean).join("-"),
  };
}
