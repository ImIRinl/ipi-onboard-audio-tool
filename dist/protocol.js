const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: false });

export const IPI_USB_IDS = Object.freeze({ vendorId: 0x372e, wiredProductId: 0x10f8, wirelessProductId: 0x10f9 });
export const IPI_HID = Object.freeze({ usagePage: 0xff04, usage: 1, reportId: 8 });

export function packetChecksum(bytes, reportId = IPI_HID.reportId) {
  let sum = reportId;
  for (const value of bytes) sum = (sum + value) & 0xff;
  return (0xff - sum) & 0xff;
}

export function audioChecksum(bytes) {
  let sum = 0;
  for (const value of bytes) sum = (sum + value) & 0xff;
  return (0xff - sum) & 0xff;
}

export function encodeAudioMeta(name, bytes) {
  const safeName = String(name || "").trim();
  const encodedName = textEncoder.encode(safeName);
  if (!encodedName.length || encodedName.length > 15) throw new Error("名称必须为 1–15 个 UTF-8 字节");
  if (!bytes?.length || bytes.length > 0xffffff) throw new Error("音频大小必须在 1–16777215 字节之间");
  const meta = new Uint8Array(24);
  meta[0] = encodedName.length;
  meta.set(encodedName, 1);
  meta[19] = (bytes.length >>> 16) & 0xff;
  meta[20] = (bytes.length >>> 8) & 0xff;
  meta[21] = bytes.length & 0xff;
  meta[22] = audioChecksum(bytes);
  return meta;
}

export function decodeAudioMeta(meta, index = 0) {
  if (meta.length < 24) throw new Error("音频目录项长度异常");
  const nameLength = Math.min(meta[0], 15);
  const size = (meta[19] << 16) | (meta[20] << 8) | meta[21];
  return {
    index,
    name: textDecoder.decode(meta.slice(1, 1 + nameLength)),
    size,
    checksum: meta[22]
  };
}

export function parseAudioFileList(payload) {
  if (payload.length < 8) throw new Error("设备返回的音频目录过短");
  const storageCapacityKb = payload[0];
  const fileLimit = payload[1];
  const validCount = payload[2];
  const volume = payload[3];
  const files = [];
  const availableEntries = Math.floor((payload.length - 8) / 24);
  for (let index = 0; index < Math.min(validCount, availableEntries); index += 1) {
    const offset = 8 + index * 24;
    const entry = decodeAudioMeta(payload.slice(offset, offset + 24), index);
    // Keep named entries even if older tool versions wrote a zero size.
    // Their WAV content can still be read and backed up without rewriting it.
    if (payload[offset] > 0 && payload[offset] <= 15) files.push(entry);
  }
  return { storageCapacityKb, fileLimit, validCount, volume, files };
}

export function buildCommandPackets(main, sub, payload, packageSize, rollingCode = 0) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload || []);
  const reportCount = packageSize - 1;
  const shortLimit = reportCount - 5;
  const longLimit = reportCount - 8;
  if (reportCount < 9) throw new Error("HID 报告长度过小");
  const isLong = data.length > shortLimit;
  const flags = (isLong ? 0x10 : 0) | (rollingCode & 0x03);
  if (!isLong) {
    const packet = new Uint8Array(5 + data.length);
    packet.set([main, sub, flags, data.length], 0);
    packet.set(data, 4);
    packet[packet.length - 1] = packetChecksum(packet.slice(0, -1));
    return [packet];
  }
  const total = Math.ceil(data.length / longLimit);
  if (total > 0xfff) throw new Error("数据包数量超过协议上限");
  return Array.from({ length: total }, (_, index) => {
    const chunk = data.slice(index * longLimit, (index + 1) * longLimit);
    const packet = new Uint8Array(8 + chunk.length);
    packet[0] = main;
    packet[1] = sub;
    packet[2] = flags;
    packet[3] = total & 0xff;
    packet[4] = index & 0xff;
    packet[5] = (((total >>> 8) & 0x0f) << 4) | ((index >>> 8) & 0x0f);
    packet[6] = chunk.length;
    packet.set(chunk, 7);
    packet[packet.length - 1] = packetChecksum(packet.slice(0, -1));
    return packet;
  });
}

