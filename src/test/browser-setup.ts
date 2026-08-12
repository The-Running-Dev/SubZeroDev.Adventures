import "@testing-library/jest-dom/vitest";
import "@vitest/browser/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
// Only `main.tsx` (the production `/play/` entry) imports these normally; a
// browser-mode spec renders a component directly, so every computed-style,
// hit-area, contrast, and visual-snapshot assertion in this harness would
// otherwise measure unstyled markup instead of the shipped page.
import "../themes.css";
import "../index.css";
import "../play/play.css";

// None of these specs are about the landing wizard (PlayApp.tsx's `isOnboarding`) -- they
// mount `<PlayApp />` expecting the ordinary disk shelf or a specific story, same as
// PlayApp.test.tsx's own file-level seed. `getting-started` being hidden means it would
// otherwise auto-start ahead of every fixture in `fixtures.tsx`.
beforeEach(() => {
  localStorage.setItem("subzerodev.play.onboarding-seen.v1", "1");
});

afterEach(() => {
  cleanup();
});
