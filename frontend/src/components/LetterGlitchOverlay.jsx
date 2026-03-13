import { useEffect, useRef } from "react";

const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789$#@%&*+-=<>?/\\[]{}|";

export default function LetterGlitchOverlay({
  cellSize = 30,
  fps = 18,
  baseAlpha = 0.12,
  accentAlpha = 0.22,
}) {
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
    let columns = 0;
    let rows = 0;
    let glyphMap = [];
    let frameIntervalMs = 1000 / Math.max(6, fps);
    let lastFrameTime = 0;
    let reducedMotion = false;
    let isVisible = true;

    if (typeof window !== "undefined" && window.matchMedia) {
      reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    if (typeof document !== "undefined") {
      isVisible = document.visibilityState !== "hidden";
    }
    if (reducedMotion) {
      frameIntervalMs = 1000 / 8;
    }

    const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

    const buildMap = () => {
      columns = Math.max(1, Math.ceil(width / cellSize));
      rows = Math.max(1, Math.ceil(height / cellSize));
      glyphMap = Array.from({ length: columns * rows }, () => randomGlyph());
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      width = Math.max(window.innerWidth, 1);
      height = Math.max(window.innerHeight, 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      buildMap();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${Math.max(10, Math.floor(cellSize * 0.43))}px "Courier New", Consolas, monospace`;

      // Mutate a subset for glitch effect.
      const mutateCount = Math.max(10, Math.floor(glyphMap.length * 0.08));
      for (let i = 0; i < mutateCount; i += 1) {
        const idx = Math.floor(Math.random() * glyphMap.length);
        glyphMap[idx] = randomGlyph();
      }

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          const idx = row * columns + col;
          const x = col * cellSize + cellSize * 0.5;
          const y = row * cellSize + cellSize * 0.5;

          // Keep center cleaner and push visibility to side gutters.
          const sideFactor = 1 - Math.min(1, Math.abs((x / width) * 2 - 1));
          const alpha = baseAlpha * (1 - sideFactor * 0.58);
          if (alpha <= 0.02) continue;

          ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
          ctx.fillText(glyphMap[idx], x, y);

          if (Math.random() < 0.04) {
            ctx.fillStyle = `rgba(255,255,255,${accentAlpha.toFixed(3)})`;
            ctx.fillText(glyphMap[idx], x + 1, y);
          }
        }
      }
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
      draw();
      rafId = window.requestAnimationFrame(render);
    };

    const handleVisibilityChange = () => {
      isVisible = document.visibilityState !== "hidden";
      if (isVisible) {
        lastFrameTime = 0;
      }
    };

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    rafId = window.requestAnimationFrame(render);

    return () => {
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [accentAlpha, baseAlpha, cellSize, fps]);

  return <canvas className="h-full w-full" ref={canvasRef} />;
}

