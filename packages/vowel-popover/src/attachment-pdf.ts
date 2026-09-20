import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { MAX_ATTACHMENT_IMAGES, MAX_ATTACHMENT_TEXT, type InputAttachment } from "./wire/protocol/attachments";
import { imageFromCanvas } from "./attachment-images";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Extract digital text and retain page images for scanned pages and the cover preview. */
export const preparePdf = async (file: File): Promise<InputAttachment["content"]> => {
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), enableXfa: false });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 20) throw new Error("PDFs can contain up to twenty pages. Attach a shorter excerpt.");
    const content: Array<InputAttachment["content"][number]> = [];
    let text = "";
    let images = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const extracted = await page.getTextContent();
      const pageText = extracted.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
      text += `\n[Page ${number}]\n${pageText}\n`;
      if (text.length > MAX_ATTACHMENT_TEXT) throw new Error("This PDF contains too much text. Attach a shorter excerpt.");
      if (number === 1 || pageText.length < 40) {
        if (++images > MAX_ATTACHMENT_IMAGES) throw new Error("Scanned PDFs can contain up to four pages. Attach a shorter excerpt.");
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, 1800 / Math.max(original.width, original.height)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, viewport, background: "white" }).promise;
        content.push({ type: "image", data_url: imageFromCanvas(canvas) });
      }
      page.cleanup();
    }
    return [{ type: "text", text: text.trim() }, ...content];
  } finally { await task.destroy(); }
};
