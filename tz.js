// Converte um fuso IANA ("Europe/Lisbon") na regra POSIX TZ que o firmware usa ("<+00>0<+01>-1,M3.5.0/1,M10.5.0/2").
// O navegador já tem a base de fusos (Intl); daqui saem o deslocamento padrão, o de verão e as datas de troca.

const partsFmt = new Map();

// Deslocamento (minutos a leste de UTC) do fuso `tz` no instante `ms`.
function offsetAt(tz, ms) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

// Instante (ms) da troca de deslocamento entre a e b (a < b), com precisão de 1 minuto.
function findTransition(tz, a, b) {
  const oa = offsetAt(tz, a);
  while (b - a > 60000) {
    const m = a + Math.floor((b - a) / 2 / 60000) * 60000;
    if (offsetAt(tz, m) === oa) a = m;
    else b = m;
  }
  return b;
}

// Nome POSIX numérico: <-03>, <+0530>.
function posixName(off) {
  const s = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  const hh = String(Math.floor(a / 60)).padStart(2, "0");
  const mm = a % 60 ? String(a % 60).padStart(2, "0") : "";
  return `<${s}${hh}${mm}>`;
}

// Deslocamento no formato POSIX (sinal invertido: UTC-3 → "3", UTC+5:30 → "-5:30").
function posixOffset(off) {
  const inv = -off;
  const s = inv < 0 ? "-" : "";
  const a = Math.abs(inv);
  const h = Math.floor(a / 60), m = a % 60;
  return s + h + (m ? ":" + String(m).padStart(2, "0") : "");
}

// Regra "Mm.w.d/hh[:mm]" para uma troca que acontece em `ms`, com a hora local de antes da troca.
function posixRule(ms, offBefore) {
  const local = new Date(ms + offBefore * 60000);  // campos UTC = hora local antes da troca
  const y = local.getUTCFullYear(), mo = local.getUTCMonth(), d = local.getUTCDate();
  const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const week = d + 7 > dim ? 5 : Math.ceil(d / 7);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const time = mins === 120 ? "" : "/" + Math.floor(mins / 60) + (mins % 60 ? ":" + String(mins % 60).padStart(2, "0") : "");
  return `M${mo + 1}.${week}.${local.getUTCDay()}${time}`;
}

export function ianaToPosix(tz, year = new Date().getUTCFullYear()) {
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  const day = 86400000;
  const changes = [];
  let prev = offsetAt(tz, start);
  for (let t = start + day; t <= end; t += day) {
    const o = offsetAt(tz, t);
    if (o !== prev) {
      changes.push({ at: findTransition(tz, t - day, t), from: prev, to: o });
      prev = o;
    }
  }
  if (changes.length !== 2) {  // sem horário de verão (ou regra irregular): usa o deslocamento de agora
    const now = offsetAt(tz, Date.now());
    return posixName(now) + posixOffset(now);
  }
  const std = Math.min(changes[0].from, changes[0].to);
  const dst = Math.max(changes[0].from, changes[0].to);
  const toDst = changes.find((c) => c.to === dst);
  const toStd = changes.find((c) => c.to === std);
  let rule = posixName(std) + posixOffset(std) + posixName(dst);
  if (dst - std !== 60) rule += posixOffset(dst);
  return rule + "," + posixRule(toDst.at, std) + "," + posixRule(toStd.at, dst);
}

export function allTimezones() {
  return Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : ["America/Sao_Paulo", "UTC"];
}

export function localTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
