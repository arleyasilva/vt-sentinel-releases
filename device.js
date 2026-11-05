// Conversa com o VT SENTINEL IoT pela porta serial do USB (Web Serial), no protocolo de api/protocolo-usb.md.

export const USB_FILTERS = [{ usbVendorId: 0x1a86, usbProductId: 0x55d4 }];  // CH9102 do CoreInk

export class DeviceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Device extends EventTarget {
  constructor(port) {
    super();
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
    this.reader = null;
    this.closed = true;
  }

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 8192 });
    // DTR/RTS ligados reiniciam a placa ou a colocam em modo de gravação
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.closed = false;
    this.readLoop();
  }

  async readLoop() {
    const decoder = new TextDecoder();
    let buf = "";
    while (!this.closed && this.port.readable) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            this.onLine(line);
          }
          if (buf.length > 16384) buf = "";
        }
      } catch (e) {
        // Ruído ao reiniciar a placa (boot a 74880 baud) gera erros recuperáveis: o navegador entrega
        // um readable novo e a leitura continua. Só desiste em erro fatal (cabo removido).
        const recoverable = ["BreakError", "FramingError", "ParityError", "BufferOverrunError"].includes(e?.name);
        console.warn("serial:", e?.name, e?.message, recoverable ? "(continuando)" : "");
        if (!recoverable) {
          if (!this.closed) this.dispatchEvent(new CustomEvent("error", { detail: e }));
          this.reader.releaseLock();
          this.reader = null;
          break;
        }
        buf = "";
      } finally {
        if (this.reader) {
          this.reader.releaseLock();
          this.reader = null;
        }
      }
    }
    if (!this.closed) {
      this.closed = true;
      this.dispatchEvent(new Event("disconnect"));
    }
  }

  onLine(line) {
    if (!line.startsWith("{")) return;  // log de boot do ESP32
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event) {
      this.dispatchEvent(new CustomEvent("device-event", { detail: msg }));
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result ?? {});
    else p.reject(new DeviceError(msg.error?.code ?? "internal", msg.error?.message ?? "Erro"));
  }

  async call(cmd, args, timeoutMs = 8000) {
    if (this.closed) throw new DeviceError("disconnected", "Aparelho desconectado");
    const id = this.nextId++;
    const msg = { id, cmd };
    if (args !== undefined) msg.args = args;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DeviceError("timeout", "O aparelho não respondeu"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(JSON.stringify(msg) + "\n"));
    } finally {
      writer.releaseLock();
    }
    return promise;
  }

  // Espera o aparelho responder ao hello (ele pode estar reiniciando: logo + ~3 s).
  async waitHello(totalMs = 60000) {  // ao abrir a porta o aparelho reinicia e pode passar ~30 s conectando no Wi-Fi e enviando
    const until = Date.now() + totalMs;
    while (Date.now() < until) {
      try {
        return await this.call("hello", undefined, 1500);
      } catch (e) {
        if (e.code !== "timeout") throw e;
      }
    }
    return null;
  }

  async close() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new DeviceError("disconnected", "Aparelho desconectado"));
    }
    this.pending.clear();
    try {
      await this.reader?.cancel();
    } catch {}
    try {
      await this.port.close();
    } catch {}
  }
}
