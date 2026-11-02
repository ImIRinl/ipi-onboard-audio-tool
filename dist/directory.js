import { audioChecksum } from "./protocol.js";
import { inspectWav } from "./wav.js";

export async function recoverAudioDirectory(device, directory, bindingIndices) {
  const files = directory.files.map((file) => ({ ...file }));
  const warnings = [];
  const candidates = new Set([
    ...files.filter((file) => file.size === 0).map((file) => file.index),
    ...bindingIndices.filter((index) => Number.isInteger(index) && index >= 0 && index < directory.fileLimit && !files.some((file) => file.index === index))
  ]);
  for (const index of candidates) {
    try {
      const bytes = await device.getAudioFileContent(index);
      inspectWav(bytes);
      let file = files.find((item) => item.index === index);
      if (!file) {
        file = { index, name: `板载音频${index}` };
        files.push(file);
      }
      file.metadataSize = file.size ?? null;
      file.size = bytes.length;
      file.checksum = audioChecksum(bytes);
      file.recovered = true;
    } catch (error) {
      warnings.push(`槽位 ${index} 的目录信息不完整，回读失败：${error.message}`);
    }
  }
  files.sort((left, right) => left.index - right.index);
  return { ...directory, files, warnings };
}
