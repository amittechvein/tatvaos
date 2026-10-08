// Receipts and report cards as PDF (FR-S06, FR-S08, SRS section 8): downloaded into the app's
// private cache, handed to the phone's viewer and share sheet, then deleted, so no school file
// stays on the phone (NF-06).
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

export async function openPdf(url: string, name: string, headers?: Record<string, string>) {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "document";
  const target = new File(Paths.cache, `${safe}.pdf`);
  const file = await File.downloadFileAsync(url, target, { headers, idempotent: true });
  try {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(file.uri, { mimeType: "application/pdf", UTI: "com.adobe.pdf", dialogTitle: name });
    }
  } finally {
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}
