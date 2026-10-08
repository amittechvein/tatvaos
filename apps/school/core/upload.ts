// Files the student sends (assignment answers; SRS section 8, "Files and camera"): a photo from
// the camera or gallery is shrunk on the phone to at most 1600 px and about 1 MB before upload;
// a PDF is sent as it is, up to the website's limit. The camera is asked for only when used.
import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as DocumentPicker from "expo-document-picker";

export type PickedFile = { uri: string; name: string; type: string; size?: number };

const MAX_SIDE = 1600;
const TARGET_BYTES = 1_000_000;
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

async function shrink(asset: ImagePicker.ImagePickerAsset): Promise<PickedFile> {
  const w = asset.width || MAX_SIDE;
  const h = asset.height || MAX_SIDE;
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  let quality = 0.8;
  let out = await ImageManipulator.manipulateAsync(asset.uri, scale < 1 ? [{ resize: { width: Math.round(w * scale) } }] : [], {
    compress: quality,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  // lower the quality until it is about 1 MB (a few steps at most)
  for (let i = 0; i < 3; i++) {
    const size = (await fetch(out.uri).then((r) => r.blob())).size;
    if (size <= TARGET_BYTES) break;
    quality -= 0.2;
    out = await ImageManipulator.manipulateAsync(out.uri, [], { compress: Math.max(0.3, quality), format: ImageManipulator.SaveFormat.JPEG });
  }
  return { uri: out.uri, name: `photo-${Date.now()}.jpg`, type: "image/jpeg" };
}

/** A photo from the camera or the gallery, shrunk; null when the person cancelled or refused access. */
export async function pickPhoto(from: "camera" | "gallery"): Promise<PickedFile | null> {
  const perm = from === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, allowsEditing: false };
  const r = from === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
  if (r.canceled || !r.assets?.[0]) return null;
  return shrink(r.assets[0]);
}

/** A PDF from the phone's files; null when cancelled. Throws "too-big" over the limit. */
export async function pickPdf(): Promise<PickedFile | null> {
  const r = await DocumentPicker.getDocumentAsync({ type: "application/pdf", copyToCacheDirectory: true, multiple: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  if (a.size && a.size > MAX_PDF_BYTES) throw new Error("too-big");
  return { uri: a.uri, name: a.name || `file-${Date.now()}.pdf`, type: "application/pdf", size: a.size };
}
