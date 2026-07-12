import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["src/ui/main.tsx"],
  format: "iife",
  outfile: "out/webview/main.js",
  platform: "browser",
  target: "es2022",
});

// Copy Codicon assets (CSS + font) to out/webview/
const codiconDist = resolve("node_modules/@vscode/codicons/dist");
const webviewOut = resolve("out/webview");

await mkdir(webviewOut, { recursive: true });

await Promise.all([
  copyFile(resolve(codiconDist, "codicon.css"), resolve(webviewOut, "codicon.css")),
  copyFile(resolve(codiconDist, "codicon.ttf"), resolve(webviewOut, "codicon.ttf")),
]);
