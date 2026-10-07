// =============================================================================
//  The PDF of a document — ONE FIXED TEMPLATE (decision 0011 condition 2)
// =============================================================================
//
//  The document is DATA, never markup (Mr. Singh, 1 Oct 2026). The render
//  service writes the stored document's JSON to doc.json beside this file;
//  this template reads it with json() and builds the page from it. Every
//  piece of customer text reaches the page as a string VALUE, which Typst
//  shows as text and never evaluates — so "#read(...)", "#include",
//  "#import" typed into a document print as those characters. Nothing from a
//  document is ever written into Typst source.
//
//  This file must stay that way:
//    - no eval(), and no read(), include, import or plugin of anything a
//      document names;
//    - a picture is a file the render service wrote under a name IT chose
//      (pic-<n>.<png|jpg|gif|webp>), checked here against that exact shape —
//      never a path or address from the document;
//    - a link becomes a PDF link only for https, http and mailto.
//  Typst runs with --root set to an empty per-job folder holding only this
//  file, doc.json and those pictures, with no package path and no network.
//
//  Fonts (Amit, 1 Oct 2026): open substitutes, metric-compatible where they
//  exist — Liberation Sans / Serif / Mono for Arial / Times / Courier, so line
//  breaks stay where people put them; close matches for Georgia, Verdana and
//  Trebuchet; Noto for the Indian scripts.
// =============================================================================

#let data = json("doc.json")

#let indic = (
  "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Tamil", "Noto Sans Telugu",
  "Noto Sans Gujarati", "Noto Sans Kannada", "Noto Sans Malayalam", "Noto Sans Gurmukhi",
  "Noto Sans Oriya",
)
#let tail = indic + ("DejaVu Sans", "Noto Color Emoji")
#let sans = ("Liberation Sans",) + tail
#let mono = ("Liberation Mono",) + tail

// ---- values from the document, each checked, none ever evaluated -------------

#let get(d, key, default) = {
  if type(d) != dictionary { return default }
  let v = d.at(key, default: none)
  if v == none { default } else { v }
}
#let attrs(n) = get(n, "attrs", (:))
#let kids(n) = {
  let c = get(n, "content", ())
  if type(c) == array { c } else { () }
}

// CSS font-family -> an open font list.
#let family(css) = {
  if type(css) != str or css == "" { return none }
  let c = lower(css)
  let first = if c.contains("courier") or c.contains("monospace") { ("Liberation Mono",) }
    else if c.contains("times") { ("Liberation Serif",) }
    else if c.contains("georgia") { ("DejaVu Serif",) }
    else if c.contains("verdana") { ("DejaVu Sans",) }
    else if c.contains("trebuchet") { ("Noto Sans",) }
    else if c.contains("noto") { ("Noto Sans",) }
    else if c.contains("serif") and not c.contains("sans") { ("Liberation Serif",) }
    else { ("Liberation Sans",) }
  first + tail
}

// "#1a73e8", "#fff", "rgb(26, 115, 232)" -> a colour; anything else -> none.
#let colour(s) = {
  if type(s) != str { return none }
  let t = s.trim()
  if t.match(regex("^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")) != none { return rgb(t) }
  let m = t.match(regex("^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})"))
  if m == none { return none }
  let v = m.captures.map(x => calc.min(255, int(x)))
  rgb(v.at(0), v.at(1), v.at(2))
}

// "14pt", "18px", "12" -> a length between 4pt and 200pt; anything else -> none.
#let size(s) = {
  if type(s) != str { return none }
  let m = s.trim().match(regex("^(\d{1,3}(\.\d+)?)(pt|px)?$"))
  if m == none { return none }
  let x = float(m.captures.at(0))
  let pt = if m.captures.at(2) == "px" { x * 0.75 } else { x }
  calc.clamp(pt, 4.0, 200.0) * 1pt
}

#let whole(v, default, lo, hi) = {
  let x = if type(v) == int { v } else if type(v) == float { int(v) }
    else if type(v) == str and v.match(regex("^\d{1,4}$")) != none { int(v) } else { default }
  calc.clamp(x, lo, hi)
}

