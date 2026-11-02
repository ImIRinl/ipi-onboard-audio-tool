import test from "node:test";
import assert from "node:assert/strict";
import { audioChecksum, buildCommandPackets, decodeAudioMeta, encodeAudioMeta, packetChecksum, parseAudioFileList } from "../dist/protocol.js";
import { encodePcm8Wav, inspectWav } from "../dist/wav.js";

test("packet checksum includes report ID", () => {
  assert.equal(packetChecksum(Uint8Array.of(0x4c, 0xf0, 0, 1, 5)), 0xb5);
});

test("short command packet matches protocol framing", () => {
  const [packet] = buildCommandPackets(0x4c, 0xf0, Uint8Array.of(5), 17, 0);
  assert.deepEqual([...packet], [0x4c, 0xf0, 0, 1, 5, 0xb5]);
});

test("long command packet is split and indexed", () => {
  const packets = buildCommandPackets(0x4a, 2, new Uint8Array(20).fill(7), 17, 1);
  assert.equal(packets.length, 3);
  assert.equal(packets[0][2], 0x11);
  assert.equal(packets[0][3], 3);
  assert.equal(packets[2][4], 2);
});

test("audio metadata is 24 bytes with uint24 size and checksum", () => {
  const data = Uint8Array.of(1, 2, 3, 4);
  const meta = encodeAudioMeta("提示音", data);
  const decoded = decodeAudioMeta(meta, 3);
  assert.equal(meta.length, 24);
  assert.equal(decoded.name, "提示音");
  assert.equal(decoded.size, 4);
  assert.equal(decoded.checksum, audioChecksum(data));
  assert.deepEqual([...meta.slice(16, 19)], [0, 0, 0]);
  assert.deepEqual([...meta.slice(19, 22)], [0, 0, 4]);
});

test("decodes an independent official-layout directory fixture with size at offset 19", () => {
  const entry = Uint8Array.from([
    3, 0x68, 0x65, 0x79, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0x01, 0x23, 0x45, 0x7e, 0
  ]);
  const payload = new Uint8Array(32);
  payload.set([100, 3, 1, 4]);
  payload.set(entry, 8);
  const directory = parseAudioFileList(payload);
  assert.deepEqual(directory.files, [{ index: 0, name: "hey", size: 0x012345, checksum: 0x7e }]);
});

test("keeps a named zero-size entry for read-only recovery instead of displaying an empty library", () => {
  const payload = new Uint8Array(32);
  payload.set([100, 3, 1, 4]);
  payload.set([3, 0x68, 0x65, 0x79], 8);
  const directory = parseAudioFileList(payload);
  assert.equal(directory.files.length, 1);
  assert.equal(directory.files[0].name, "hey");
  assert.equal(directory.files[0].size, 0);
});

test("audio file list parser reads header and entries", () => {
  const payload = new Uint8Array(32);
  payload.set([100, 3, 1, 4], 0);
  payload.set(encodeAudioMeta("tone", Uint8Array.of(8, 9)), 8);
  const parsed = parseAudioFileList(payload);
  assert.equal(parsed.storageCapacityKb, 100);
  assert.equal(parsed.fileLimit, 3);
  assert.equal(parsed.volume, 4);
  assert.equal(parsed.files[0].name, "tone");
});

test("generated device WAV is 8kHz 8-bit mono PCM", () => {
  const wav = encodePcm8Wav(Float32Array.of(-1, 0, 1));
  const info = inspectWav(wav);
  assert.deepEqual({ format: info.audioFormat, channels: info.channels, rate: info.sampleRate, bits: info.bitsPerSample }, { format: 1, channels: 1, rate: 8000, bits: 8 });
  assert.deepEqual([...wav.slice(44)], [0, 128, 255]);
});
