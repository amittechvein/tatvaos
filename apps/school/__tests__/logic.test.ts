/// <reference types="jest" />
// Unit checks for the app's own logic (SRS section 12). Run: pnpm test
import { parseHtml } from "../ui/RichText";
import { codeFrom } from "../core/schoolCode";
import { ddmmyyyy, inr, tenDigits } from "../core/format";
import { strongEnough } from "../ui/PasswordForm";
import { appRouteFor } from "../core/links";
import { strings, LANGS } from "../core/strings";
import { initials } from "../ui/SchoolBadge";

jest.mock("expo-secure-store", () => {
  const store = new Map<string, string>();
  return {
    __store: store,
    getItemAsync: jest.fn(async (k: string) => store.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void store.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void store.delete(k)),
  };
});

describe("teachers' HTML (homework, notices)", () => {
  it("keeps paragraphs, bold and lists, and drops scripts", () => {
    const blocks = parseHtml('<p>Learn the <b>table of 7</b>.</p><script>alert(1)</script><ul><li>One</li><li>Two</li></ul><ol><li>First</li></ol>');
    expect(blocks.map((b) => b.kind)).toEqual(["p", "li", "li", "li"]);
    expect(blocks[0].runs.find((r) => r.bold)?.text).toBe("table of 7");
    expect(JSON.stringify(blocks)).not.toContain("alert");
    expect(blocks[3].index).toBe(1);
  });
  it("decodes entities and only keeps web links", () => {
    const [b] = parseHtml('<p>Fees &amp; fines &#8377;500 <a href="https://example.org/x">site</a> <a href="javascript:alert(1)">bad</a></p>');
    const text = b.runs.map((r) => r.text).join("");
    expect(text).toContain("Fees & fines ₹500");
    expect(b.runs.find((r) => r.text === "site")?.href).toBe("https://example.org/x");
    expect(b.runs.find((r) => r.text === "bad")?.href).toBeUndefined();
  });
  it("gives nothing for empty input", () => {
    expect(parseHtml("")).toEqual([]);
    expect(parseHtml("<p> </p>")).toEqual([]);
  });
});

describe("school code from typed text or a QR link (FR-C01)", () => {
  it.each([
    ["demo", "DEMO"],
    ["  Demo ", "DEMO"],
    ["https://school.tatvaos.com/s/demo", "DEMO"],
    ["https://school.tatvaos.com/s/GVA2026/", "GVA2026"],
    ["https://school.tatvaos.com/s/demo?from=poster", "DEMO"],
  ])("%s → %s", (input, code) => expect(codeFrom(input)).toBe(code));
});

describe("Indian formats (NF-10)", () => {
  it.each([
    [0, "₹0"],
    [500, "₹500"],
    [3570, "₹3,570"],
    [123456, "₹1,23,456"],
    [12345678, "₹1,23,45,678"],
    [-4500, "-₹4,500"],
    [99.6, "₹100"],
  ])("%s → %s", (n, s) => expect(inr(n)).toBe(s));
  it("dates as DD/MM/YYYY", () => {
    expect(ddmmyyyy("2026-10-07")).toBe("07/10/2026");
    expect(ddmmyyyy("2026-10-07T18:30:00.000Z")).toBe("07/10/2026");
    expect(ddmmyyyy(null)).toBe("");
  });
});

describe("mobile number for OTP sign-in", () => {
  it("keeps the ten digits however it is typed", () => {
    expect(tenDigits("9876543210")).toBe("9876543210");
    expect(tenDigits("+91 98765 43210")).toBe("9876543210");
    expect(tenDigits("098765 43210")).toBe("9876543210");
    expect(tenDigits("919876543210")).toBe("9876543210");
  });
  it("refuses what is not an Indian mobile", () => {
    expect(tenDigits("12345")).toBeNull();
    expect(tenDigits("5876543210")).toBeNull();
    expect(tenDigits("98765432101")).toBeNull();
    expect(tenDigits("")).toBeNull();
  });
});