// ---- marks on a run of text ---------------------------------------------------

#let marked(body, marks) = {
  let out = body
  if type(marks) != array { return out }
  for m in marks {
    let t = get(m, "type", "")
    let a = get(m, "attrs", (:))
    out = if t == "bold" { text(weight: "bold", out) }
      else if t == "italic" { text(style: "italic", out) }
      else if t == "underline" { underline(out) }
      else if t == "strike" { strike(out) }
      else if t == "code" { box(fill: luma(241), inset: (x: 2pt), outset: (y: 2pt), radius: 2pt, text(font: mono, out)) }
      else if t == "subscript" { sub(out) }
      else if t == "superscript" { super(out) }
      else if t == "highlight" {
        let c = colour(get(a, "color", ""))
        highlight(fill: if c == none { rgb("#fff475") } else { c }, out)
      }
      else if t == "textStyle" {
        let r = out
        let c = colour(get(a, "color", ""))
        if c != none { r = text(fill: c, r) }
        let f = family(get(a, "fontFamily", ""))
        if f != none { r = text(font: f, r) }
        let s = size(get(a, "fontSize", ""))
        if s != none { r = text(size: s, r) }
        r
      }
      else if t == "link" {
        let h = get(a, "href", "")
        if type(h) == str and (h.starts-with("https://") or h.starts-with("http://") or h.starts-with("mailto:")) {
          link(h, text(fill: rgb("#1a73e8"), out))
        } else { out }
      }
      else { out }
  }
  out
}

// ---- a picture: only a file the service wrote -----------------------------------

#let picture(n) = {
  let a = attrs(n)
  let f = get(a, "_pic", "")
  if type(f) == str and f.match(regex("^pic-\d{1,4}\.(png|jpg|gif|webp)$")) != none {
    let w = whole(get(a, "width", 0), 0, 0, 2000)
    if w > 0 { box(image(f, width: calc.min(w * 0.75, 450) * 1pt)) } else { box(image(f, width: 100%)) }
  } else {
    // A picture from the web, or one the service could not supply: the PDF
    // has no network, so it is named, not fetched.
    let alt = get(a, "alt", "")
    text(fill: luma(110), "[picture" + (if type(alt) == str and alt != "" { ": " + alt } else { "" }) + "]")
  }
}

// ---- the whole document: one recursive function --------------------------------

