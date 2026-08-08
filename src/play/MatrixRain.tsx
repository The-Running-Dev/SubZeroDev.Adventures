import { useEffect, useRef } from "react";

const GLYPHS = "01";
const FONT_SIZE = 16;
const FRAME_INTERVAL_MS = 50;

/**
 * A fixed, page-level backdrop -- outside the RTL container the visual
 * baseline captures screenshot, so it never touches those PNGs regardless of
 * theme. Mounted only while the Matrix theme is active; returns nothing under
 * reduced motion, mirroring the existing `prefers-reduced-motion` idiom in
 * `PlayApp.tsx`.
 */
export function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let columns = 0;
    let drops: number[] = [];

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      columns = Math.ceil(canvas.width / FONT_SIZE);
      drops = new Array<number>(columns).fill(0).map(() => Math.random() * -50);
    }

    resize();
    window.addEventListener("resize", resize);

    let lastFrame = 0;
    let frameHandle = 0;

    function draw(timestamp: number) {
      frameHandle = requestAnimationFrame(draw);
      if (timestamp - lastFrame < FRAME_INTERVAL_MS) return;
      lastFrame = timestamp;
      if (!ctx || !canvas) return;

      ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.font = `${FONT_SIZE}px monospace`;

      for (let column = 0; column < columns; column += 1) {
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        const x = column * FONT_SIZE;
        const y = drops[column]! * FONT_SIZE;

        ctx.fillStyle = "#c8ffc8";
        ctx.fillText(glyph!, x, y);
        ctx.fillStyle = "#00ff41";
        ctx.fillText(glyph!, x, y - FONT_SIZE);

        if (y > canvas.height && Math.random() > 0.975) {
          drops[column] = 0;
        }
        drops[column] += 1;
      }
    }

    frameHandle = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frameHandle);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="matrix-rain" aria-hidden="true" />;
}