describe("password rule (same as the website)", () => {
  it.each([
    ["Abcdef1!", true],
    ["abcdef1!", false],
    ["ABCDEF1!", false],
    ["Abcdefg!", false],
    ["Abcdefg1", false],
    ["Ab1!", false],
  ])("%s → %s", (p, ok) => expect(strongEnough(p)).toBe(ok));
});

describe("notification links open the right screen", () => {
  it.each([
    ["/student/homework/12", "/homework"],
    ["https://demo.tatvaos.org/my/announcements/3", "/notices"],
    ["/fees", "/fees"],
    ["/finance/receipts/9", "/fees"],
    ["/attendance", "/attendance"],
    ["/something-else", null],
    [null, null],
  ])("%s → %s", (link, route) => expect(appRouteFor(link)).toBe(route));
});

describe("school initials", () => {
  it.each([
    ["Demo Public School", "DPS"],
    ["A.A.M. CHILDREN'S ACADEMY DURGASTHAN KATIHAR", "AAM"],
    ["Green Valley Academy", "GVA"],
  ])("%s → %s", (name, s) => expect(initials(name)).toBe(s));
});

describe("translations", () => {
  const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");
  for (const lang of LANGS) {
    it(`${lang} has every string, with the same {holes} as English`, () => {
      for (const [key, en] of Object.entries(strings.en)) {
        const s = (strings[lang] as Record<string, string>)[key];
        expect(typeof s === "string" && s.trim().length > 0 ? key : `${key} missing`).toBe(key);
        expect(`${key}: ${holes(s)}`).toBe(`${key}: ${holes(en)}`);
      }
    });
  }
  it("months and weekdays have 12 and 7 names in every language", () => {
    for (const lang of LANGS) {
      expect(strings[lang].months.split(",")).toHaveLength(12);
      expect(strings[lang].weekdays.split(",")).toHaveLength(7);
      expect(strings[lang].weekdaysShort.split(",")).toHaveLength(7);
    }
  });
});

describe("offline copies (SRS section 8)", () => {
  // loaded after the secure-store mock
  const Offline = require("../core/offline") as typeof import("../core/offline");
  const store: Map<string, string> = require("expo-secure-store").__store;

  it("keeps a copy of a read screen and returns it", async () => {
    await Offline.save("DEMO_2", "attendance", ["2026-10"], { days: [1] });
    const copy = await Offline.load<{ days: number[] }>("DEMO_2", "attendance", ["2026-10"]);
    expect(copy?.data.days).toEqual([1]);
    expect(typeof copy?.at).toBe("number");
  });
  it("never keeps screens that are not read screens", async () => {
    await Offline.save("DEMO_2", "report-cards", [], { url: "x" });
    expect(await Offline.load("DEMO_2", "report-cards")).toBeNull();
  });
  it("skips answers that are too large", async () => {
    await Offline.save("DEMO_2", "fees", [], { big: "x".repeat(70_000) });
    expect(await Offline.load("DEMO_2", "fees")).toBeNull();
  });
  it("sign-out deletes every copy of that login only", async () => {
    await Offline.save("DEMO_2", "timetable", ["2026-10-08"], { periods: [] });
    await Offline.save("GREEN_1", "timetable", ["2026-10-08"], { periods: [] });
    await Offline.clear("DEMO_2");
    expect(await Offline.load("DEMO_2", "attendance", ["2026-10"])).toBeNull();
    expect(await Offline.load("DEMO_2", "timetable", ["2026-10-08"])).toBeNull();
    expect(await Offline.load("GREEN_1", "timetable", ["2026-10-08"])).not.toBeNull();
    expect([...store.keys()].some((k) => k.includes("DEMO_2"))).toBe(false);
  });
});

describe("a tapped push opens the right child (B-04)", () => {
  const { accountIdFor } = require("../core/push") as typeof import("../core/push");
  it.each([
    [{ school: "demo", userId: 32 }, "DEMO_32"],
    [{ school: "green", userId: "7" }, "GREEN_7"],
    [{ school: "demo" }, null],
    [{ userId: 3 }, null],
    [undefined, null],
  ])("%j → %s", (data, id) => expect(accountIdFor(data as never)).toBe(id));
});
