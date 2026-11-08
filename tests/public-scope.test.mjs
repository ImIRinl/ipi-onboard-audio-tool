import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dual-key UI is firmware-gated and all static ID references exist", () => {
  const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
  assert.ok(html.includes('id="apply-left"'));
  assert.ok(html.includes('id="apply-right"'));
  assert.ok(html.includes('id="confirm-separated-firmware" type="checkbox"'));
  assert.ok(!html.includes('id="confirm-separated-firmware" type="checkbox" checked'));
  assert.ok(html.includes("网页无法仅凭版本号识别"));
  assert.ok(app.includes("!ui.firmwareConfirmed.checked"));
  assert.ok(app.includes("state.device.applyAudioBinding(keyPos, index)"));
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  for (const match of app.matchAll(/\$\("#([^"]+)"\)/g)) assert.ok(ids.has(match[1]), `missing DOM ID: ${match[1]}`);
});

test("binding controls remain disabled without connection, firmware confirmation, or while busy", () => {
  const app = readFileSync(new URL("../dist/app.js", import.meta.url), "utf8");
  const definition = app.slice(app.indexOf("function updateBindingControls()"), app.indexOf("function log("));
  for (const connected of [false, true]) for (const checked of [false, true]) for (const busy of [false, true]) for (const hasDevice of [false, true]) {
    const state = { connected, busy, device: hasDevice ? {} : null };
    const cards = [{}, {}];
    const ui = { firmwareConfirmed: { checked }, leftAudio: {}, rightAudio: {}, applyLeft: {}, applyRight: {}, library: { querySelectorAll: () => cards } };
    const update = new Function("state", "ui", definition + "; return updateBindingControls;")(state, ui);
    update();
    const disabled = !connected || !checked || busy || !hasDevice;
    for (const control of [ui.leftAudio, ui.rightAudio, ui.applyLeft, ui.applyRight, ...cards]) assert.equal(control.disabled, disabled);
  }
  assert.ok(app.includes("ui.firmwareConfirmed.checked = false;"));
});