function parseResponse(raw) {
  if (raw.length < 5) throw new Error("设备响应过短");
  const isLong = Boolean(raw[2] & 0x10);
  if (!isLong) {
    const lengthOrAck = raw[3];
    const isAck = Boolean(lengthOrAck & 0x80);
    const checksumIndex = isAck ? 5 : 4 + (lengthOrAck & 0x7f);
    if (raw.length <= checksumIndex || raw[checksumIndex] !== packetChecksum(raw.slice(0, checksumIndex))) throw new Error("设备响应校验和不匹配");
    if (isAck) return { main: raw[0], sub: raw[1], ack: true, error: raw[4] ?? 0 };
    const length = lengthOrAck & 0x7f;
    return { main: raw[0], sub: raw[1], ack: false, isLong: false, payload: raw.slice(4, 4 + length) };
  }
  if (raw.length < 8) throw new Error("设备长响应过短");
  const combined = raw[5];
  const total = raw[3] | (((combined >>> 4) & 0x0f) << 8);
  const index = raw[4] | ((combined & 0x0f) << 8);
  const lengthOrAck = raw[6];
  const isAck = Boolean(lengthOrAck & 0x80);
  const checksumIndex = isAck ? 8 : 7 + (lengthOrAck & 0x7f);
  if (raw.length <= checksumIndex || raw[checksumIndex] !== packetChecksum(raw.slice(0, checksumIndex))) throw new Error("设备长响应校验和不匹配");
  if (isAck) return { main: raw[0], sub: raw[1], ack: true, error: raw[7] ?? 0, total, index };
  const length = lengthOrAck & 0x7f;
  return { main: raw[0], sub: raw[1], ack: false, isLong: true, total, index, payload: raw.slice(7, 7 + length) };
}

export class IpiAudioDevice {
  constructor(device, { timeoutMs = 1200, retries = 1 } = {}) {
    this.device = device;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.packageSize = 0;
    this.outputBytes = 0;
    this.info = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.rollingCode = 0;
    this.onInput = this.onInput.bind(this);
  }

  static async request() {
    if (!("hid" in navigator)) throw new Error("当前浏览器不支持 WebHID，请使用桌面版 Chrome 或 Edge");
    const [device] = await navigator.hid.requestDevice({ filters: [
      { vendorId: IPI_USB_IDS.vendorId, productId: IPI_USB_IDS.wiredProductId, usagePage: IPI_HID.usagePage, usage: IPI_HID.usage },
      { vendorId: IPI_USB_IDS.vendorId, productId: IPI_USB_IDS.wirelessProductId, usagePage: IPI_HID.usagePage, usage: IPI_HID.usage }
    ] });
    if (!device) throw new Error("未选择设备");
    return new IpiAudioDevice(device);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    const report = this.findOutputReport();
    this.outputBytes = report.items.reduce((total, item) => total + Math.ceil((item.reportCount * item.reportSize) / 8), 0);
    if (!this.outputBytes) throw new Error("未找到报告 ID 8 的输出长度");
    this.device.addEventListener("inputreport", this.onInput);
    this.info = await this.initialize();
    return this.info;
  }

  findOutputReport() {
    const visit = (collections) => {
      for (const collection of collections || []) {
        const report = collection.outputReports?.find((item) => item.reportId === IPI_HID.reportId);
        if (report) return report;
        const nested = visit(collection.children);
        if (nested) return nested;
      }
      return null;
    };
    const report = visit(this.device.collections);
    if (!report) throw new Error("设备没有官方驱动要求的 HID 输出报告 ID 8");
    return report;
  }

