import { PrioLogo } from "@/components/brand/PrioLogo";

/** Application splash — shown while the first server render streams in. */
export default function Loading() {
  return (
    <div className="prio-splash" role="status" aria-live="polite">
      <PrioLogo
        variant="lockup"
        size="lg"
        tone="dark"
        className="prio-splash__mark"
      />
      <span className="prio-splash__bar" aria-hidden />
      <span className="prio-splash__label">Loading Prio</span>
    </div>
  );
}
