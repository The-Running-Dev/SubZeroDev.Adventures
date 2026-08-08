import { access, readdir, readFile } from "node:fs/promises";

const html = await readFile(
  new URL("../dist/index.html", import.meta.url),
  "utf8",
);

const requiredAssets = [
  "og-image.png",
  "favicon.svg",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
];

for (const asset of requiredAssets) {
  await access(new URL(`../dist/${asset}`, import.meta.url)).catch(() => {
    throw new Error(`Built output is missing referenced asset: ${asset}`);
  });
}

const requiredTags = [
  /<meta\s+name="description"\s+content="Play deterministic story campaigns in your browser, powered by SubZeroDev Game Engine\."\s*\/>/,
  /<meta\s+property="og:title"\s+content="SubZeroDev Adventures"\s*\/>/,
  /<meta\s+property="og:type"\s+content="website"\s*\/>/,
  /<meta\s+property="og:url"\s+content="https:\/\/adventures\.subzerodev\.com\/"\s*\/>/,
  /<meta\s+property="og:image"\s+content="https:\/\/adventures\.subzerodev\.com\/og-image\.png"\s*\/>/,
  /<link\s+rel="canonical"\s+href="https:\/\/adventures\.subzerodev\.com\/"\s*\/>/,
  /<meta\s+name="twitter:card"\s+content="summary_large_image"\s*\/>/,
  /<meta\s+name="twitter:image"\s+content="https:\/\/adventures\.subzerodev\.com\/og-image\.png"\s*\/>/,
  /<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg"\s*\/>/,
  /<script type="module" crossorigin src="\/assets\//,
];

for (const tag of requiredTags) {
  if (!tag.test(html)) {
    throw new Error(
      `Built HTML is missing required static metadata: ${tag.source}`,
    );
  }
}

if (/\/src\//.test(html)) {
  throw new Error("Built HTML references a development-only source path.");
}

// 13-playable-web-demo.md §4 in the engine repo: browser portability is an engine property,
// and the gate for it is an assertion over the emitted bundle -- not the build having
// succeeded. This repo depends on the engine by a submodule path, so an engine change can
// reintroduce a Node-only import; "the bundler would have complained" is the same class of
// claim that doc already rejects for typechecking.
const assetsDir = new URL("../dist/assets/", import.meta.url);
const bundles = (await readdir(assetsDir)).filter((name) =>
  name.endsWith(".js"),
);

if (bundles.length === 0)
  throw new Error("Built output contains no JavaScript bundle to verify.");

const nodeOnlyPatterns = [
  /\bfrom\s*["']node:/,
  /\brequire\(\s*["']node:/,
  /\bimport\(\s*["']node:/,
  /\b__dirname\b/,
  /\b__filename\b/,
];

for (const bundle of bundles) {
  const code = await readFile(new URL(bundle, assetsDir), "utf8");
  for (const pattern of nodeOnlyPatterns) {
    if (pattern.test(code))
      throw new Error(
        `Built bundle assets/${bundle} reaches a Node-only runtime (${pattern.source}). ` +
          "The browser entry point must contain no node: import and no unguarded Node global.",
      );
  }
}

console.log(
  `The built HTML entry point contains its required static metadata, and ${bundles.length} bundle(s) are free of Node-only runtime references.`,
);
