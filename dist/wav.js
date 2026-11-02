const ascii = (view, offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, length));

export function inspectWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") throw new Error("不是有效的 RIFF/WAVE 文件");
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) break;
    if (id === "fmt " && size >= 16) {
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true)
      };
    }
    if (id === "data") data = { offset: body, size };
    offset = body + size + (size & 1);
  }
  if (!format || !data) throw new Error("WAV 缺少 fmt 或 data 区块");
  return { ...format, dataOffset: data.offset, dataSize: data.size, duration: data.size / (format.sampleRate * format.channels * (format.bitsPerSample / 8)) };
}

export function encodePcm8Wav(samples, sampleRate = 8000) {
  const dataSize = samples.length;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset, value) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    bytes[44 + index] = Math.max(0, Math.min(255, Math.round((sample + 1) * 127.5)));
  }
  return bytes;
}

function resample(channelData, sourceRate, targetRate) {
  const length = Math.max(1, Math.round(channelData.length * targetRate / sourceRate));
  const result = new Float32Array(length);
  const ratio = sourceRate / targetRate;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, channelData.length - 1);
    const mix = position - left;
    result[index] = channelData[left] * (1 - mix) + channelData[right] * mix;
  }
  return result;
}

export async function convertAudioFile(file) {
  const source = await file.arrayBuffer();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("浏览器无法解码音频");
  const context = new AudioContextClass();
  try {
    const audio = await context.decodeAudioData(source.slice(0));
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const samples = audio.getChannelData(channel);
      for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / audio.numberOfChannels;
    }
    const wav = encodePcm8Wav(resample(mono, audio.sampleRate, 8000), 8000);
    return { bytes: wav, info: inspectWav(wav), source: { channels: audio.numberOfChannels, sampleRate: audio.sampleRate, duration: audio.duration } };
  } finally {
    await context.close();
  }
}
