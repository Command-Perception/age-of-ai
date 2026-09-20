import { useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

export const InlineError = ({ children, className = "", message }: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly message: string;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div role="alert" className={`flex items-start gap-2 rounded-[8px] border border-destructive bg-destructive/20 px-3 py-2 text-sm text-foreground ${className}`}>
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {children}
      <button
        type="button"
        aria-label={copied ? "Error details copied" : "Copy error details"}
        title="Copy error details"
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[6px] text-foreground/80 transition-standard hover:bg-foreground/10 hover:text-foreground focus-ring"
        onClick={() => {
          void navigator.clipboard.writeText(message)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {copied
          ? <CheckIcon aria-hidden="true" className="size-4" />
          : <CopyIcon aria-hidden="true" className="size-4" />}
      </button>
    </div>
  );
};
