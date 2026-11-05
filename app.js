// VT SENTINEL Config — configura e instala o VT SENTINEL IoT pelo cabo USB (Chrome/Edge, Web Serial).
import { Device, DeviceError, USB_FILTERS } from "./device.js";
import { flash, loadManifest } from "./flasher.js";
import { allTimezones, ianaToPosix, localTimezone } from "./tz.js";

const $ = (id) => document.getElementById(id);
// Embutido no Hub (Configurações › Aparelho USB): sem cabeçalho próprio, sem "Instalar app" nem service worker
const EMBED = new URLSearchParams(location.search).has("embed");
if (EMBED) document.documentElement.classList.add("embed");
const VIEWS = ["v-unsupported", "v-empty", "v-busy", "v-new", "v-flash", "v-device"];

const ERRORS = {
  locked: "Alterações bloqueadas — libere com o código da tela.",
  timeout: "O aparelho não respondeu.",
  disconnected: "Aparelho desconectado.",
  wifi_failed: "Não conectou no Wi-Fi.",
  hub_unreachable: "Servidor não respondeu.",
  rate_limited: "Muitas tentativas. Aguarde 5 minutos.",
};

let port = null;
let device = null;
let hello = null;
let unlocked = false;
let busy = false;

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
}

function setConn(text, on) {
  $("conn").textContent = text;
  $("conn").className = "pill " + (on ? "on" : "off");
}

function result(id, text, ok = true) {
  const el = $(id);
  el.textContent = text;
  el.className = "result " + (ok ? "ok" : "err");
}

function errText(e) {
  if (e instanceof DeviceError) return ERRORS[e.code] && e.code !== "wifi_failed" && e.code !== "hub_unreachable" ? ERRORS[e.code] : e.message;
  return e?.message ?? String(e);
}

