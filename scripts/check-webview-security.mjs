import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { exit, stderr, stdout } from "node:process";

const bundlePath = resolve("out/webview/main.js");
const bundle = await readFile(bundlePath, "utf8");

const forbiddenPatterns = [
  { name: "eval呼び出し", pattern: /\beval\s*\(/ },
  { name: "new Function", pattern: /\bnew\s+Function\s*\(/ },
  { name: "javascript URI", pattern: /javascript\s*:/i },
];

const allowedNamespaceUrls = new Set([
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
]);
const externalUrls = [...bundle.matchAll(/https?:\/\/[^\s"'`]+/gi)].map(([url]) => url);
const violations = forbiddenPatterns
  .filter(({ pattern }) => pattern.test(bundle))
  .map(({ name }) => name);

if (externalUrls.some((url) => !allowedNamespaceUrls.has(url))) {
  violations.push("外部HTTP URL");
}

if (violations.length > 0) {
  stderr.write(`Webview bundle security check failed: ${violations.join(", ")}\n`);
  exit(1);
} else {
  stdout.write("Webview bundle security check passed.\n");
}