  async initialize() {
    const request = new Uint8Array(14);
    request[0] = 0xfd;
    request[1] = 0;
    request[2] = packetChecksum(request.slice(0, 2));
    const result = await this.waitForResponse(() => this.device.sendReport(IPI_HID.reportId, request), "initial");
    if (result.length < 10) throw new Error("设备初始化信息不完整");
    this.packageSize = result[9] || this.outputBytes + 1;
    const uuid = [...result.slice(0, 6)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const protocolVersion = `${result[6]}.${result[7]}`;
    return { uuid, protocolVersion, packageSize: this.packageSize, productId: this.device.productId };
  }

  waitForResponse(send, mode = "command") {
    if (this.pending) return Promise.reject(new Error("已有命令正在执行"));
    return new Promise((resolve, reject) => {
      this.pending = { mode, resolve, reject, attempts: 0, send, chunks: [], packetIndex: 0 };
      this.sendPending();
    });
  }

  async sendPending() {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    const generation = (pending.sendGeneration || 0) + 1;
    pending.sendGeneration = generation;
    // Arm before sending: a fast device can reply before sendReport resolves.
    pending.timer = setTimeout(() => {
      if (this.pending !== pending || pending.sendGeneration !== generation) return;
      if (pending.attempts < this.retries) {
        pending.attempts += 1;
        this.sendPending();
      } else {
        this.finishPending(new Error("设备响应超时；请关闭官方驱动页面后重试"));
      }
    }, this.timeoutMs);
    try {
      await pending.send();
    } catch (error) {
      if (this.pending === pending && pending.sendGeneration === generation) this.finishPending(error);
    }
  }

  finishPending(error, value) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (error) pending.reject(error); else pending.resolve(value);
  }

  async onInput(event) {
    if (event.reportId !== IPI_HID.reportId || !this.pending) return;
    const raw = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
    try {
      if (this.pending.mode === "initial") {
        if (raw[0] !== 0xfd || raw[1] !== 0) return;
        if (raw.length < 13 || raw[12] !== packetChecksum(raw.slice(0, 12))) throw new Error("初始化响应校验失败");
        this.finishPending(null, raw.slice(2, 12));
        return;
      }
      const pending = this.pending;
      if (raw[0] !== pending.main || raw[1] !== pending.sub) return;
      const response = parseResponse(raw);
      if (response.main !== pending.main || response.sub !== pending.sub) return;
      if (response.ack) {
        clearTimeout(pending.timer);
        if (response.error) {
          const detail = response.error === 0xfc ? "（参数异常）" : "";
          throw new Error(`设备拒绝命令 0x${pending.main.toString(16)}/0x${pending.sub.toString(16)}，错误码 0x${response.error.toString(16).padStart(2, "0")}${detail}`);
        }
        if (pending.packetIndex + 1 < pending.packets.length) {
          pending.packetIndex += 1;
          pending.attempts = 0;
          pending.send = () => this.sendPacket(pending.packets[pending.packetIndex]);
          await this.sendPending();
        } else {
          this.finishPending(null, new Uint8Array());
        }
        return;
      }
      if (!response.isLong) {
        this.finishPending(null, response.payload);
        return;
      }
      if (!response.total || response.total > 0xfff || response.index >= response.total) throw new Error("设备返回的音频分片编号异常");
      if (!pending.totalPackets) {
        if (response.index !== 0) return;
        pending.totalPackets = response.total;
        pending.chunks = new Array(response.total);
        pending.expectedIndex = 0;
      }
      if (response.total !== pending.totalPackets) throw new Error("传输期间设备返回的分片总数发生变化");
      if (response.index !== pending.expectedIndex) return;
      clearTimeout(pending.timer);
      pending.chunks[response.index] = response.payload;
      pending.expectedIndex += 1;
      if (pending.expectedIndex === pending.totalPackets) {
        const length = pending.chunks.reduce((sum, part) => sum + part.length, 0);
        const joined = new Uint8Array(length);
        let offset = 0;
        for (const part of pending.chunks) { joined.set(part, offset); offset += part.length; }
        this.finishPending(null, joined);
        return;
      }
      const nextIndex = pending.expectedIndex;
      const nextPayload = response.total > 255
        ? new Uint8Array([(nextIndex >>> 8) & 0xff, nextIndex & 0xff])
        : new Uint8Array([nextIndex]);
      const nextPacket = buildCommandPackets(pending.main, pending.sub, nextPayload, this.packageSize, this.rollingCode)[0];
      pending.send = () => this.sendPacket(nextPacket);
      pending.attempts = 0;
      await this.sendPending();
    } catch (error) {
      this.finishPending(error);
    }
  }

