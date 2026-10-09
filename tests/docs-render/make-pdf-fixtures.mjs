// ============================================================================
//  Writes the two PDF-gate fixtures (run once; the files are committed):
//
//    fixtures/indian-scripts.json  Hindi and Marathi lines chosen for what a
//        shaper gets wrong — conjuncts, reph, the i-matra placed before its
//        consonant, stacked consonants, the Marathi eyelash ra and candra A —
//        then one line in each other script on the list (tool check only
//        until a reader checks it: Amit, 1 Oct 2026).
//    fixtures/pdf-injection.json   text and attributes that would be Typst
//        code if anything from a document were spliced into Typst source
//        (Mr. Singh's condition 1, red first).
//
//    node tests/docs-render/make-pdf-fixtures.mjs
// ============================================================================

import { writeFileSync } from 'node:fs';

const p = (text, marks) => ({ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const out = (name, doc) => writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), `${JSON.stringify(doc, null, 2)}\n`);

// Each line is its own paragraph and short enough never to wrap: the shaping
// check compares one PDF line with one reference line.
const DEVANAGARI = [
  'विद्यालय की वार्षिक फ़ीस ₹50,000 है।',
  'कृपया प्रत्येक छात्र अपना परिचय-पत्र साथ लाए।',
  'श्रद्धा क्षमा त्रिशूल ज्ञान द्वार स्वागत',
  'धर्म कार्य पूर्ण वर्ष आशीर्वाद',
  'किताब हिन्दी निकट सिद्धि',
  'राष्ट्र उद्घाटन शुद्ध विट्ठल',
  'महाराष्ट्र राज्य शिक्षण मंडळ, पुणे',
  'शाळेची वेळ सकाळी ९ ते दुपारी २ आहे.',
  'ऱ्या ॲप झाडे',
];
const OTHERS = {
  Bengali: 'বিদ্যালয়ের বার্ষিক ফি',
  Tamil: 'பள்ளிக்கூடம் கட்டணம்',
  Telugu: 'పాఠశాల రుసుము',
  Gujarati: 'શાળાની વાર્ષિક ફી',
  Kannada: 'ಶಾಲೆಯ ವಾರ್ಷಿಕ ಶುಲ್ಕ',
  Malayalam: 'വിദ്യാലയത്തിന്റെ വാർഷിക ഫീസ്',
  Gurmukhi: 'ਸਕੂਲ ਦੀ ਸਾਲਾਨਾ ਫੀਸ',
  Odia: 'ବିଦ୍ୟାଳୟର ବାର୍ଷିକ ଶୁଳ୍କ',
};

out('indian-scripts.json', {
  type: 'doc',
  content: [
    ...DEVANAGARI.map((t) => p(t)),
    p('महत्वपूर्ण सूचना', [{ type: 'bold' }]),
    ...Object.values(OTHERS).map((t) => p(t)),
  ],
});
// The Devanagari-only part: what the reader is sent (day one).
out('devanagari-sample.json', {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'देवनागरी नमूना — Devanagari sample' }] },
    ...DEVANAGARI.map((t) => p(t)),
    p('महत्वपूर्ण सूचना', [{ type: 'bold' }]),
  ],
});

const READ = '#read("/etc/passwd")';
out('pdf-injection.json', {
  type: 'doc',
  content: [
    p(READ),
    p('#include "doc.json"'),
    p('#import "@preview/cetz:0.3.4": *'),
    p('#eval("read(\\"/etc/passwd\\")")'),
    p('#image("/etc/passwd")'),
    p('#{ panic("injected") }'),
    p('#set page(paper: "a0")'),
    p('$ x^2 $ = heading *bold* _emph_ `raw` <label> @ref ]] [['),
    // Attributes: each must be ignored or shown, never run.
    { type: 'paragraph', content: [
      { type: 'text', text: 'evil link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
      { type: 'text', text: ' styled', marks: [{ type: 'textStyle', attrs: { fontFamily: '"); #read("/etc/passwd"); ("', color: READ, fontSize: '#read("x")' } }] },
      { type: 'text', text: ' highlighted', marks: [{ type: 'highlight', attrs: { color: READ } }] },
    ] },
    { type: 'paragraph', content: [
      { type: 'image', attrs: { src: '/etc/passwd', alt: 'a path as a picture' } },
      { type: 'image', attrs: { src: '../doc.json', alt: 'the data file as a picture' } },
      // A hand-made client can store any attribute: _pic is the service's own
      // name for a picture file, and must be removed before the template sees it.
      { type: 'image', attrs: { src: '/api/docs/x/images/y', alt: 'planted _pic', _pic: 'doc.json' } },
      { type: 'image', attrs: { src: 'https://tatvaos.com/brand/logo.png', alt: 'from the web' } },
    ] },
    { type: 'codeBlock', attrs: { language: READ }, content: [{ type: 'text', text: READ }] },
    { type: 'orderedList', attrs: { start: READ }, content: [
      { type: 'listItem', content: [p('#include "main.typ"')] },
    ] },
    { type: 'table', content: [
      { type: 'tableRow', content: [
        { type: 'tableCell', attrs: { colspan: READ, rowspan: '#read', colwidth: [READ] }, content: [p('#read("doc.json")')] },
      ] },
    ] },
  ],
});
console.log('wrote indian-scripts.json, devanagari-sample.json, pdf-injection.json');
