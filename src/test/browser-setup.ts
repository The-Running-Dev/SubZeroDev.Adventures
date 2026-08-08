import "@testing-library/jest-dom/vitest";
import "@vitest/browser/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
// Only `main.tsx` (the production `/play/` entry) imports these normally; a
// browser-mode spec renders a component directly, so every computed-style,
// hit-area, contrast, and visual-snapshot assertion in this harness would
// otherwise measure unstyled markup instead of the shipped page.
import "../index.css";
import "../site.css";
import "../play/play.css";

afterEach(() => {
  cleanup();
});
