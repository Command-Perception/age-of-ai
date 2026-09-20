import { toast } from "sonner";
import { createElement, type ReactNode } from "react";
import { ErrorToast } from "../components/error-toast.tsx";

export const AUTO_DISMISS_TOAST_DURATION_MS = 4_000;

export const dismissNotification = (id: string) => toast.dismiss(id);

const autoDismissDuration = (duration: number | undefined) =>
  duration !== undefined && Number.isFinite(duration) && duration > 0
    ? duration
    : AUTO_DISMISS_TOAST_DURATION_MS;

export const notify = ({
  action,
  body,
  closeButton,
  duration,
  id,
  type = "info",
}: {
  readonly action?: { readonly label: ReactNode; readonly onClick: () => void };
  readonly body: string;
  readonly closeButton?: boolean;
  readonly duration?: number;
  readonly id?: string;
  readonly type?: "error" | "info";
}) => {
  const options = {
    // Errors must remain available for their details/copy action. Every other
    // notification—including ones with an Undo action—must eventually close.
    duration: type === "error" ? Infinity : autoDismissDuration(duration),
    ...(action === undefined ? {} : { action }),
    ...(closeButton === undefined ? {} : { closeButton }),
    ...(id === undefined ? {} : { id }),
  };
  const toastId =
    type === "error" ? toast.error(body, options) : toast(body, options);
  return () => toast.dismiss(toastId);
};

export const notifyError = (error: unknown, id = "api-error") => {
  const message = error instanceof Error ? error.message : String(error);
  const accountStatus = /^Account request failed \((\d{3})\):/.exec(
    message,
  )?.[1];
  const appRequiredMessage = /"code":"app_required","message":"([^"]+)"/.exec(
    message,
  )?.[1];
  const body =
    accountStatus === "401"
      ? "Email or password is incorrect. Check your details and try again."
      : accountStatus !== undefined
        ? "Your account request could not be completed. Try again."
        : message.startsWith("Request failed (401)")
          ? "The shared local Admin credential is not accepted. Restart the local Worker so it loads apps/worker/.env."
          : appRequiredMessage !== undefined
            ? appRequiredMessage
            : message === "Failed to fetch"
              ? "Can’t reach Vowel. Confirm the local control-plane service is running, then try again."
              : message;
  const toastId = toast.custom(
    (id) =>
      createElement(ErrorToast, {
        details: message,
        message: body,
        toastId: id,
      }),
    {
      className: "vowel-error-toast-shell",
      duration: Infinity,
      id,
    },
  );
  return () => toast.dismiss(toastId);
};
