import { MAX_ATTACHMENT_IMAGE_URL } from "./wire/protocol/attachments";

export const imageFromCanvas = (canvas: HTMLCanvasElement): string => {
  for (const quality of [0.9, 0.75, 0.55]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.length <= MAX_ATTACHMENT_IMAGE_URL) return url;
  }
  throw new Error("This image is too detailed for one attachment. Try a smaller image.");
};

export const prepareImage = async (file: File): Promise<string> => {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image previews are unavailable in this browser.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // Keep small lossless screenshots; JPEG bounds larger photographs.
    const png = canvas.toDataURL("image/png");
    return png.length <= MAX_ATTACHMENT_IMAGE_URL ? png : imageFromCanvas(canvas);
  } finally { bitmap.close(); }
};