// Executa uma ação de botão/formulário mostrando o resultado em `out`.
async function act(out, fn, button) {
  if (button) button.disabled = true;
  result(out, "Aguarde…");
  try {
    const msg = await fn();
    result(out, msg ?? "Pronto.");
  } catch (e) {
    if (e instanceof DeviceError && e.code === "locked") setUnlocked(false);
    result(out, errText(e), false);
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- conexão ----------

async function connect(p) {
  if (busy) return;
  busy = true;
  try {
    await disconnect();
    port = p;
    show("v-busy");
    $("busy-msg").textContent = "Conectando…";
    device = new Device(port);
    await device.open();
    device.addEventListener("device-event", (e) => onEvent(e.detail));
    device.addEventListener("disconnect", onDisconnect);
    $("busy-msg").textContent = "Procurando o VT SENTINEL… (pode levar até 1 minuto)";
    hello = await device.waitHello();
    if (!hello || hello.product !== "VT SENTINEL IoT") {
      await device.close();
      device = null;
      await showNew();
      return;
    }
    setConn("Conectado", true);
    $("d-id").textContent = hello.device_id;
    $("d-fw").textContent = "v" + hello.fw_version;
    showName(hello.name, null);
    setUnlocked(!!hello.session);
    show("v-device");
    await refreshStatus();
  } catch (e) {
    setConn("Desconectado", false);
    show("v-empty");
    alert("Não foi possível abrir a porta: " + errText(e) + "\n\nFeche outros programas que estejam usando a COM do aparelho (monitor serial, Arduino, PlatformIO).");
  } finally {
    busy = false;
  }
}

async function disconnect() {
  if (device) await device.close();
  device = null;
  hello = null;
  setUnlocked(false);
}

function onDisconnect() {
  device = null;
  setConn("Desconectado", false);
  if (!busy) show("v-empty");
}

async function showNew() {
  setConn("Sem firmware VT SENTINEL", false);
  show("v-new");
  try {
    $("new-version").textContent = "v" + (await loadManifest()).version;
  } catch (e) {
    $("new-version").textContent = "(firmware não encontrado)";
  }
}

// ---------- leitura ao vivo ----------

function onEvent(msg) {
  if (msg.event === "reading") showReading(msg.data);
  if (msg.event === "ota") onOta(msg.data);
}

function onOta(d) {
  const bar = $("ota-progress");
  if (d.stage === "download") {
    bar.hidden = false;
    bar.value = d.pct ?? 0;
    result("ota-result", `Baixando ${d.msg ?? ""} ${d.pct ?? 0}%… não desconecte o cabo.`);
  } else if (d.stage === "done") {
    bar.value = 100;
    result("ota-result", `Instalado ${d.msg}. O aparelho está reiniciando…`);
  } else if (d.stage === "error") {
    bar.hidden = true;
    result("ota-result", "Falha na atualização: " + d.msg, false);
  }
}

function showReading(r) {
  if (!r) return;
  const fmt = (v, d) => v.toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const probe = r.probe_temp_c !== undefined;
  // Com sonda, o número grande é a sonda (geladeira) — igual à tela do aparelho
  $("r-temp").textContent = probe ? fmt(r.probe_temp_c, 1) : r.temp_c !== undefined ? fmt(r.temp_c, 1) : "—";
  $("r-hum").textContent = r.hum_pct !== undefined ? r.hum_pct.toFixed(0) : "—";
  const extra = [];
  if (probe && r.temp_c !== undefined) extra.push(`ambiente ${fmt(r.temp_c, 1)} °C`);
  if (r.door_open !== undefined) {
    const min = Math.floor((r.door_open_s ?? 0) / 60);
    extra.push(r.door_open ? (min ? `porta aberta há ${min} min` : "porta aberta") : "porta fechada");
  }
  $("r-extra").textContent = extra.join(" · ");
  $("r-extra").hidden = !extra.length;
  if (r.bat_pct !== undefined) showBatteryLevel(r.bat_pct, r.bat_v);
  showSensors(r.sensors);
}

function showName(name, location) {
  $("d-name").textContent = name || hello?.device_id || "—";
  $("d-location").textContent = location || (name ? "Aparelho" : "Aparelho sem nome — dê um nome na aba Aparelho");
}

function showBatteryLevel(pct, volt) {
  $("b-pct").textContent = pct + "%";
  $("b-volt").textContent = volt ? volt.toFixed(2) + " V" : "";
  $("b-fill").style.width = Math.max(0, Math.min(100, pct)) + "%";
  $("b-fill").classList.toggle("low", pct <= 20);
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "—");
const fmtNum = (n, d = 0) => n.toLocaleString("pt-BR", { maximumFractionDigits: d, minimumFractionDigits: d });

// BatteryStatus (api/openapi.yaml)
function showBattery(b, fallbackPct, fallbackV) {
  if (!b) {  // firmware antigo, sem estatísticas
    showBatteryLevel(fallbackPct, fallbackV);
    return;
  }
  showBatteryLevel(b.pct, b.voltage_v);
  $("b-days").textContent = b.charging ? "carregando" : b.days_left != null ? `~${b.days_left} dias` : "medindo…";
  $("b-days").title = b.discharge_pct_per_day != null ? `descarregando ${fmtNum(b.discharge_pct_per_day, 1)}% por dia` : "precisa de 12 h na bateria";
  $("b-autonomy").textContent = b.autonomy_days != null ? `~${fmtNum(b.autonomy_days)} dias` : "medindo…";
  $("b-autonomy").title = "medido na última descarga de pelo menos 20%";
  $("b-health").textContent = b.health_pct != null ? b.health_pct + "%" : "medindo…";
  $("b-health").title = "precisa de 2 descargas de pelo menos 20% com o mesmo intervalo de medição";
  $("b-cycles").textContent = fmtNum(b.cycles, 1);
  $("b-full").textContent = fmtDate(b.last_full_charge_at);
  $("b-replaced").textContent = fmtDate(b.replaced_at);
  const badge = $("b-badge");
  badge.hidden = false;
  if (b.replace_recommended) {
    badge.className = "badge warn";
    badge.textContent = b.replace_reason === "cycles" ? "Trocar bateria (muitos ciclos)" : "Trocar bateria (saúde baixa)";
  } else if (b.charging) {
    badge.className = "badge info";
    badge.textContent = "Carregando";
  } else {
    badge.hidden = true;
  }
}

function showSensors(s) {
  if (!s) return;
  const found = [s.ambient === "SHT30" ? "ENV III" : s.ambient === "ENS210" ? "sensor interno" : null,
    s.hat ? "placa HAT" : null, s.probe ? `sonda ${s.probe}` : null, s.door ? "porta" : null].filter(Boolean);
  $("d-sensors").textContent = "Conectado: " + (found.join(" · ") || "nenhum sensor");
  $("d-sensors").hidden = false;
}

async function refreshStatus() {
  const st = await device.call("status");
  showSensors(st.sensors);
  if (st.reading) showReading(st.reading);
  showBattery(st.battery, st.bat_pct, st.bat_v);
  if (st.name !== undefined) showName(st.name, st.location);
  return st;
}

// ---------- sessão ----------

function setUnlocked(v) {
  unlocked = v;
  $("lock").classList.toggle("open", v);
  $("tabs").hidden = !v;
  if (!v) {
    for (const p of document.querySelectorAll("[data-panel]")) p.hidden = true;
    $("f-code").hidden = true;
    $("btn-code").hidden = false;
  } else {
    openTab(document.querySelector(".tabs button.active")?.dataset.tab ?? "ident");
  }
}

$("btn-code").onclick = async () => {
  try {
    await device.call("session.begin");
    $("btn-code").hidden = true;
    $("f-code").hidden = false;
    $("code").value = "";
    $("code").focus();
  } catch (e) {
    alert(errText(e));
  }
};

$("f-code").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    await device.call("session.unlock", { code: $("code").value.trim() });
    setUnlocked(true);
  } catch (e) {
    alert(e.code === "locked" ? e.message === "Codigo errado" ? "Código errado. Confira na tela do aparelho." : "O código expirou. Peça outro." : errText(e));
    if (e.message !== "Codigo errado") {
      $("f-code").hidden = true;
      $("btn-code").hidden = false;
    }
  }
};

