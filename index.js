// 别忘了 · 同步后端 (Cloudflare Worker + D1)
// 路由:
//   POST /api/sync          推送本机改动 + 拉取别人的改动(需家庭密码)
//   GET  /ics/<token>.ics   只读日历订阅(iPhone / Google 日历订阅用)
// 机密(用 wrangler secret put 设置): FAMILY_PASSWORD, ICS_TOKEN
// 变量(wrangler.toml): ALLOWED_ORIGINS, DEFAULT_REMINDER_MIN

const enc = new TextEncoder();
const MAX_CHANGES = 100;
const MAX_DATA = 32768;
const PAGE = 500;
const D1_CHUNK = 40;

async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(ha, hb);
  const x = new Uint8Array(ha), y = new Uint8Array(hb); // 备用:逐字节比较(两边都是 32 字节摘要)
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && (allowed.includes(origin) || allowed.includes("*"))) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    };
  }
  return { "Vary": "Origin" };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...cors },
  });
}

function validChange(c) {
  return (
    c && typeof c.id === "string" && /^[\w-]{1,64}$/.test(c.id) &&
    Number.isFinite(c.updatedAt) && c.updatedAt >= 0 &&
    typeof c.data === "string" && c.data.length <= MAX_DATA
  );
}

async function handleSync(req, env, cors) {
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "bad json" }, 400, cors); }
  const since = Number(body.since) || 0;
  const changes = (Array.isArray(body.changes) ? body.changes : []).slice(0, MAX_CHANGES).filter(validChange);

  // 只有"比库里更新"的改动才会被接受(后写者胜);rev 是服务器自增游标,客户端据此增量拉取
  const upsert = `INSERT INTO events(id,data,updated_at,deleted,rev)
    VALUES(?1,?2,?3,?4,(SELECT COALESCE(MAX(rev),0)+1 FROM events))
    ON CONFLICT(id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,
      deleted=excluded.deleted,rev=excluded.rev
    WHERE excluded.updated_at>events.updated_at`;
  const stmts = changes.map((c) =>
    env.DB.prepare(upsert).bind(c.id, c.deleted ? "{}" : c.data, Math.floor(c.updatedAt), c.deleted ? 1 : 0)
  );
  for (let i = 0; i < stmts.length; i += D1_CHUNK) await env.DB.batch(stmts.slice(i, i + D1_CHUNK));

  const { results } = await env.DB
    .prepare("SELECT id,data,updated_at,deleted,rev FROM events WHERE rev>?1 ORDER BY rev LIMIT ?2")
    .bind(since, PAGE + 1).all();
  const more = results.length > PAGE;
  const rows = more ? results.slice(0, PAGE) : results;
  const cursor = rows.length ? rows[rows.length - 1].rev : since;
  return json({
    changes: rows.map((r) => ({ id: r.id, data: r.data, updatedAt: r.updated_at, deleted: r.deleted, rev: r.rev })),
    cursor, more,
    icsPath: env.ICS_TOKEN ? "/ics/" + encodeURIComponent(env.ICS_TOKEN) + ".ics" : "",
  }, 200, cors);
}

/* ---------------- ICS ---------------- */
const pad = (n) => String(n).padStart(2, "0");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const ICS_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function esc(s) {
  return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
function fold(line) { // 按 UTF-8 字节折行(每行 ≤75 字节),中文不会被截断
  let out = "", cur = "", len = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (len + b > 75) { out += cur + "\r\n "; cur = ""; len = 1; }
    cur += ch; len += b;
  }
  return out + cur;
}
function utcStamp(ms) {
  const d = new Date(ms || Date.now());
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
}
function dOnly(s) { return s.replace(/-/g, ""); }
function dtLocal(date, time) { return dOnly(date) + "T" + time.replace(":", "") + "00"; }
function nextDay(s) {
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return t.getUTCFullYear() + pad(t.getUTCMonth() + 1) + pad(t.getUTCDate());
}
function weekdayOf(s) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }

