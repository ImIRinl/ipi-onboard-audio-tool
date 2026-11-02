import { IpiAudioDevice } from "./protocol.js";
import { convertAudioFile } from "./wav.js";
import { recoverAudioDirectory } from "./directory.js";

const $ = (selector) => document.querySelector(selector);
const ui = {
  connect: $("#connect"), refresh: $("#refresh"), backup: $("#backup"), upload: $("#upload"), file: $("#audio-file"),
  name: $("#audio-name"), slot: $("#slot"), leftAudio: $("#left-audio"), applyLeft: $("#apply-left"),
  overwrite: $("#allow-overwrite"), overwriteRow: $("#overwrite-row"), volume: $("#volume"), volumeValue: $("#volume-value"),
  log: $("#log"), library: $("#library"), summary: $("#library-summary"), preview: $("#preview"), conversion: $("#conversion"),
  statusDot: $("#status-dot"), connectionLabel: $("#connection-label"), product: $("#product"), uuid: $("#uuid"),
  protocolVersion: $("#protocol-version"), packageSize: $("#package-size"), capacityLabel: $("#capacity-label"),
  capacityMeter: $("#capacity-meter"), leftBinding: $("#left-binding")
};

const state = { device: null, directory: null, converted: null, previewUrl: null, leftIndex: 0xff, rightIndex: 0xff, busy: false };