// ---------- abas ----------

for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => openTab(b.dataset.tab);

async function openTab(tab) {
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== tab;
  try {
    await LOADERS[tab]?.();
  } catch (e) {
    if (e instanceof DeviceError && e.code === "locked") setUnlocked(false);
  }
}

let config = null;
async function loadConfig() {
  config = await device.call("config.get");
  return config;
}

const LOADERS = {
  ident: loadIdent,
  wifi: loadWifi,
  hub: loadHub,
  time: loadTime,
  measure: loadMeasure,
  cal: loadCal,
  system: loadSystem,
};

// ---------- Aparelho (nome e local) ----------

async function loadIdent() {
  const c = await loadConfig();
  $("i-name").value = c.name ?? "";
  $("i-location").value = c.location ?? "";
}

$("f-ident").onsubmit = (ev) => {
  ev.preventDefault();
  act("ident-result", async () => {
    const loc = $("i-location").value.trim();
    const c = await device.call("config.set", { name: $("i-name").value.trim(), location: loc || null });
    showName(c.name, c.location);
    return "Salvo.";
  }, ev.submitter);
};

// ---------- Wi-Fi ----------

// Servidor por rede Wi-Fi existe a partir do firmware 0.10.0
function perNetworkHub() {
  const [a, b] = (hello?.fw_version || "0.0").split(".").map(Number);
  return a > 0 || b >= 10;
}

const button = (text, onclick) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghost";
  b.textContent = text;
  b.onclick = () => onclick(b);
  return b;
};

// Testa uma rede: conecta nela e chama o servidor que vale nela (o dela ou o padrão)
async function testNetwork(ssid) {
  const w = await device.call("wifi.test", { ssid }, 90000);
  let msg = `Rede "${w.ssid}": conectou — IP ${w.ip}, sinal ${w.rssi} dBm (${(w.connect_ms / 1000).toFixed(1)} s).`;
  if (w.rssi < -75) msg += " Sinal fraco: aproxime do roteador ou use outra rede 2,4 GHz.";
  try {
    const h = await device.call("hub.test", undefined, 60000);
    msg += h.ok ? ` Servidor ${h.url} OK (${h.latency_ms} ms).` : ` Servidor ${h.url} respondeu HTTP ${h.http_status}.`;
  } catch (e) {
    msg += ` Servidor: ${errText(e)}`;
  }
  return msg;
}

