// =============================================================================
//  DELIBERATELY UNSAFE — the PDF gate's red-first template, NEVER used to
//  build anything a person receives.
//
//  It does exactly what Mr. Singh's condition 1 forbids: it evaluates the
//  document's text as Typst markup. The gate runs its injection checks
//  against this first and they must FAIL (a planted "#read" runs, markup in
//  the text is interpreted), proving the checks can see the thing they
//  guard against; then the same checks must pass on apps/render/pdf/main.typ.
// =============================================================================
#set page(paper: "a4", footer: context align(center, text(size: 9pt, counter(page).display("1"))))
#let data = json("doc.json")
#for p in data.doc.at("content", default: ()) {
  if p.type == "paragraph" {
    for t in p.at("content", default: ()) {
      if t.type == "text" { eval(t.text, mode: "markup") }
    }
    parbreak()
  }
}
