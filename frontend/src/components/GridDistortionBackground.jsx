import { useEffect, useRef } from "react";

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#@%&*+-=<>?/\\[]{}|";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export default function GridDistortionBackground() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return undefined;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let cell = 32;
    let reducedMotion = false;
    let isVisible = true;
    let lastFrameTime = 0;
    let frameIntervalMs = 1000 / 30;
    let glowA = null;
    let glowB = null;

    if (typeof window !== "undefined" && window.matchMedia) {
      reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    if (typeof document !== "undefined") {
      isVisible = document.visibilityState !== "hidden";
    }
    if (reducedMotion) {
      frameIntervalMs = 1000 / 12;
    }

    const distort = (x, y, t) => {
      const waveX = Math.sin(x * 0.012 + t * 0.9) * 4.2;
      const waveY = Math.cos(y * 0.014 - t * 0.8) * 3.8;
      const swirl = Math.sin((x + y) * 0.008 - t * 0.55) * 2.8;
      return [x + waveX + swirl, y + waveY - swirl * 0.45];
    };

    const drawGrid = (t) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#030506";
      ctx.fillRect(0, 0, width, height);

      // Soft ambient glows to avoid a flat grid look.
      ctx.fillStyle = glowA || "rgba(132, 170, 149, 0.08)";
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = glowB || "rgba(98, 132, 117, 0.08)";
      ctx.fillRect(0, 0, width, height);

      const sampleStep = Math.max(8, Math.floor(cell * 0.34));
      const maxX = width + cell * 2;
      const maxY = height + cell * 2;

      for (let y = -cell; y <= maxY; y += cell) {
        ctx.beginPath();
        let first = true;
        for (let x = -cell; x <= maxX; x += sampleStep) {
          const [dx, dy] = distort(x, y, t);
          if (first) {
            ctx.moveTo(dx, dy);
            first = false;
          } else {
            ctx.lineTo(dx, dy);
          }
        }
        const rowIndex = Math.round((y + cell) / cell);
        ctx.strokeStyle =
          rowIndex % 4 === 0 ? "rgba(182, 215, 194, 0.24)" : "rgba(123, 155, 136, 0.16)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      for (let x = -cell; x <= maxX; x += cell) {
        ctx.beginPath();
        let first = true;
        for (let y = -cell; y <= maxY; y += sampleStep) {
          const [dx, dy] = distort(x, y, t);
          if (first) {
            ctx.moveTo(dx, dy);
            first = false;
          } else {
            ctx.lineTo(dx, dy);
          }
        }
        const colIndex = Math.round((x + cell) / cell);
        ctx.strokeStyle =
          colIndex % 5 === 0 ? "rgba(175, 209, 188, 0.22)" : "rgba(113, 148, 128, 0.15)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.font = `${Math.max(9, Math.floor(cell * 0.34))}px Consolas, "Courier New", monospace`;
      ctx.textBaseline = "middle";

      for (let gy = -cell; gy <= maxY; gy += cell * 2) {
        for (let gx = -cell; gx <= maxX; gx += cell * 2) {
          const signal = Math.sin(gx * 0.018 + gy * 0.016 + t * 1.1);
          if (signal < 0.38) continue;
          const [dx, dy] = distort(gx, gy, t);
          const idx = Math.abs(Math.floor((gx * 7 + gy * 11 + t * 28))) % GLYPHS.length;
          const glyph = GLYPHS[idx];
          ctx.fillStyle = signal > 0.88 ? "rgba(190, 235, 214, 0.48)" : "rgba(132, 193, 170, 0.38)";
          ctx.fillText(glyph, dx, dy);
          if (signal > 0.7) {
            ctx.fillStyle = "rgba(106, 168, 146, 0.26)";
            ctx.fillText(GLYPHS[(idx + 17) % GLYPHS.length], dx + cell * 0.32, dy + cell * 0.26);
          }
        }
      }
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      width = Math.max(window.innerWidth, 1);
      height = Math.max(window.innerHeight, 1);
      cell = clamp(Math.floor(width / 44), 28, 42);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      glowA = ctx.createRadialGradient(width * 0.18, height * 0.12, 0, width * 0.18, height * 0.12, width * 0.6);
      glowA.addColorStop(0, "rgba(132, 170, 149, 0.18)");
      glowA.addColorStop(1, "rgba(132, 170, 149, 0)");
      glowB = ctx.createRadialGradient(width * 0.82, height * 0.86, 0, width * 0.82, height * 0.86, width * 0.54);
      glowB.addColorStop(0, "rgba(98, 132, 117, 0.18)");
      glowB.addColorStop(1, "rgba(98, 132, 117, 0)");
      drawGrid(0);
    };

    const render = (timestamp) => {
      if (!isVisible) {
        rafId = window.requestAnimationFrame(render);
        return;
      }
      if (timestamp - lastFrameTime < frameIntervalMs) {
        rafId = window.requestAnimationFrame(render);
        return;
      }
      lastFrameTime = timestamp;
      drawGrid(timestamp * 0.001);
      rafId = window.requestAnimationFrame(render);
    };

    const handleVisibilityChange = () => {
      isVisible = document.visibilityState !== "hidden";
      if (!isVisible) {
        return;
      }
      lastFrameTime = 0;
      drawGrid(performance.now() * 0.001);
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    if (!reducedMotion) {
      rafId = window.requestAnimationFrame(render);
    }

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <canvas ref={canvasRef} className="h-full w-full" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_4%,rgba(186,208,183,0.22),transparent_42%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(2,4,2,0.20),rgba(1,2,1,0.40)_62%,rgba(0,1,0,0.62))]" />
    </div>
  );
}