const formatBytes = (bytes) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
const time = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });
function log(message, type = "info") {
  const prefix = type === "error" ? "错误" : type === "ok" ? "完成" : "信息";
  ui.log.textContent += `\n[${time()}] ${prefix} · ${message}`;
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setBusy(busy) {
  state.busy = busy;
  ui.connect.disabled = busy;
  ui.refresh.disabled = busy || !state.device;
  ui.backup.disabled = busy || !state.directory;
  for (const element of [ui.file, ui.name, ui.slot, ui.volume, ui.leftAudio, ui.applyLeft]) element.disabled = busy || !state.device;
  for (const button of ui.library.querySelectorAll("button")) button.disabled = busy || !state.device;
  updateUploadButton();
}
function setConnected(connected) {
  ui.statusDot.classList.toggle("online", connected);
  ui.connectionLabel.textContent = connected ? "设备已连接" : "未连接";
  ui.connect.textContent = connected ? "重新选择设备" : "连接 IPI 鼠标";
  for (const element of [ui.refresh, ui.backup, ui.file, ui.name, ui.slot, ui.leftAudio, ui.applyLeft, ui.volume]) element.disabled = !connected;
  for (const button of ui.library.querySelectorAll("button")) button.disabled = !connected;
}
function utf8Length(value) { return new TextEncoder().encode(value).length; }
function findFile(index) { return state.directory?.files.find((file) => file.index === Number(index)); }
function fileName(index) { return index === 0xff ? "关闭提示音" : `槽位 ${index} · ${findFile(index)?.name || "未读取到音频"}`; }
function usedBytes() { return state.directory?.files.reduce((sum, file) => sum + file.size, 0) || 0; }
function updateUploadButton() {
  const existing = findFile(ui.slot.value);
  const nameValid = utf8Length(ui.name.value.trim()) > 0 && utf8Length(ui.name.value.trim()) <= 15;
  const overwriteAllowed = !existing || ui.overwrite.checked;
  const capacity = (state.directory?.storageCapacityKb || 0) * 1024;
  const projected = usedBytes() - (existing?.size || 0) + (state.converted?.bytes.length || 0);
  ui.upload.disabled = state.busy || !state.device || !state.converted || !nameValid || !overwriteAllowed || projected > capacity;
}
function renderDirectory() {
  const directory = state.directory;
  if (!directory) return;
  const total = directory.storageCapacityKb * 1024;
  const used = usedBytes();
  ui.capacityLabel.textContent = `${formatBytes(used)} / ${directory.storageCapacityKb} KB`;
  ui.capacityMeter.style.width = `${Math.min(100, total ? used / total * 100 : 0)}%`;
  ui.summary.textContent = `${directory.files.length} / ${directory.fileLimit} 个槽位 · 使用 ${formatBytes(used)}`;
  ui.volume.value = Math.min(8, directory.volume);
  ui.volumeValue.textContent = String(directory.volume);
  ui.leftBinding.textContent = fileName(state.leftIndex);

  for (const [select, current] of [[ui.leftAudio, state.leftIndex]]) {
    select.replaceChildren(new Option("关闭提示音", "255"));
    for (const file of directory.files) select.add(new Option(`槽位 ${file.index} · ${file.name}`, String(file.index)));
    if (current !== 255 && !findFile(current)) select.add(new Option(`槽位 ${current} · 内容不可用`, String(current)));
    select.value = String(current);
  }

  ui.library.classList.remove("empty");
  ui.library.replaceChildren();
  for (let slotIndex = 0; slotIndex < directory.fileLimit; slotIndex += 1) {
      const file = findFile(slotIndex);
      const card = document.createElement("article"); card.className = "tone";
      if (!file) {
        card.classList.add("vacant");
        const title = document.createElement("strong"); title.textContent = `槽位 ${slotIndex} · 空闲`;
        const caption = document.createElement("p"); caption.className = "muted"; caption.textContent = "可上传新音效到此槽位";
        card.append(title, caption); ui.library.append(card); continue;
      }
      const top = document.createElement("div"); top.className = "tone-top";
      const name = document.createElement("span"); name.className = "tone-name"; name.textContent = file.name;
      const index = document.createElement("span"); index.className = "tone-index"; index.textContent = `#${file.index}`;
      const meta = document.createElement("div"); meta.className = "tone-meta"; meta.textContent = `${formatBytes(file.size)} · 校验 0x${file.checksum.toString(16).padStart(2, "0")}${file.recovered ? " · 已回读恢复" : ""}`;
      const button = document.createElement("button"); button.className = "quiet"; button.textContent = "从板载读取并试听";
      button.addEventListener("click", () => previewBoardAudio(file));
      const badges = document.createElement("div"); badges.className = "tone-state";
      for (const [key, current] of [["提示音", state.leftIndex]]) {
        if (current !== file.index) continue;
        const badge = document.createElement("span"); badge.textContent = `${key}已启用`; badges.append(badge); card.classList.add("active");
      }
      if (!badges.childElementCount) { const idle = document.createElement("span"); idle.className = "idle"; idle.textContent = "已保存 · 未启用"; badges.append(idle); }
      const actions = document.createElement("div"); actions.className = "tone-actions";
      for (const [key, side] of [["提示音", "left"]]) {
        const enable = document.createElement("button"); enable.className = "secondary"; enable.textContent = "启用此音效";
        enable.addEventListener("click", () => applyBinding(side, file.index)); actions.append(enable);
      }
      top.append(name, index); card.append(top, meta, badges, button, actions); ui.library.append(card);
  }

  const previous = Number(ui.slot.value);
  ui.slot.replaceChildren();
  for (let index = 0; index < directory.fileLimit; index += 1) {
    const option = document.createElement("option");
    const existing = findFile(index);
    option.value = String(index);
    option.textContent = existing ? `槽位 ${index} · 覆盖“${existing.name}”` : `槽位 ${index} · 空闲`;
    ui.slot.append(option);
  }
  const firstFree = Array.from({ length: directory.fileLimit }, (_, index) => index).find((index) => !findFile(index));
  ui.slot.value = String(Number.isInteger(previous) && previous < directory.fileLimit ? previous : (firstFree ?? 0));
  updateOverwriteState();
}

async function refreshDevice() {
  setBusy(true);
  log("正在读取板载目录、音量与左右键绑定…");
  try {
    const [directory, leftIndex, rightIndex] = await Promise.all([
      state.device.getAudioFileList(), state.device.getAudioByKeyPos(2), state.device.getAudioByKeyPos(3)
    ]);
    state.directory = await recoverAudioDirectory(state.device, directory, [leftIndex, rightIndex]);
    state.leftIndex = leftIndex;
    state.rightIndex = rightIndex;
    renderDirectory();
    for (const warning of state.directory.warnings) log(warning, "error");
    const recovered = state.directory.files.filter((file) => file.recovered).length;
    log(`读取成功：${state.directory.files.length} 个音频，容量 ${directory.storageCapacityKb} KB${recovered ? `（${recovered} 个从板载内容回读恢复）` : ""}`, "ok");
  } catch (error) {
    log(error.message, "error");
    throw error;
  } finally { setBusy(false); }
}

async function applyBinding(side, index) {
  if (state.busy || !state.device) return;
  if (side !== "left") return;
  const keyPos = 2;
  const label = "提示音";
  if (index !== 255 && !findFile(index)) { log("请选择已保存音频的槽位", "error"); return; }
  ui.preview.pause();
  setBusy(true);
  try {
    await state.device.setAudioByKeyPos(keyPos, index);
    const bindings = await state.device.getAudioBindings();
    if (bindings.left !== index) throw new Error("提示音绑定回读不一致，请重新读取设备");
    state.leftIndex = bindings.left;
    state.rightIndex = bindings.right;
    renderDirectory();
    log(`${label}绑定已回读确认：${fileName(bindings.left)}。原厂 v1.2.2 不支持两键独立播放`, "ok");
  } catch (error) {
    log(error.message, "error");
    if (error.bindings) {
      state.leftIndex = error.bindings.left;
      state.rightIndex = error.bindings.right;
      renderDirectory();
    } else await refreshDevice().catch(() => {});
  } finally { setBusy(false); }
}

async function connect() {
  setBusy(true);
  try {
    if (state.device) await state.device.close().catch(() => {});
    log("等待你在浏览器设备选择框中选择 IPI 鼠标…");
    const device = await IpiAudioDevice.request();
    const info = await device.open();
    state.device = device;
    setConnected(true);
    ui.product.textContent = `${device.device.productName || "IPI Mouse"} · PID ${device.device.productId.toString(16).toUpperCase().padStart(4, "0")}`;
    ui.uuid.textContent = info.uuid;
    ui.protocolVersion.textContent = info.protocolVersion;
    ui.packageSize.textContent = `${info.packageSize} bytes`;
    log(`已连接 ${device.device.productName || "IPI Mouse"}，协议 ${info.protocolVersion}`, "ok");
    await refreshDevice();
  } catch (error) {
    log(error.message, "error");
    if (!state.device) setConnected(false);
  } finally { setBusy(false); }
}

async function previewBoardAudio(file) {
  setBusy(true);
  try {
    log(`正在读取槽位 ${file.index}“${file.name}”…`);
    const bytes = await state.device.getAudioFileContent(file.index);
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
    ui.preview.src = state.previewUrl;
    ui.preview.classList.remove("hidden");
    await ui.preview.play().catch(() => {});
    log(`已从板载读取 ${formatBytes(bytes.length)}`, "ok");
  } catch (error) { log(error.message, "error"); }
  finally { setBusy(false); }
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function backupAll() {
  setBusy(true);
  try {
    log("开始逐个读取板载音频；此操作只读…");
    const files = [];
    for (const file of state.directory.files) {
      const bytes = await state.device.getAudioFileContent(file.index);
      files.push({ ...file, base64: bytesToBase64(bytes) });
      log(`已备份槽位 ${file.index} · ${file.name} · ${formatBytes(bytes.length)}`);
    }
    const backup = {
      format: "ipi-onboard-audio-backup-v1",
      createdAt: new Date().toISOString(),
      device: { vendorId: state.device.device.vendorId, productId: state.device.device.productId, ...state.device.info },
      directory: { ...state.directory, leftIndex: state.leftIndex, rightIndex: state.rightIndex, files }
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    download(`ipi-audio-backup-${stamp}.json`, JSON.stringify(backup, null, 2), "application/json");
    log("完整备份已下载。请妥善保存后再写入", "ok");
  } catch (error) { log(error.message, "error"); }
  finally { setBusy(false); }
}

async function selectAudio(event) {
  const [file] = event.target.files;
  if (!file) return;
  setBusy(true);
  ui.conversion.className = "conversion";
  ui.conversion.textContent = "正在浏览器内解码和转换…";
  try {
    const converted = await convertAudioFile(file);
    state.converted = converted;
    const defaultName = file.name.replace(/\.[^.]+$/, "").slice(0, 15);
    ui.name.value = utf8Length(defaultName) <= 15 ? defaultName : "自定义音频";
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(new Blob([converted.bytes], { type: "audio/wav" }));
    ui.preview.src = state.previewUrl;
    ui.preview.classList.remove("hidden");
    ui.conversion.className = "conversion ready";
    ui.conversion.textContent = `转换完成 · ${converted.info.duration.toFixed(2)} 秒 · ${formatBytes(converted.bytes.length)} · 8 kHz / 8-bit / 单声道`;
    const total = state.directory.storageCapacityKb * 1024;
    const existing = findFile(ui.slot.value);
    const projected = usedBytes() - (existing?.size || 0) + converted.bytes.length;
    if (projected > total) throw new Error(`空间不足：写入后将使用 ${formatBytes(projected)}，板载上限 ${formatBytes(total)}`);
    log(`已转换“${file.name}”：${formatBytes(converted.bytes.length)}`, "ok");
  } catch (error) {
    state.converted = null;
    ui.conversion.className = "conversion";
    ui.conversion.textContent = error.message;
    log(error.message, "error");
  } finally { setBusy(false); updateUploadButton(); }
}

function updateOverwriteState() {
  const existing = findFile(ui.slot.value);
  ui.overwriteRow.classList.toggle("hidden", !existing);
  if (!existing) ui.overwrite.checked = false;
  updateUploadButton();
}
async function upload() {
  const index = Number(ui.slot.value);
  const name = ui.name.value.trim();
  const bytes = state.converted.bytes;
  const existing = findFile(index);
  if (existing && !ui.overwrite.checked) return;
  setBusy(true);
  try {
    log(`准备写入槽位 ${index}${existing ? `，覆盖“${existing.name}”` : ""}…`);
    await state.device.setAudioFile(index, name, bytes);
    log("写入命令已完成，正在回读验证音频内容…");
    const readback = await state.device.getAudioFileContent(index);
    if (readback.length !== bytes.length || !readback.every((value, offset) => value === bytes[offset])) throw new Error("回读内容与上传音频不一致，请保留备份并重新读取设备");
    log(`音频数据写入并回读验证完成：${name}`, "ok");
    await refreshDevice();
    log("音效已保存，请在槽位卡片中选择启用此音效");
  } catch (error) { log(error.message, "error"); }
  finally { setBusy(false); }
}

ui.connect.addEventListener("click", connect);
ui.refresh.addEventListener("click", () => refreshDevice().catch(() => {}));
ui.backup.addEventListener("click", backupAll);
ui.file.addEventListener("change", selectAudio);
ui.slot.addEventListener("change", updateOverwriteState);
ui.name.addEventListener("input", updateUploadButton);
ui.overwrite.addEventListener("change", updateUploadButton);
ui.upload.addEventListener("click", upload);
ui.applyLeft.addEventListener("click", () => applyBinding("left", Number(ui.leftAudio.value)));
ui.volume.addEventListener("input", () => { ui.volumeValue.textContent = ui.volume.value; });
ui.volume.addEventListener("change", async () => {
  setBusy(true);
  try { await state.device.setAudioVolume(Number(ui.volume.value)); log(`板载音量已设为 ${ui.volume.value}`, "ok"); }
  catch (error) { log(error.message, "error"); }
  finally { setBusy(false); }
});
$("#clear-log").addEventListener("click", () => { ui.log.textContent = "日志已清空"; });

if (!("hid" in navigator)) $("#compat-warning").classList.remove("hidden");
log("v1.2.0 本地上传版已加载：不刷固件，不提供左右键独立播放");
navigator.hid?.addEventListener("disconnect", (event) => {
  if (state.device?.device === event.device) { setConnected(false); state.device = null; log("设备已断开", "error"); }
});