  async sendPacket(packet) {
    const padded = new Uint8Array(this.outputBytes);
    if (packet.length > padded.length) throw new Error("协议包超过 HID 报告容量");
    padded.set(packet);
    await this.device.sendReport(IPI_HID.reportId, padded);
  }

  request(main, sub, payload = new Uint8Array()) {
    const run = async () => {
      this.rollingCode = (this.rollingCode + 1) & 0x03;
      const packets = buildCommandPackets(main, sub, payload, this.packageSize, this.rollingCode);
      return new Promise((resolve, reject) => {
        this.pending = {
          mode: "command", main, sub, packets, packetIndex: 0, chunks: [], attempts: 0, resolve, reject,
          send: () => this.sendPacket(packets[0])
        };
        this.sendPending();
      });
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  getAudioFileList() { return this.request(0x4b, 0xff).then(parseAudioFileList); }
  getAudioFileContent(index) { return this.request(0x49, index); }
  setAudioFileMeta(index, name, bytes) { return this.request(0x4c, index, encodeAudioMeta(name, bytes)); }
  writeAudioFileContent(index, bytes) { return this.request(0x4a, index, bytes); }
  async setAudioFile(index, name, bytes) {
    await this.setAudioFileMeta(index, name, bytes);
    await this.writeAudioFileContent(index, bytes);
  }
  getAudioVolume() { return this.request(0x4b, 0xf0).then((value) => value[0]); }
  setAudioVolume(volume) { return this.request(0x4c, 0xf0, new Uint8Array([volume])); }
  getAudioByKeyPos(keyPos) { return this.request(0x4d, keyPos - 2).then((value) => value[0]); }
  setAudioByKeyPos(keyPos, index) { return this.request(0x4e, keyPos - 2, new Uint8Array([index])); }

  async getAudioBindings() {
    const left = await this.getAudioByKeyPos(2);
    const right = await this.getAudioByKeyPos(3);
    if (![left, right].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error("设备没有返回完整的左右键绑定");
    return { left, right };
  }

  async applyAudioBinding(keyPos, index) {
    if (![2, 3].includes(keyPos)) throw new Error("只能设置左键或右键提示音");
    if (!Number.isInteger(index) || index < 0 || index > 255) throw new Error("音效槽位编号无效");
    const before = await this.getAudioBindings();
    await this.setAudioByKeyPos(keyPos, index);
    const after = await this.getAudioBindings();
    const side = keyPos === 2 ? "left" : "right";
    const otherSide = keyPos === 2 ? "right" : "left";
    if (after[side] !== index) {
      const error = new Error(`按键设置回读不一致：请求槽位 ${index}，设备返回 ${after[side]}`);
      error.bindings = after;
      throw error;
    }
    if (after[otherSide] !== before[otherSide]) {
      const error = new Error("检测到左右键联动：另一侧绑定也发生变化，当前固件尚未实现独立设置。界面已按设备实际返回值更新");
      error.code = "AUDIO_BINDING_LINKED";
      error.bindings = after;
      throw error;
    }
    return after;
  }

  async close() {
    this.device.removeEventListener("inputreport", this.onInput);
    if (this.device.opened) await this.device.close();
  }
}
