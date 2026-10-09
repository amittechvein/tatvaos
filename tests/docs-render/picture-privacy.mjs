// ============================================================================
//  A photo's location does not reach the PDF — proven inside the real render
//  container (Mr. Singh's ruling of 9 Oct 2026, docs/DOCS_PDF_DESIGN.md §10).
//
//  "The test should assert the absence of location in the output, not the
//  absence of an EXIF block — load the produced image and confirm no
//  location data of any kind survives, from a source photograph that
//  definitely had it. Red first: the same photograph through the old path."
//
//  So, in this order:
//    1. a photo carrying location in ALL THREE places phones and editors put
//       it — EXIF GPS, XMP (exif:GPSLatitude) and IPTC (City) — stored
//       sideways with an orientation tag (6: rotate 90°), as phones store a
//       portrait; libvips is asked to confirm the source really has each;
//    2. RED FIRST, the old path: the photo straight into Typst. The picture is
//       pulled back out of that PDF and inspected the same way as in step 4:
//       location must be FOUND, and the picture sideways — or the inspection
//       could not see what it is looking for, and step 4 would prove nothing;
//    3. the new path: buildPdf, the code the /render/pdf route runs;
//    4. the picture pulled back out of the new PDF and loaded: no EXIF, XMP,
//       IPTC or GPS field of any kind, and upright (orientation applied
//       before the strip, the ruling's addition 1);
//    5. the whole new PDF scanned for the three markers and block headers.
//
//  Fed to node on stdin by container-test.sh §9; prints key=value lines.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPdf } from '/app/apps/render/src/render-pdf.mjs';

