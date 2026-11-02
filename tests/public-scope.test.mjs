import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("public UI exposes one activation control and all static ID references exist", () => {
  const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
  assert.ok(html.includes("不支持左右键独立音效"));
  assert.ok(!html.includes('id="apply-right"'));
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const match of app.matchAll(/\$\("#([^"]+)"\)/g)) assert.ok(ids.has(match[1]), `missing DOM ID: ${match[1]}`);
});
