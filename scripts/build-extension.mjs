import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/extension/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  outfile: "out/extension/extension.js",
  platform: "node",
  sourcemap: true,
  target: "node20",
});
