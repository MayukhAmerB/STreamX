import { lazy, Suspense } from "react";

import LandingPageHP from "./landing/LandingPageHP";
import { landingVariant } from "./landing/landingFlag";

// Rollback paths: VITE_LANDING_V2=v2 serves the previous Syed Carbon page and
// VITE_LANDING_V2=off the original one. Both are separate chunks, so the
// default page never downloads them.
const LandingPageV2 = lazy(() => import("./landing/LandingPageV2"));
const LandingPageV1 = lazy(() => import("./landing/LandingPageV1"));

const VARIANT = landingVariant(import.meta.env.VITE_LANDING_V2);

export default function LandingPage() {
  if (VARIANT === "hp") return <LandingPageHP />;
  return <Suspense fallback={null}>{VARIANT === "v2" ? <LandingPageV2 /> : <LandingPageV1 />}</Suspense>;
}
