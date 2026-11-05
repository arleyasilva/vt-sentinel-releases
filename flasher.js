// Grava o firmware do VT SENTINEL IoT pelo USB, direto do navegador (esptool-js).
// Usado para instalar em CoreInk novo e para reinstalar/atualizar pelo cabo.
import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.5.7/bundle.js";

// Onde estão os arquivos do firmware: ao lado do Config (site publicado) ou o endereço passado em ?fw=
// (Config embutido no Hub, que não guarda o firmware e busca no vt-sentinel-releases).
const FW_BASE = new URLSearchParams(location.search).get("fw") || "firmware/";

export async function loadManifest() {
  const r = await fetch(FW_BASE + "manifest.json", { cache: "no-store" });
  if (!r.ok) throw new Error("Firmware não encontrado em config-app/firmware (rode tools/publicar-firmware-config.py)");
  return r.json();
}

function toBinaryString(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// `port` precisa estar fechado. eraseAll apaga também configurações e Wi-Fi (aparelho "de fábrica").
export async function flash(port, { eraseAll = false, onLog = () => {}, onProgress = () => {} } = {}) {
  const manifest = await loadManifest();
  const files = [];
  for (const part of manifest.parts) {
    const r = await fetch(FW_BASE + part.path, { cache: "no-store" });
    if (!r.ok) throw new Error("Falta o arquivo " + part.path);
    const buf = await r.arrayBuffer();
    if ((await sha256Hex(buf)) !== part.sha256) throw new Error("Arquivo corrompido: " + part.path);
    files.push({ data: toBinaryString(buf), address: part.offset });
  }
  const total = files.reduce((n, f) => n + f.data.length, 0);
  const done = new Array(files.length).fill(0);

  const terminal = { clean() {}, writeLine: (t) => onLog(t), write: (t) => onLog(t) };
  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: 921600, romBaudrate: 115200, terminal });
  try {
    onLog("Entrando no modo de gravação…");
    const chip = await loader.main();
    onLog("Chip: " + chip);
    if (!chip.startsWith("ESP32") || /^ESP32-(S2|S3|C\d|H\d|P4)/.test(chip)) throw new Error("Este aparelho não é um ESP32 (" + chip + ")");
    await loader.writeFlash({
      fileArray: files,
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll,
      compress: true,
      reportProgress: (i, written, size) => {
        done[i] = (written / size) * files[i].data.length;
        onProgress(done.reduce((a, b) => a + b, 0) / total);
      },
    });
    onProgress(1);
    onLog("Reiniciando o aparelho…");
    await loader.after("hard_reset");
  } finally {
    await transport.disconnect().catch(() => {});
  }
  return manifest.version;
}
