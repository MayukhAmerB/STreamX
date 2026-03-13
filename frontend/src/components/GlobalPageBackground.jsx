import { Suspense, lazy, useEffect, useState } from "react";

const Beams = lazy(() => import("./Beams"));
const BEAM_ROTATION = 30;

export default function GlobalPageBackground() {
  const [enableBeams, setEnableBeams] = useState(false);
  const [beamQuality, setBeamQuality] = useState("low");
  const [showSideBeams, setShowSideBeams] = useState(false);
  const fallbackBeamBackground =
    "h-full w-full bg-[radial-gradient(80%_80%_at_70%_20%,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.04)_35%,rgba(0,0,0,0)_70%)]";

  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return undefined;

    const reducedMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
    const saveData = navigator.connection?.saveData === true;
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    const viewportWidth = window.innerWidth || 1024;
    const forceStaticBackground = saveData || reducedMotion;

    if (forceStaticBackground) {
      setEnableBeams(false);
      setBeamQuality("low");
      setShowSideBeams(false);
      return undefined;
    }

    // Keep beams enabled by default and tune quality instead of hard-disabling on narrower devices.
    setEnableBeams(true);
    if (cores >= 8 && memory >= 8 && viewportWidth >= 1400) {
      setBeamQuality("high");
      setShowSideBeams(true);
    } else if (cores >= 6 && memory >= 6 && viewportWidth >= 1024) {
      setBeamQuality("medium");
      setShowSideBeams(false);
    } else {
      setBeamQuality("low");
      setShowSideBeams(false);
    }

    let idleHandle;
    let timeoutHandle;
    let cancelled = false;

    const mountBeams = () => {
      if (!cancelled) setEnableBeams(true);
    };

    if ("requestIdleCallback" in window) {
      idleHandle = window.requestIdleCallback(mountBeams, { timeout: 1500 });
    } else {
      timeoutHandle = window.setTimeout(mountBeams, 450);
    }

    return () => {
      cancelled = true;
      if (idleHandle && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle) {
        window.clearTimeout(timeoutHandle);
      }
    };
  }, []);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="absolute inset-0 bg-black" />
      <div className="absolute inset-0 opacity-[0.5]">
        {enableBeams ? (
          <Suspense fallback={<div className={fallbackBeamBackground} />}>
            <Beams
              beamWidth={3}
              beamHeight={30}
              beamNumber={16}
              lightColor="#fff6d8"
              speed={2}
              noiseIntensity={1.75}
              scale={0.2}
              rotation={BEAM_ROTATION}
              quality={beamQuality}
            />
          </Suspense>
        ) : (
          <div className={fallbackBeamBackground} />
        )}
      </div>
      {enableBeams && showSideBeams ? (
        <>
          <div className="absolute inset-y-0 right-0 hidden w-[22vw] max-w-[330px] overflow-hidden opacity-[0.58] xl:block">
            <Beams
              beamWidth={2.6}
              beamHeight={30}
              beamNumber={10}
              lightColor="#fff6d8"
              speed={1.8}
              noiseIntensity={1.4}
              scale={0.16}
              rotation={BEAM_ROTATION}
              quality="low"
            />
            <div className="absolute inset-0 bg-[linear-gradient(270deg,rgba(0,0,0,0.05)_0%,rgba(0,0,0,0.56)_100%)]" />
          </div>
        </>
      ) : null}
      <div className="absolute inset-0 bg-[radial-gradient(92%_82%_at_100%_0%,rgba(255,255,255,0.24)_0%,rgba(255,255,255,0.11)_24%,rgba(255,255,255,0.045)_42%,rgba(255,255,255,0)_68%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(0,0,0,0)_58%,rgba(255,255,255,0.02)_76%,rgba(255,255,255,0.07)_100%)]" />
    </div>
  );
}
