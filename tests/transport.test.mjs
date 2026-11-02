import test from "node:test";
import assert from "node:assert/strict";
import { IpiAudioDevice, packetChecksum } from "../dist/protocol.js";

// Device-side response fixtures follow the official driver's long response layout.
function responsePacket(total, index, value) {
  const frame = new Uint8Array(63);
  frame.set([0x49, 1, 0x10, total & 0xff, index & 0xff,
    ((total >>> 8) << 4) | (index >>> 8), 1, value]);
  frame[8] = packetChecksum(frame.slice(0, 8));
  return frame;
}

function errorResponse() {
  const frame = new Uint8Array(63);
  frame.set([0x49, 1, 0, 0x80, 0xfc]);
  frame[5] = packetChecksum(frame.slice(0, 5));
  return frame;
}

for (const total of [2, 257]) {
  test(`reads all ${total} audio packets using sequential continuation indices`, async () => {
    let client;
    let expectedIndex = 0;
    const requested = [];
    const fakeHid = {
      async sendReport(reportId, data) {
        assert.equal(reportId, 8);
        assert.equal(data.length, 63);
        const payload = data.slice(4, 4 + data[3]);
        const index = payload.length === 0 ? 0 : payload.length === 1 ? payload[0] : (payload[0] << 8) | payload[1];
        requested.push(index);
        const valid = index === expectedIndex && (index === 0 || payload.length === (total > 255 ? 2 : 1));
        const response = valid ? responsePacket(total, index, index & 0xff) : errorResponse();
        if (valid) expectedIndex += 1;
        queueMicrotask(() => client.onInput({ reportId: 8, data: new DataView(response.buffer) }));
      }
    };
    client = new IpiAudioDevice(fakeHid, { retries: 0, timeoutMs: 100 });
    client.outputBytes = 63;
    client.packageSize = 64;
    const bytes = await client.getAudioFileContent(1);
    assert.deepEqual([...bytes], Array.from({ length: total }, (_, index) => index & 0xff));
    assert.deepEqual(requested, Array.from({ length: total }, (_, index) => index));
  });
}

function bindingClient({ refuseChanges = false, linkedBindings = false } = {}) {
  let client;
  const bindings = [255, 255];
  const writes = [];
  const fakeHid = {
    async sendReport(reportId, data) {
      const frame = new Uint8Array(63);
      const [main, sub, flags] = data;
      if (main === 0x4e) {
        assert.ok(sub === 0 || sub === 1);
        writes.push([sub, data[4]]);
        if (!refuseChanges) bindings[sub] = data[4];
        if (linkedBindings && !refuseChanges) bindings[1 - sub] = data[4];
        frame.set([main, sub, flags, 0x80, 0]);
        frame[5] = packetChecksum(frame.slice(0, 5));
      } else {
        assert.equal(main, 0x4d);
        frame.set([main, sub, flags, 1, bindings[sub]]);
        frame[5] = packetChecksum(frame.slice(0, 5));
      }
      queueMicrotask(() => client.onInput({ reportId, data: new DataView(frame.buffer) }));
    }
  };
  client = new IpiAudioDevice(fakeHid, { retries: 0, timeoutMs: 100 });
  client.outputBytes = 63;
  client.packageSize = 64;
  return { client, bindings, writes };
}

test("left and right select one independent slot, replace the old selection, and can be disabled", async () => {
  const { client, bindings, writes } = bindingClient();
  assert.deepEqual(await client.applyAudioBinding(2, 1), { left: 1, right: 255 });
  assert.deepEqual(await client.applyAudioBinding(3, 2), { left: 1, right: 2 });
  assert.deepEqual(await client.applyAudioBinding(2, 0), { left: 0, right: 2 });
  assert.deepEqual(bindings, [0, 2]);
  assert.deepEqual(await client.applyAudioBinding(2, 255), { left: 255, right: 2 });
  assert.deepEqual(bindings, [255, 2]);
  assert.deepEqual(writes, [[0, 1], [1, 2], [0, 0], [0, 255]]);
});

test("an ACK is not treated as applied when the device returns a different binding", async () => {
  const { client } = bindingClient({ refuseChanges: true });
  await assert.rejects(client.applyAudioBinding(2, 1), /回读不一致/);
});

test("detects firmware that changes both keys and reports actual settings instead of false independence", async () => {
  const { client, writes } = bindingClient({ linkedBindings: true });
  await assert.rejects(client.applyAudioBinding(2, 1), (error) => {
    assert.equal(error.code, "AUDIO_BINDING_LINKED");
    assert.deepEqual(error.bindings, { left: 1, right: 1 });
    return true;
  });
  assert.deepEqual(writes, [[0, 1]]);
});