#let node(n) = {
  let t = get(n, "type", "")
  let a = attrs(n)
  if t == "text" {
    let s = get(n, "text", "")
    if type(s) != str { s = "" }
    marked(s, get(n, "marks", ()))
  } else if t == "hardBreak" {
    linebreak()
  } else if t == "image" {
    picture(n)
  } else if t == "paragraph" or t == "heading" {
    let body = for c in kids(n) { node(c) }
    let style = get(a, "docStyle", "")
    let level = whole(get(a, "level", 1), 1, 1, 4)
    let sized = if t == "heading" {
      let s = (20pt, 16pt, 14pt, 12pt).at(level - 1)
      let c = (black, black, rgb("#434343"), rgb("#666666")).at(level - 1)
      heading(level: level, text(size: s, weight: "regular", fill: c, body))
    } else if style == "title" {
      text(size: 26pt, body)
    } else if style == "subtitle" {
      text(size: 15pt, fill: rgb("#666666"), body)
    } else { body }
    let lh = get(a, "lineHeight", "")
    let lead = if type(lh) == str and lh.match(regex("^\d(\.\d+)?$")) != none {
      calc.clamp(float(lh) - 0.6, 0.2, 2.0) * 1em
    } else { 0.65em }
    let al = get(a, "textAlign", "left")
    let where = if al == "center" { center } else if al == "right" { right } else { left }
    let ind = whole(get(a, "indent", 0), 0, 0, 8) * 27pt  // 36px a step
    // A heading is never put inside par(): Typst drops it there, text and
    // all (the gate's first run, 1 Oct 2026: every heading missing).
    if t == "heading" {
      block(above: 14pt, below: 6pt, pad(left: ind, align(where, sized)))
    } else {
      block(above: 0.35em, below: 0.35em,
        pad(left: ind, align(where, par(justify: al == "justify", leading: lead,
          if body == none or body == [] { h(0pt) } else { sized }))))
    }
  } else if t == "bulletList" {
    list(..kids(n).map(node))
  } else if t == "orderedList" {
    enum(start: whole(get(a, "start", 1), 1, 1, 9999), ..kids(n).map(node))
  } else if t == "listItem" {
    for c in kids(n) { node(c) }
  } else if t == "taskList" {
    for it in kids(n) { node(it) }
  } else if t == "taskItem" {
    let box-mark = if get(a, "checked", false) == true { "☑" } else { "☐" }
    block(above: 0.35em, below: 0.35em, grid(columns: (auto, 1fr), column-gutter: 6pt,
      text(font: ("DejaVu Sans",), box-mark), for c in kids(n) { node(c) }))
  } else if t == "blockquote" {
    block(stroke: (left: 2pt + luma(200)), inset: (left: 10pt, y: 2pt), for c in kids(n) { node(c) })
  } else if t == "codeBlock" {
    let s = kids(n).map(c => { let x = get(c, "text", ""); if type(x) == str { x } else { "" } }).join()
    block(fill: luma(241), inset: 8pt, radius: 4pt, width: 100%,
      text(font: mono, size: 10pt, raw(if s == none { "" } else { s }, block: true)))
  } else if t == "horizontalRule" {
    line(length: 100%, stroke: 0.5pt + luma(180))
  } else if t == "pageBreak" {
    pagebreak(weak: true)
  } else if t == "table" {
    let rows = kids(n)
    let first = if rows.len() > 0 { kids(rows.at(0)) } else { () }
    let ncols = calc.max(1, first.map(c => whole(get(attrs(c), "colspan", 1), 1, 1, 64)).sum(default: 0))
    // Column widths from the first row's colwidth (px) when every column has one.
    let widths = ()
    for c in first {
      let cw = get(attrs(c), "colwidth", none)
      let span = whole(get(attrs(c), "colspan", 1), 1, 1, 64)
      for i in range(span) {
        widths.push(if type(cw) == array and cw.len() > i and type(cw.at(i)) in (int, float) {
          calc.clamp(cw.at(i) * 0.75, 12, 600) * 1pt } else { none })
      }
    }
    let cols = if widths.len() == ncols and widths.all(w => w != none) {
      let total = widths.sum()
      if total > 450pt { widths.map(w => w / total * 100% ) } else { widths }
    } else { (1fr,) * ncols }
    let nrows = rows.len()
    let cells = ()
    for (ri, r) in rows.enumerate() {
      for c in kids(r) {
        let ca = attrs(c)
        let cs = calc.min(whole(get(ca, "colspan", 1), 1, 1, 64), ncols)
        let rs = calc.min(whole(get(ca, "rowspan", 1), 1, 1, 999), nrows - ri)
        cells.push(table.cell(colspan: cs, rowspan: rs,
          fill: if get(c, "type", "") == "tableHeader" { luma(240) } else { none },
          {
            set text(weight: if get(c, "type", "") == "tableHeader" { "bold" } else { "regular" })
            for k in kids(c) { node(k) }
          }))
      }
    }
    table(columns: cols, stroke: 0.5pt + luma(170), inset: 5pt, ..cells)
  } else if t == "doc" {
    for c in kids(n) { node(c) }
  } else {
    [] // not in the schema: the render service has already dropped and named it
  }
}

// ---- the page (Amit, 1 Oct 2026: A4, page numbers at the foot) -------------------

#set document(title: none)
#set page(paper: "a4", margin: (x: 2.2cm, top: 2.2cm, bottom: 2.4cm),
  footer: context align(center, text(size: 9pt, fill: luma(110), counter(page).display("1"))))
#set text(font: sans, size: 11pt, hyphenate: false, lang: "en")
#set par(leading: 0.65em)
#set heading(numbering: none)
#show heading: set block(above: 14pt, below: 6pt)
#show raw: set text(font: mono)

#node(data.doc)
