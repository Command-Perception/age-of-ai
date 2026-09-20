import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import { CopyIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

export const ErrorToast = ({
  details,
  message,
  toastId,
}: {
  readonly details: string;
  readonly message: string;
  readonly toastId: string | number;
}) => (
  <div aria-live="polite" className="vowel-error-toast" role="status">
    <p className="vowel-error-toast-message">{message}</p>
    <div className="vowel-error-toast-actions">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Copy error details"
            onClick={() => void navigator.clipboard.writeText(details)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <CopyIcon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Copy error details</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Dismiss notification"
            onClick={() => toast.dismiss(toastId)}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Dismiss notification</TooltipContent>
      </Tooltip>
    </div>
  </div>
);