// Lista das redes salvas com o servidor de cada uma (aba Wi-Fi e aba Servidor usam a mesma)
async function renderNetworks(ul, resultId, { remove = false } = {}) {
  const { networks } = await device.call("wifi.list");
  const perNet = perNetworkHub();
  ul.innerHTML = "";
  if (!networks.length) ul.innerHTML = '<li class="muted">Nenhuma rede salva — cadastre na aba Wi-Fi.</li>';
  for (const n of networks) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="net-name"><b></b> <span class="muted small">prioridade ${n.priority}</span></span>`;
    li.querySelector("b").textContent = n.ssid;
    if (perNet) {
      // Servidor desta rede: editar e salvar sem precisar digitar a senha de novo
      const hub = document.createElement("input");
      hub.type = "url";
      hub.className = "net-hub";
      hub.value = n.hub_url || "";
      hub.placeholder = "servidor desta rede, ex.: http://10.0.103.5:8000 (vazio = padrão)";
      hub.title = "Servidor desta rede (em branco = servidor padrão da aba Servidor)";
      li.append(hub, button("Salvar servidor", (b) => act(resultId, async () => {
        const r = await device.call("wifi.hub", { ssid: n.ssid, hub_url: hub.value.trim() });
        hub.value = r.hub_url;
        return r.hub_url ? `Na rede "${n.ssid}" o aparelho envia para ${r.hub_url}.` : `Rede "${n.ssid}" usa o servidor padrão.`;
      }, b)));
    }
    li.append(button("Testar", (b) => act(resultId, () => testNetwork(n.ssid), b)));
    if (remove) li.append(button("Remover", (b) => act(resultId, async () => {
      await device.call("wifi.remove", { ssid: n.ssid });
      await loadWifi();
      return `Rede "${n.ssid}" removida.`;
    }, b)));
    ul.append(li);
  }
}

async function loadWifi() {
  $("wifi-hub-row").hidden = $("wifi-hub-help").hidden = !perNetworkHub();
  await renderNetworks($("wifi-list"), "wifi-result", { remove: true });
}

$("btn-scan").onclick = (ev) => act("wifi-result", async () => {
  const { networks } = await device.call("wifi.scan", undefined, 20000);
  const dl = $("wifi-found");
  dl.innerHTML = "";
  const seen = new Set();
  for (const n of networks.sort((a, b) => b.rssi - a.rssi)) {
    if (!n.ssid || seen.has(n.ssid)) continue;
    seen.add(n.ssid);
    const o = document.createElement("option");
    o.value = n.ssid;
    o.label = `${n.rssi} dBm${n.secure ? "" : " · aberta"}`;
    dl.append(o);
  }
  $("wifi-ssid").focus();
  return `${seen.size} redes encontradas — clique no campo "Nome da rede" para escolher.`;
}, ev.currentTarget);

$("f-wifi").onsubmit = (ev) => {
  ev.preventDefault();
  act("wifi-result", async () => {
    const ssid = $("wifi-ssid").value.trim();
    const args = { ssid, password: $("wifi-pass").value };
    if (perNetworkHub() && $("wifi-hub").value.trim()) args.hub_url = $("wifi-hub").value.trim();
    const r = await device.call("wifi.set", args);
    $("wifi-pass").value = "";
    $("wifi-hub").value = "";
    await loadWifi();
    return `Rede "${ssid}" salva (prioridade ${r.priority})${r.hub_url ? `, servidor ${r.hub_url}` : ""}. Clique em "Testar conexão".`;
  }, ev.submitter);
};

$("btn-wifi-test").onclick = (ev) => act("wifi-result", async () => {
  const ssid = $("wifi-ssid").value.trim() || undefined;
  const r = await device.call("wifi.test", ssid ? { ssid } : {}, 60000);
  return `Conectado em "${r.ssid}" — IP ${r.ip}, sinal ${r.rssi} dBm (${(r.connect_ms / 1000).toFixed(1)} s).`;
}, ev.currentTarget);

// ---------- Servidor ----------

async function loadHub() {
  const st = await device.call("status");
  const cfg = await loadConfig();
  $("hub-url").value = st.hub.url ?? "";
  $("hub-token").placeholder = st.hub.has_token ? "(salvo — deixe vazio para manter)" : "cole o token gerado no Hub";
  $("hub-channel").value = cfg.firmware.channel;
  $("hub-nets-box").hidden = !perNetworkHub();
  if (perNetworkHub()) await renderNetworks($("hub-nets"), "hub-result");
}

$("f-hub").onsubmit = (ev) => {
  ev.preventDefault();
  act("hub-result", async () => {
    const args = { url: $("hub-url").value.trim(), update_url: $("hub-upd").value.trim(), channel: $("hub-channel").value };
    const tok = $("hub-token").value.trim();
    if (tok) args.device_token = tok;
    const r = await device.call("hub.set", args);
    $("hub-token").value = "";
    $("hub-token").placeholder = r.has_token ? "(salvo — deixe vazio para manter)" : "cole o token gerado no Hub";
    return "Servidor salvo." + (r.has_token ? "" : " Falta o token do aparelho.");
  }, ev.submitter);
};

$("btn-hub-test").onclick = (ev) => act("hub-result", async () => {
  const r = await device.call("hub.test", undefined, 60000);
  const which = r.url ? ` ${r.url}${r.ssid ? ` (rede "${r.ssid}")` : ""}` : "";
  if (!r.ok) throw new Error(`Servidor${which} respondeu HTTP ${r.http_status}.`);
  return `Servidor${which} OK — respondeu em ${r.latency_ms} ms${r.server_time ? " · hora do servidor " + r.server_time : ""}.`;
}, ev.currentTarget);

// ---------- Data e hora ----------

let tzFilled = false;
let clockTimer = null;

function fmt(ms, tz) {
  return new Date(ms).toLocaleString("pt-BR", { timeZone: tz, dateStyle: "short", timeStyle: "medium" });
}

async function loadTime() {
  if (!tzFilled) {
    const dl = $("tz-list");
    for (const z of allTimezones()) {
      const o = document.createElement("option");
      o.value = z;
      dl.append(o);
    }
    tzFilled = true;
  }
  const st = await device.call("status");
  const tz = st.timezone || localTimezone();
  $("tz").value = tz;
  updatePosix();
  const devOffset = st.time_utc ? st.time_utc * 1000 - Date.now() : null;
  clearInterval(clockTimer);
  const tick = () => {
    const z = validTz($("tz").value) ? $("tz").value : localTimezone();
    $("t-pc").textContent = fmt(Date.now(), z);
    $("t-device").textContent = devOffset === null ? "não acertada" : fmt(Date.now() + devOffset, z) +
      (Math.abs(devOffset) > 60000 ? ` (diferença de ${Math.round(devOffset / 60000)} min)` : "");
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function validTz(z) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function updatePosix() {
  const z = $("tz").value.trim();
  $("tz-posix").textContent = validTz(z) ? ianaToPosix(z) : "fuso inválido";
}
$("tz").oninput = updatePosix;

$("f-time").onsubmit = (ev) => {
  ev.preventDefault();
  act("time-result", async () => {
    const z = $("tz").value.trim();
    if (!validTz(z)) throw new Error("Escolha um fuso da lista.");
    const utc = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    await device.call("time.set", { utc, tz: ianaToPosix(z), timezone: z });
    await loadTime();
    return "Relógio acertado. A tela do aparelho foi atualizada.";
  }, ev.submitter);
};

// ---------- Medição e tela ----------

async function loadMeasure() {
  const c = await loadConfig();
  $("m-profile").value = c.energy_profile;
  $("m-custom").value = Math.round(c.battery.measure_s / 60);
  $("m-usb").value = Math.round(c.usb.measure_s / 60);
  $("m-title").value = c.display.title;
  $("m-unit").value = c.display.temp_unit;
  $("m-clock").checked = c.display.show_clock;
  $("m-fullref").value = c.display.full_refresh_every;
  $("m-door").value = c.door?.mode ?? "auto";
  $("m-door-alert").value = Math.round((c.door?.alert_after_s ?? 300) / 60);
  $("m-door").disabled = !c.door;  // firmware antigo, sem sensor de porta
  $("m-door-alert-wrap").hidden = $("m-door").value === "off";
  $("m-custom-wrap").hidden = c.energy_profile !== "personalizado";
}
$("m-door").onchange = () => ($("m-door-alert-wrap").hidden = $("m-door").value === "off");
$("m-profile").onchange = () => ($("m-custom-wrap").hidden = $("m-profile").value !== "personalizado");

$("f-measure").onsubmit = (ev) => {
  ev.preventDefault();
  act("measure-result", async () => {
    const profile = $("m-profile").value;
    const patch = {
      energy_profile: profile,
      usb: { measure_s: Math.round(+$("m-usb").value * 60) },
      display: {
        title: $("m-title").value.trim(),
        temp_unit: $("m-unit").value,
        show_clock: $("m-clock").checked,
        full_refresh_every: Math.round(+$("m-fullref").value) || 20,
      },
    };
    if (config?.door) patch.door = { mode: $("m-door").value, alert_after_s: Math.round(+$("m-door-alert").value * 60) };
    if (profile === "personalizado") {
      const s = Math.round(+$("m-custom").value * 60);
      patch.battery = { measure_s: s, sync_s: Math.max(s, 1800) };
    }
    const c = await device.call("config.set", patch);
    config = c;
    return `Salvo. Na bateria mede a cada ${Math.round(c.battery.measure_s / 60)} min.`;
  }, ev.submitter);
};

// ---------- Calibração ----------

async function loadCal() {
  const c = await loadConfig();
  $("c-temp").value = c.calibration.temp_offset_c;
  $("c-hum").value = c.calibration.hum_offset_pct;
  $("c-probe").value = c.calibration.probe_offset_c ?? 0;
  $("c-probe").disabled = c.calibration.probe_offset_c === undefined;
  $("c-wires").value = c.probe?.wires ?? 4;
  $("c-wires").disabled = !c.probe;  // firmware antes da 0.9.0 não tem PT100
}

$("f-cal").onsubmit = (ev) => {
  ev.preventDefault();
  act("cal-result", async () => {
    await device.call("calibration.set", {
      temp_offset_c: +$("c-temp").value || 0,
      hum_offset_pct: +$("c-hum").value || 0,
      ...($("c-probe").disabled ? {} : { probe_offset_c: +$("c-probe").value || 0 }),
      calibrated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    });
    if (!$("c-wires").disabled) await device.call("config.set", { probe: { wires: +$("c-wires").value } });
    await refreshStatus();
    return "Calibração salva. A próxima medição já sai ajustada.";
  }, ev.submitter);
};

// ---------- Sistema ----------

async function loadSystem() {
  const info = await device.call("info");
  const st = await device.call("status");
  const rows = [
    ["ID", info.device_id],
    ["MAC", info.mac],
    ["Firmware", "v" + info.fw_version + " (" + info.app_partition + ")"],
    ["Chip", `${info.chip} rev ${info.chip_rev}, ${info.flash_mb} MB`],
    ["Sensor", info.sensor ?? "não encontrado"],
    ["Wi-Fi", st.wifi.connected ? `conectado, IP ${st.wifi.ip}` : `${st.wifi.saved_networks} rede(s) salva(s), desconectado`],
    ["Servidor", st.hub.active_url ? `${st.hub.active_url} (rede conectada)` : st.hub.url ?? (st.hub.per_network ? "padrão não configurado (veja servidor por rede na aba Wi-Fi)" : "não configurado")],
  ];
  const dl = $("sys-info");
  dl.innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  try {
    const m = await loadManifest();
    $("sys-avail").textContent = "(v" + m.version + ")";
  } catch {
    $("sys-avail").textContent = "";
  }
  $("ota-source").textContent = st.update?.url ?? "—";
  $("ota-auto").checked = st.update?.auto ?? true;
  $("ota-available").textContent = "clique em Verificar agora";
  $("btn-ota-update").hidden = true;
}

$("ota-auto").onchange = () => act("ota-result", async () => {
  await device.call("config.set", { firmware: { auto_update: $("ota-auto").checked } });
  return $("ota-auto").checked ? "Atualização automática ligada." : "Atualização automática desligada.";
});

$("btn-ota-check").onclick = (ev) => act("ota-result", async () => {
  const r = await device.call("firmware.check", undefined, 60000);
  $("ota-available").textContent = "v" + r.available + (r.rolled_back === r.available ? " (foi desfeita por falha)" : "");
  $("btn-ota-update").hidden = !r.update_available;
  return r.update_available ? `Versão nova disponível: v${r.available} (atual v${r.current}).` : `Já está na versão mais nova (v${r.current}).`;
}, ev.currentTarget);

$("btn-ota-update").onclick = (ev) => {
  if (!confirm("Atualizar o aparelho pela internet agora? Não desconecte o cabo durante a atualização (~1 min).")) return;
  act("ota-result", async () => {
    const r = await device.call("firmware.update", undefined, 30000);
    return `Instalando v${r.installing}…`;
  }, ev.currentTarget);
};

$("btn-bat-replaced").onclick = (ev) => {
  if (!confirm("Registrar que a bateria foi trocada agora? Isso zera ciclos, saúde e o histórico de autonomia.")) return;
  act("bat-result", async () => {
    const r = await device.call("battery.replaced");
    showBattery(r.battery);
    return "Troca registrada.";
  }, ev.currentTarget);
};

$("btn-reboot").onclick = (ev) => act("sys-result", async () => {
  await device.call("reboot");
  return "Reiniciando…";
}, ev.currentTarget);

$("btn-factory").onclick = async (ev) => {
  if (!confirm("Apagar Wi-Fi, servidor, token e configurações deste aparelho?\n\nDepois de confirmar aqui, aperte o botão de cima do aparelho em até 30 segundos.")) return;
  act("sys-result", async () => {
    result("sys-result", "Aperte o botão de cima do aparelho…");
    await device.call("factory_reset", { confirm: "APAGAR" }, 40000);
    return "Aparelho apagado e reiniciando com as configurações de fábrica.";
  }, ev.currentTarget);
};

// ---------- instalar firmware ----------

async function install(eraseAll) {
  if (!port) return;
  busy = true;
  try {
    await disconnect();
    show("v-flash");
    setConn("Instalando…", false);
    $("flash-log").textContent = "";
    const log = (t) => {
      $("flash-log").textContent += t + "\n";
      $("flash-log").scrollTop = 1e9;
    };
    const version = await flash(port, {
      eraseAll,
      onLog: log,
      onProgress: (f) => ($("flash-progress").value = f),
    });
    log(`VT SENTINEL v${version} instalado.`);
    await new Promise((r) => setTimeout(r, 1500));
  } catch (e) {
    alert("Falha na instalação: " + errText(e) + "\n\nReconecte o cabo e tente de novo.");
  } finally {
    busy = false;
  }
  await connect(port);
}

$("btn-install-new").onclick = () => install(true);
$("btn-reflash").onclick = () => {
  if (confirm("Reinstalar o firmware? As configurações (Wi-Fi, servidor) são mantidas.")) install(false);
};
$("btn-retry").onclick = () => connect(port);

// ---------- início ----------

$("btn-connect").onclick = async () => {
  try {
    const p = await navigator.serial.requestPort({ filters: USB_FILTERS });
    await connect(p);
  } catch (e) {
    if (e.name !== "NotFoundError") alert(errText(e));
  }
};

async function start() {
  if (!("serial" in navigator)) {
    show("v-unsupported");
    return;
  }
  navigator.serial.addEventListener("connect", (e) => connect(e.target));  // reconhece ao espetar o cabo
  navigator.serial.addEventListener("disconnect", (e) => {
    if (e.target === port && !busy) onDisconnect();
  });
  const known = await navigator.serial.getPorts();
  if (known.length) await connect(known[0]);
  else show("v-empty");
}

// Instalar como aplicativo (atalho no menu Iniciar, janela própria)
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("btn-install-app").hidden = false;
});
$("btn-install-app").onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("btn-install-app").hidden = true;
};
if (!EMBED && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

start();
