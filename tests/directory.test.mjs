import test from "node:test";
import assert from "node:assert/strict";
import { recoverAudioDirectory } from "../dist/directory.js";
import { encodePcm8Wav } from "../dist/wav.js";

test("recovers a zero-size named entry and a missing bound slot using reads only", async () => {
  const wav = encodePcm8Wav(new Float32Array(8));
  const reads = [];
  const device = { async getAudioFileContent(index) { reads.push(index); return wav; } };
  const original = { storageCapacityKb: 100, fileLimit: 3, validCount: 1, volume: 4, files: [{ index: 0, name: "hey", size: 0, checksum: 0 }] };
  const recovered = await recoverAudioDirectory(device, original, [0, 1, 1, 255]);
  assert.deepEqual(reads, [0, 1]);
  assert.equal(recovered.files.length, 2);
  assert.equal(recovered.files[0].name, "hey");
  assert.equal(recovered.files[0].size, wav.length);
  assert.equal(recovered.files[0].recovered, true);
  assert.equal(original.files[0].size, 0);
});

test("leaves valid directory entries alone without fetching audio", async () => {
  const device = { async getAudioFileContent() { assert.fail("unnecessary read"); } };
  const directory = { fileLimit: 3, files: [{ index: 0, name: "hey", size: 100, checksum: 7 }] };
  const result = await recoverAudioDirectory(device, directory, [0, 255]);
  assert.deepEqual(result.files, directory.files);
});

test("does not invent a file when an unlisted bound slot cannot be read", async () => {
  const device = { async getAudioFileContent() { throw new Error("unavailable"); } };
  const result = await recoverAudioDirectory(device, { fileLimit: 3, files: [] }, [0]);
  assert.equal(result.files.length, 0);
  assert.equal(result.warnings.length, 1);
});
