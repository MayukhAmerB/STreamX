import { lazy, Suspense } from "react";

import LandingPageV2 from "./landing/LandingPageV2";
import { isLandingV2Enabled } from "./landing/landingFlag";

// Rollback path (plan Phase 1A): VITE_LANDING_V2=off serves the previous
// design. It is a separate chunk, so the default page never downloads it.
const LandingPageV1 = lazy(() => import("./landing/LandingPageV1"));

const LANDING_V2 = isLandingV2Enabled(import.meta.env.VITE_LANDING_V2);

export default function LandingPage() {
  if (LANDING_V2) return <LandingPageV2 />;
  return (
    <Suspense fallback={null}>
      <LandingPageV1 />
    </Suspense>
  );
}
