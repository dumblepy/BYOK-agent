import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/ui/main.tsx"],
  format: "iife",
  outfile: "out/webview/main.js",
  platform: "browser",
  target: "es2022",
});