const dir = mkdtempSync('/tmp/privacy-');
const out = (k, v) => console.log(`${k}=${v}`);
const run = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${args.join(' ')}: ${r.stderr || r.error}`);
  return r.stdout;
};

const MARK = { exif: 'TATVAOS-EXIF-MARKER', xmp: 'TATVAOS-XMP-MARKER', iptc: 'TATVAOS-IPTC-CITY' };

// ---- 1. the photo -----------------------------------------------------------
const seg = (marker, body) => {
  const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, body]);
};

/** EXIF (little-endian TIFF): ImageDescription marker, Orientation 6, and a GPS IFD with a position near Pune. */
function exif() {
  const desc = Buffer.from(`${MARK.exif}\0`, 'latin1');
  const ifd0 = 8; const ifd0Size = 2 + 3 * 12 + 4;
  const descAt = ifd0 + ifd0Size;
  const gpsAt = descAt + desc.length + (desc.length % 2);
  const gpsSize = 2 + 4 * 12 + 4;
  const latAt = gpsAt + gpsSize; const lonAt = latAt + 24;
  const t = Buffer.alloc(lonAt + 24);
  t.write('II', 0, 'latin1'); t.writeUInt16LE(42, 2); t.writeUInt32LE(ifd0, 4);
  const entry = (at, tag, type, count, value) => { t.writeUInt16LE(tag, at); t.writeUInt16LE(type, at + 2); t.writeUInt32LE(count, at + 4); value(at + 8); };
  t.writeUInt16LE(3, ifd0);
  entry(ifd0 + 2, 0x010e, 2, desc.length, (v) => t.writeUInt32LE(descAt, v));     // ImageDescription
  entry(ifd0 + 14, 0x0112, 3, 1, (v) => t.writeUInt16LE(6, v));                   // Orientation: 6
  entry(ifd0 + 26, 0x8825, 4, 1, (v) => t.writeUInt32LE(gpsAt, v));               // GPS IFD
  desc.copy(t, descAt);
  t.writeUInt16LE(4, gpsAt);
  entry(gpsAt + 2, 0x0001, 2, 2, (v) => t.write('N\0', v, 'latin1'));             // GPSLatitudeRef
  entry(gpsAt + 14, 0x0002, 5, 3, (v) => t.writeUInt32LE(latAt, v));             // GPSLatitude
  entry(gpsAt + 26, 0x0003, 2, 2, (v) => t.write('E\0', v, 'latin1'));            // GPSLongitudeRef
  entry(gpsAt + 38, 0x0004, 5, 3, (v) => t.writeUInt32LE(lonAt, v));             // GPSLongitude
  [[18, 1], [31, 1], [2345, 100]].forEach(([n, d], i) => { t.writeUInt32LE(n, latAt + i * 8); t.writeUInt32LE(d, latAt + i * 8 + 4); });
  [[73, 1], [51, 1], [6789, 100]].forEach(([n, d], i) => { t.writeUInt32LE(n, lonAt + i * 8); t.writeUInt32LE(d, lonAt + i * 8 + 4); });
  return seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]));
}

/** XMP: the position again, as phones and editors also write it. */
function xmp() {
  const packet = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    + '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"'
    + ` exif:GPSLatitude="18,31.39N" exif:GPSLongitude="73,51.68E"><dc:description>${MARK.xmp}</dc:description>`
    + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  return seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(packet, 'utf8')]));
}

/** IPTC (in Photoshop's APP13): City 2:90. */
function iptc() {
  const city = Buffer.from(MARK.iptc, 'latin1');
  const rec = Buffer.concat([Buffer.from([0x1c, 0x02, 0x5a, 0x00, city.length]), city]);
  const pad = rec.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
  const size = Buffer.alloc(4); size.writeUInt32BE(rec.length);
  return seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), Buffer.from('8BIM', 'latin1'),
    Buffer.from([0x04, 0x04, 0x00, 0x00]), size, rec, pad]));
}

// 400 x 200 pixels: landscape as stored. With orientation 6 it is a portrait photo.
run('vips', ['black', join(dir, 'base.jpg'), '400', '200']);
const base = readFileSync(join(dir, 'base.jpg'));
const photo = Buffer.concat([base.subarray(0, 2), exif(), xmp(), iptc(), base.subarray(2)]);
writeFileSync(join(dir, 'photo.jpg'), photo);

/** Every metadata field libvips sees in a JPEG, and its size. */
function inspect(file) {
  // The first line names the file (a random folder name): only the fields after it are read.
  const all = run('vipsheader', ['-a', file]).split('\n').slice(1).join('\n');
  const w = Number(run('vipsheader', ['-f', 'width', file]).trim());
  const h = Number(run('vipsheader', ['-f', 'height', file]).trim());
  return {
    gps: /gps/i.test(all), exif: /^exif-/im.test(all), xmp: /^xmp-data/im.test(all), iptc: /^iptc-data/im.test(all),
    orientation: (/^orientation:\s*(\d+)/im.exec(all) ?? [])[1] ?? 'none', size: `${w}x${h}`,
  };
}
const src = inspect(join(dir, 'photo.jpg'));
out('source_gps', src.gps); out('source_xmp', src.xmp); out('source_iptc', src.iptc); out('source_orientation', src.orientation);

/** The (one) JPEG embedded in a PDF, as its own file. Typst embeds a JPEG byte for byte. */
function pictureIn(pdf, name) {
  const start = pdf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  const end = pdf.indexOf(Buffer.from('endstream', 'latin1'), start);
  if (start < 0 || end < 0) throw new Error(`${name}: no JPEG in the PDF`);
  const eoi = pdf.lastIndexOf(Buffer.from([0xff, 0xd9]), end);
  const file = join(dir, `${name}.jpg`);
  writeFileSync(file, pdf.subarray(start, eoi + 2));
  return file;
}
const holds = (pdf, s) => pdf.includes(Buffer.from(s, 'latin1'));

// ---- 2. RED FIRST: the old path, the photo straight into Typst -------------
writeFileSync(join(dir, 'main.typ'), '#set page(width: 12cm, height: 12cm)\n#image("photo.jpg", width: 6cm)\n');
run('typst', ['compile', '--root', dir, '--font-path', '/usr/share/fonts', '--ignore-system-fonts',
  join(dir, 'main.typ'), join(dir, 'old.pdf')]);
const oldPdf = readFileSync(join(dir, 'old.pdf'));
const old = inspect(pictureIn(oldPdf, 'old'));
out('old_gps', old.gps); out('old_xmp', old.xmp); out('old_iptc', old.iptc); out('old_size', old.size);
out('old_markers', [MARK.exif, MARK.xmp, MARK.iptc].filter((m) => holds(oldPdf, m)).length);

// ---- 3. the new path: buildPdf, as the route runs it -----------------------
const src0 = '/api/docs/00000000-0000-4000-8000-000000000001/images/1';
const json = { type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Field trip' }] },
  { type: 'paragraph', content: [{ type: 'image', attrs: { src: src0, alt: null, title: null, width: '320', height: null } }] },
] };
const { pdf } = await buildPdf({ json, text: 'Field trip', pictures: new Map([[src0, new Uint8Array(photo)]]), deadline: Date.now() + 20_000 });
writeFileSync(join(dir, 'new.pdf'), pdf);

// ---- 4. the picture loaded back out of the new PDF --------------------------
const now = inspect(pictureIn(pdf, 'new'));
out('new_gps', now.gps); out('new_exif', now.exif); out('new_xmp', now.xmp); out('new_iptc', now.iptc);
out('new_orientation', now.orientation); out('new_size', now.size);

// ---- 5. the whole PDF ---------------------------------------------------------
// The photo's metadata block headers are looked for IN THE PICTURE's bytes.
// The PDF as a whole legitimately carries ONE XMP packet of its own — the
// document's metadata (creator tool, dates) that Typst writes for PDF/A-style
// readers — so a whole-file search for the XMP namespace finds that, not the
// photo's (first CI run, 9 Oct 2026: 1 header found, the picture clean). Its
// content is checked instead: no location field in it or anywhere else.
const headers = { exif: 'Exif\0\0', xmp: 'http://ns.adobe.com/xap/1.0/', iptc: 'Photoshop 3.0', '8bim': '8BIM' };
const picture = readFileSync(join(dir, 'new.jpg'));
out('new_picture_block_headers', Object.values(headers).filter((m) => holds(picture, m)).length);
out('new_pdf_block_headers_found', Object.entries(headers).filter(([, m]) => holds(pdf, m)).map(([k]) => k).join('+') || 'none');
out('old_pdf_block_headers_found', Object.entries(headers).filter(([, m]) => holds(oldPdf, m)).map(([k]) => k).join('+') || 'none');
out('new_markers', [MARK.exif, MARK.xmp, MARK.iptc].filter((m) => holds(pdf, m)).length);
// Location by name, anywhere in the PDF: EXIF/XMP GPS tags and IPTC's location fields.
out('new_location_fields', ['GPSLatitude', 'GPSLongitude', 'exif:GPS', 'photoshop:City', 'Iptc4xmpCore:Location'].filter((m) => holds(pdf, m)).length);
out('old_location_fields', ['GPSLatitude', 'GPSLongitude', 'exif:GPS', 'photoshop:City', 'Iptc4xmpCore:Location'].filter((m) => holds(oldPdf, m)).length);