function vevent(id, ev, updatedAt, defLead) {
  if (!ev || !DATE_RE.test(ev.date || "")) return [];
  const allDay = !!ev.allDay;
  const st = TIME_RE.test(ev.start || "") ? ev.start : "09:00";
  const en = TIME_RE.test(ev.end || "") ? ev.end : "10:00";
  const L = ["BEGIN:VEVENT", "UID:" + id + "@dontforget", "DTSTAMP:" + utcStamp(updatedAt),
    "SEQUENCE:" + (ev.seq | 0), "SUMMARY:" + esc(ev.title || "未命名")];
  if (allDay) { L.push("DTSTART;VALUE=DATE:" + dOnly(ev.date), "DTEND;VALUE=DATE:" + nextDay(ev.date)); }
  else { L.push("DTSTART:" + dtLocal(ev.date, st), "DTEND:" + dtLocal(ev.date, en)); }

  const ex = (d) => (allDay ? "EXDATE;VALUE=DATE:" + dOnly(d) : "EXDATE:" + dtLocal(d, st));
  const r = ev.recurrence;
  const byday = r && r.freq === "weekly" && Array.isArray(r.byday)
    ? [...new Set(r.byday.filter((x) => Number.isInteger(x) && x >= 0 && x <= 6))].sort() : [];
  if (byday.length) {
    let rule = "RRULE:FREQ=WEEKLY;WKST=MO";
    if (r.interval > 1) rule += ";INTERVAL=" + Math.min(52, r.interval | 0);
    rule += ";BYDAY=" + byday.map((x) => ICS_DAY[x]).join(",");
    if (r.until && DATE_RE.test(r.until)) rule += ";UNTIL=" + dOnly(r.until) + (allDay ? "" : "T235959");
    L.push(rule);
    // 网页只在勾选的星期出现;起始日若不在其中,日历软件会多显示一次,这里排除掉
    if (!byday.includes(weekdayOf(ev.date))) L.push(ex(ev.date));
    (Array.isArray(ev.skip) ? ev.skip : []).filter((s) => DATE_RE.test(s)).forEach((s) => L.push(ex(s)));
  }
  const desc = [ev.notes, Array.isArray(ev.people) && ev.people.length ? "参与:" + ev.people.join("、") : ""].filter(Boolean).join(" | ");
  if (desc) L.push("DESCRIPTION:" + esc(desc));
  if (ev.location) L.push("LOCATION:" + esc(ev.location));
  const lead = ev.reminderLead === null || ev.reminderLead === undefined ? defLead : Number(ev.reminderLead);
  if (lead >= 0 && !allDay) L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + esc(ev.title || "提醒"), "TRIGGER:-PT" + (lead | 0) + "M", "END:VALARM");
  L.push("END:VEVENT");
  return L;
}

async function handleIcs(env) {
  const { results } = await env.DB
    .prepare("SELECT id,data,updated_at FROM events WHERE deleted=0 AND id!='__meta__'").all();
  const defLead = Number.isFinite(+env.DEFAULT_REMINDER_MIN) ? +env.DEFAULT_REMINDER_MIN : 30;
  let L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DontForget//Sync//CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:别忘了", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const row of results) {
    let ev; try { ev = JSON.parse(row.data); } catch (e) { continue; }
    L = L.concat(vevent(row.id, ev, row.updated_at, defLead));
  }
  L.push("END:VCALENDAR");
  return new Response(L.map(fold).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const m = url.pathname.match(/^\/ics\/([^/]+)\.ics$/);
    if (m && req.method === "GET") {
      if (!env.ICS_TOKEN || !(await safeEqual(decodeURIComponent(m[1]), env.ICS_TOKEN))) return new Response("Not found", { status: 404 });
      return handleIcs(env);
    }

    if (url.pathname === "/api/sync" && req.method === "POST") {
      if (!env.FAMILY_PASSWORD) return json({ error: "服务未配置 FAMILY_PASSWORD" }, 500, cors);
      const a = /^Bearer (.+)$/.exec(req.headers.get("Authorization") || "");
      if (!a || !(await safeEqual(a[1], env.FAMILY_PASSWORD))) return json({ error: "unauthorized" }, 401, cors);
      return handleSync(req, env, cors);
    }

    return new Response("别忘了 sync service", { status: 200, headers: cors });
  },
};
