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
    let glyphNodes = [];
    let reducedMotion = false;
    let isVisible = true;
    let lastFrameTime = 0;
    let frameIntervalMs = 1000 / 30;

    if (typeof window !== "undefined" && window.matchMedia) {
      reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }
    if (typeof document !== "undefined") {
      isVisible = document.visibilityState !== "hidden";
    }
    if (reducedMotion) {
      frameIntervalMs = 1000 / 12;
    }

    const createGlyphNodes = () => {
      const area = width * height;
      const count = clamp(Math.floor(area / 22000), 40, 180);
      glyphNodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        driftX: (Math.random() * 2 - 1) * 18,
        driftY: (Math.random() * 2 - 1) * 14,
        speed: 0.2 + Math.random() * 0.6,
        phase: Math.random() * Math.PI * 2,
        glyphIndex: Math.floor(Math.random() * GLYPHS.length),
        size: Math.max(10, Math.floor(cell * (0.26 + Math.random() * 0.2))),
      }));
    };

    const drawGrid = (t) => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);

      ctx.textBaseline = "middle";

      for (const node of glyphNodes) {
        const wobbleX = Math.sin(t * node.speed + node.phase) * node.driftX;
        const wobbleY = Math.cos(t * (node.speed * 1.18) + node.phase * 0.8) * node.driftY;
        let x = node.x + wobbleX;
        let y = node.y + wobbleY;
        if (x < -24) x += width + 48;
        if (x > width + 24) x -= width + 48;
        if (y < -24) y += height + 48;
        if (y > height + 24) y -= height + 48;

        const flicker = Math.sin(t * 2.2 + node.phase * 1.3) * 0.5 + 0.5;
        const alpha = 0.14 + flicker * 0.38;
        const glyphStep = Math.floor(t * 10 * node.speed);
        const glyph = GLYPHS[(node.glyphIndex + glyphStep) % GLYPHS.length];

        ctx.font = `${node.size}px Inter, "Segoe UI", Arial, sans-serif`;
        ctx.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.fillText(glyph, x, y);

        if (flicker > 0.84) {
          ctx.fillStyle = "rgba(255,255,255,0.18)";
          ctx.fillText(
            GLYPHS[(node.glyphIndex + glyphStep + 13) % GLYPHS.length],
            x + node.size * 0.46,
            y + node.size * 0.24
          );
        }
      }
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.75);
      width = Math.max(window.innerWidth, 1);
      height = Math.max(window.innerHeight, 1);
      cell = clamp(Math.floor(width / 44), 28, 42);
      createGlyphNodes();
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    </div>
  );
}
