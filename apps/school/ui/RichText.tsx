// Shows the HTML that teachers write on the website (homework, notices) as plain native text:
// paragraphs, line breaks, lists, headings, bold, italic, underline and links. Everything else
// is dropped, so no script, style or remote content from the HTML ever runs in the app.

import React from "react";
import { Linking, Text as RNText, TextStyle, View } from "react-native";
import { Text } from "./Text";
import { colors } from "./theme";

type Run = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; href?: string };
type Block = { kind: "p" | "h" | "li"; runs: Run[]; index?: number };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", bull: "•", rupee: "₹" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Exported for tests: HTML → blocks of styled runs. */
export function parseHtml(html: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block = { kind: "p", runs: [] };
  const style = { bold: 0, italic: 0, underline: 0 };
  let href: string | undefined;
  const lists: { ordered: boolean; n: number }[] = [];
  const flush = (next: Block["kind"] = "p", index?: number) => {
    if (cur.runs.some((r) => r.text.trim())) blocks.push(cur);
    cur = { kind: next, runs: [], index };
  };
  const cleaned = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const re = /<\/?([a-z0-9]+)([^>]*)>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m[3] !== undefined) {
      const text = decode(m[3]).replace(/\s+/g, " ");
      if (text) cur.runs.push({ text, bold: style.bold > 0, italic: style.italic > 0, underline: style.underline > 0, href });
      continue;
    }
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === "/";
    switch (tag) {
      case "p": case "div": case "section": case "article": case "blockquote": case "tr":
        flush();
        break;
      case "br":
        cur.runs.push({ text: "\n" });
        break;
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        flush(closing ? "p" : "h");
        break;
      case "ul": case "ol":
        if (closing) lists.pop();
        else lists.push({ ordered: tag === "ol", n: 0 });
        flush();
        break;
      case "li": {
        if (closing) { flush(); break; }
        const l = lists[lists.length - 1];
        if (l) l.n++;
        flush("li", l?.ordered ? l.n : undefined);
        break;
      }
      case "b": case "strong": style.bold += closing ? -1 : 1; break;
      case "i": case "em": style.italic += closing ? -1 : 1; break;
      case "u": style.underline += closing ? -1 : 1; break;
      case "a": {
        if (closing) { href = undefined; break; }
        const h = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(m[2]);
        const url = h ? decode(h[1] ?? h[2]) : "";
        href = /^https?:\/\//i.test(url) ? url : undefined;   // only web links open
        break;
      }
      default:
        break;
    }
    style.bold = Math.max(0, style.bold); style.italic = Math.max(0, style.italic); style.underline = Math.max(0, style.underline);
  }
  flush();
  // trim spaces at the start and end of each block
  for (const b of blocks) {
    if (b.runs[0]) b.runs[0].text = b.runs[0].text.replace(/^\s+/, "");
    const last = b.runs[b.runs.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
  }
  return blocks.filter((b) => b.runs.some((r) => r.text));
}

export function RichText({ html, size = 15 }: { html: string | null | undefined; size?: number }) {
  const blocks = parseHtml(html ?? "");
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((b, i) => {
        const runs = b.runs.map((r, j) => {
          const st: TextStyle = {
            fontWeight: r.bold ? "800" : undefined,
            fontStyle: r.italic ? "italic" : undefined,
            textDecorationLine: r.underline || r.href ? "underline" : undefined,
            color: r.href ? colors.indigo : undefined,
          };
          return (
            <RNText key={j} style={st} onPress={r.href ? () => Linking.openURL(r.href!) : undefined} accessibilityRole={r.href ? "link" : undefined}>
              {r.text}
            </RNText>
          );
        });
        if (b.kind === "li") {
          return (
            <View key={i} style={{ flexDirection: "row", gap: 8, paddingLeft: 4 }}>
              <Text size={size} weight={700}>{b.index ? `${b.index}.` : "•"}</Text>
              <Text size={size} weight={500} style={{ flex: 1, lineHeight: size * 1.5 }}>{runs}</Text>
            </View>
          );
        }
        return (
          <Text key={i} size={b.kind === "h" ? size + 2 : size} weight={b.kind === "h" ? 800 : 500} style={{ lineHeight: size * 1.5 }}>
            {runs}
          </Text>
        );
      })}
    </View>
  );
}
