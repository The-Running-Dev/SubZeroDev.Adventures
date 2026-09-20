import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Issue #71: GitHub never raises `pull_request` or `push` for a commit pushed with the
// default GITHUB_TOKEN, so a commit made that way is invisible to CI -- no runtime
// behaviour to assert, only the workflow's own shape. This checks that the checkout step
// (whose token the later `git push` inherits) authenticates with something other than the
// implicit default token, before that push ever runs.
//
// Resolved via path.dirname/join rather than `new URL("./x", import.meta.url)` -- the
// suite's default jsdom environment (vite.config.ts) resolves that two-argument form
// against a fake http://localhost:3000/ origin instead of this file's real path.
describe("update-visual-baselines workflow", () => {
  const workflow = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "update-visual-baselines.yml"),
    "utf-8",
  );

  it("checks out with a token other than the implicit default GITHUB_TOKEN", () => {
    const checkoutStep = workflow.match(
      /- name: Checkout \(with submodules\)[\s\S]*?- name: Setup Node/,
    )?.[0];
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep).toMatch(/token:\s*\$\{\{\s*secrets\.BASELINE_UPDATE_TOKEN\b/);
  });
});
