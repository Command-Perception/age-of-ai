import { useEffect, useState } from "react";
import type { CompleteAttachment } from "@assistant-ui/react";
import { FileText, Loader2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { cn } from "./lib/utils";
import type { PendingFile } from "./attachments";

const useFileUrl = (file: File | undefined) => {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) { setUrl(undefined); return; }
    const value = URL.createObjectURL(file);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [file]);
  return url;
};

export const AttachmentPreview = ({ attachment, pending, onRemove }: {
  readonly attachment?: CompleteAttachment | undefined;
  readonly pending?: PendingFile | undefined;
  readonly onRemove?: (() => void) | undefined;
}) => {
  const [open, setOpen] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  const file = attachment?.file ?? pending?.file;
  const fileUrl = useFileUrl(file);
  const name = attachment?.name ?? file?.name ?? "Attachment";
  const type = attachment?.contentType ?? file?.type ?? "";
  const content = attachment?.content ?? [];
  const image = content.find(part => part.type === "image")?.image;
  const text = content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const isImage = type.startsWith("image/");
  const isPdf = type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
  const thumbnail = image ?? (isImage ? fileUrl : undefined);
  const fullImage = isImage ? fileUrl ?? image : image;
  return (
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setActualSize(false); }}>
      <div className="vowel-file-preview group relative flex w-14 shrink-0 flex-col items-center gap-1">
        <button type="button" aria-label={`Preview ${name}`} title={pending?.error ?? name} onClick={() => setOpen(true)}
          className={cn("flex size-12 cursor-zoom-in items-center justify-center overflow-hidden rounded-md bg-muted ring-1 ring-border focus-ring", pending?.status === "error" && "ring-destructive")}>
          {thumbnail ? <img src={thumbnail} alt={name} className="size-full object-cover" />
            : text ? <pre aria-hidden="true" className="size-full overflow-hidden p-1 text-left text-[4px] leading-tight">{text.slice(0, 500)}</pre>
              : <FileText aria-hidden="true" className="size-5 text-muted-foreground" />}
          {pending?.status === "preparing" && <Loader2 aria-label="Preparing file" className="absolute bottom-5 right-1 size-3 animate-spin" />}
        </button>
        {onRemove && <button type="button" aria-label={`Remove ${name}`} title={`Remove ${name}`} onClick={event => { event.stopPropagation(); onRemove(); }}
          className="vowel-file-clear absolute right-0 top-0 flex size-5 items-center justify-center rounded-full bg-foreground text-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-ring">
          <X aria-hidden="true" className="size-3" />
        </button>}
        <button type="button" onClick={() => setOpen(true)} className="w-full cursor-zoom-in truncate text-center text-[9px] text-muted-foreground focus-ring" title={name}>{name}</button>
      </div>
      <DialogContent className="max-h-[92dvh] gap-2 sm:max-w-4xl">
        <DialogTitle className="pr-8 break-all">{name}</DialogTitle>
        <DialogDescription>{file ? `${Math.max(1, Math.round(file.size / 1024))} KB` : "Attachment"}{isImage ? " · Click the image to switch between fit and full size." : ""}</DialogDescription>
        <div className="max-h-[75dvh] overflow-auto rounded-md bg-muted">
          {isPdf && fileUrl ? <iframe title={`Preview ${name}`} src={fileUrl} className="h-[70dvh] w-full border-0" />
            : fullImage ? <button type="button" aria-label={actualSize ? "Fit image" : "Zoom image"} onClick={() => setActualSize(value => !value)} className={cn("block min-w-full", actualSize ? "cursor-zoom-out" : "cursor-zoom-in")}>
              <img src={fullImage} alt={name} className={actualSize ? "mx-auto max-w-none" : "mx-auto max-h-[70dvh] max-w-full object-contain"} />
            </button>
              : <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs">{text || pending?.error || "Preparing preview…"}</pre>}
        </div>
      </DialogContent>
    </Dialog>
  );
};
