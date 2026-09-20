/** Keep graph updates and storage serialization outside audio message handlers. */
export const telemetryPublisher = (notify: () => void, persist: () => void) => {
  let notification: ReturnType<typeof setTimeout> | undefined;
  let persistence: ReturnType<typeof setTimeout> | undefined;
  return (save = true) => {
    notification ??= setTimeout(() => {
      notification = undefined;
      notify();
    }, 100);
    if (save) persistence ??= setTimeout(() => {
      persistence = undefined;
      persist();
    }, 1000);
  };
};
