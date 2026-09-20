import { TelemetryWaterfall } from "./telemetry-waterfall";

export const TelemetryPage = ({
  phase,
  onPhaseChange,
}: {
  readonly phase: string;
  readonly onPhaseChange: (phase: string) => void;
}) => (
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
    <p className="text-sm text-muted-foreground">
      Live Vowel session. Traces stay visible across reconnects and page reloads until you clear telemetry.
    </p>
    <TelemetryWaterfall
      phase={phase}
      onPhaseChange={onPhaseChange}
      empty="No turns in this session yet. Start a Vowel conversation from the sidebar to record the waterfall."
    />
  </div>
);
