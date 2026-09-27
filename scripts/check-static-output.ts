import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const outputDirectory = join(process.cwd(), "dist");

function htmlFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.isFile() && entry.name.endsWith(".html") ? [path] : [];
  });
}

const pages = htmlFiles(outputDirectory);
if (pages.length === 0) {
  throw new Error("No generated HTML files found. Run `bun run build` first.");
}

const violations: string[] = [];
for (const path of pages) {
  const html = readFileSync(path, "utf8");
  const inlineScriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes ?? ""));
  if (inlineScriptTags.length > 0) violations.push(`${path}: inline script tag`);
  if (/<style\b/i.test(html)) violations.push(`${path}: inline style element`);
  if (/\sstyle\s*=/i.test(html)) violations.push(`${path}: inline style attribute`);
  if (/\son[a-z]+\s*=/i.test(html)) violations.push(`${path}: inline event handler`);
}

if (violations.length > 0) {
  throw new Error(`Generated HTML is incompatible with the self-only CSP:\n${violations.join("\n")}`);
}

console.log(`Checked ${pages.length} generated HTML pages: no inline scripts, styles, or event handlers.`);
