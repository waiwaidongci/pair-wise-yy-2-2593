import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.PIGEON_DB || join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);
const VACCINE_DEFAULT_DAYS = 180;

function seed() {
  const d = new Date();
  const iso = off => {
    const x = new Date(d); x.setDate(x.getDate() + off);
    return x.toISOString().slice(0, 10);
  };
  return {
    pigeons: [
      {
        ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512",
        color: "灰", loft: "北岸A棚",
        vaccines: [{ id: "v-seed-1", date: iso(-200), name: "新城疫", expiresOn: iso(-20) }],
        transfers: [{ id: "t-seed-1", date: iso(-170), from: "育种棚", to: "北岸棚", settled: true }],
        races: [{ date: iso(-30), event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18, owner: "北岸棚" }]
      },
      {
        ringNo: "CHN-2026-002", owner: "东湾棚", fatherRing: "", motherRing: "",
        color: "雨点", loft: "东湾一号棚",
        vaccines: [{ id: "v-seed-2", date: iso(-30), name: "新城疫+腺病毒", expiresOn: iso(150) }],
        transfers: [], races: []
      },
      {
        ringNo: "CHN-2026-003", owner: "西岭新棚", fatherRing: "CHN-2022-188", motherRing: "",
        color: "深雨点", loft: "西岭棚",
        vaccines: [{ id: "v-seed-3", date: iso(-10), name: "巴拉米哥", expiresOn: iso(170) }],
        transfers: [{ id: "t-seed-2", date: iso(-3), from: "南岸老棚", to: "西岭新棚", settled: false }],
        races: []
      },
      { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
      { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
    ],
    events: [
      { id: "ev-300", name: "秋季300公里资格赛", date: iso(10), distance: 300 },
      { id: "ev-500", name: "秋季500公里正赛", date: iso(24), distance: 500 },
      { id: "ev-old", name: "已开赛200公里站", date: iso(-5), distance: 200 }
    ],
    slots: [],
    conflicts: []
  };
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed(), null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 兼容旧库：补齐赛事、名额、冲突三张表与字段
  let changed = false;
  if (!Array.isArray(db.events)) { db.events = seed().events; changed = true; }
  if (!Array.isArray(db.slots)) { db.slots = []; changed = true; }
  if (!Array.isArray(db.conflicts)) { db.conflicts = []; changed = true; }
  const fresh = seed();
  for (const p of fresh.pigeons) {
    if (!db.pigeons.some(x => x.ringNo === p.ringNo)) { db.pigeons.push(p); changed = true; }
  }
  for (const p of db.pigeons) {
    for (const v of p.vaccines || []) {
      if (!v.id) { v.id = "v-" + randomUUID(); changed = true; }
      if (!v.expiresOn) { v.expiresOn = shiftDate(v.date, VACCINE_DEFAULT_DAYS); changed = true; }
    }
    for (const t of p.transfers || []) {
      if (!t.id) { t.id = "t-" + randomUUID(); changed = true; }
      if (typeof t.settled !== "boolean") { t.settled = true; changed = true; }
    }
    for (const r of p.races || []) {
      if (!r.owner) { r.owner = ownerAt(p, r.date) || p.owner; changed = true; }
    }
  }
  if (changed) await saveDb(db);
  return db;
}
async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

// 串行化写操作：两人同时提交时，先到者占用名额，后到者落冲突
let chain = Promise.resolve();
function withLock(task) {
  const run = chain.then(() => task());
  chain = run.then(() => {}, () => {});
  return run;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function shiftDate(dateText, days) {
  const x = new Date(dateText + "T00:00:00Z");
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}
function started(ev) {
  return new Date(ev.date + "T08:00:00") < new Date();
}
// 转棚后成绩归属：以归巢日期按转让链重建原鸽主（不用当前 owner 反推），录入后固化，不再随档案变动
function ownerAt(pigeon, dateText) {
  const ts = [...pigeon.transfers].sort((a, b) => a.date.localeCompare(b.date));
  if (!ts.length) return pigeon.owner;
  let owner = ts[0].from;
  for (const t of ts) {
    if (t.date <= dateText) owner = t.to;
  }
  return owner;
}
function evaluate(db, pigeon, ev, applicant) {
  const problems = [];
  if (!pigeon) return { ok: false, problems: [{ code: "pigeon_not_found", detail: "足环号不存在" }] };
  if (!ev) return { ok: false, problems: [{ code: "event_not_found", detail: "赛事不存在" }] };
  if (started(ev)) problems.push({ code: "event_started", detail: ev.name + " 已开赛，不再接受报名" });
  const validVax = (pigeon.vaccines || []).some(v => v.date <= ev.date && v.expiresOn >= ev.date);
  if (!validVax) problems.push({ code: "vaccine_expired", detail: "疫苗在比赛日 " + ev.date + " 前到期或缺失" });
  const unsettled = (pigeon.transfers || []).filter(t => !t.settled);
  if (unsettled.length) problems.push({ code: "transfer_unsettled", detail: "转棚未结清：" + unsettled.map(t => t.from + "→" + t.to).join("、") });
  // 提交人一致性仅在实际报名提交时校验，不影响资格表/确认时的硬门槛判断
  if (applicant != null && applicant !== "" && applicant !== pigeon.owner) problems.push({ code: "owner_mismatch", detail: "提交人 “" + applicant + "” 与现鸽主 “" + pigeon.owner + "” 不一致" });
  return { ok: problems.length === 0, problems };
}
function basis(pigeon) {
  return {
    owner: pigeon.owner,
    vaccines: pigeon.vaccines.map(v => ({ id: v.id, date: v.date, expiresOn: v.expiresOn })),
    transfers: pigeon.transfers.map(t => ({ id: t.id, date: t.date, settled: t.settled }))
  };
}
// 档案/疫苗/转让更正后，未开赛名额失效重算
function invalidatePending(db, ringNo, reason) {
  for (const s of db.slots) {
    if (s.ringNo !== ringNo || s.status !== "pending") continue;
    const ev = db.events.find(e => e.id === s.eventId);
    if (ev && !started(ev)) {
      s.status = "invalidated";
      s.staleReason = reason;
      s.invalidatedAt = new Date().toISOString();
    }
  }
}
function slotView(db, s) {
  const ev = db.events.find(e => e.id === s.eventId);
  return { ...s, eventName: ev ? ev.name : s.eventId, eventDate: ev ? ev.date : "", started: ev ? started(ev) : false };
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  return { pigeon, father, mother, children };
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛季报名核验台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --amber:#9a6a1c; --green:#2e6b44; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0 0 6px; font-size:15px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:18px; padding:18px 28px; align-items:start; }
    form,.panel,.card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:14px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px; }
    button.ghost { background:#eef3f7; color:var(--accent); border:1px solid var(--line); }
    button.warn { background:var(--amber); }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { text-align:left; border-bottom:1px solid var(--line); padding:7px 6px; vertical-align:top; }
    th { color:var(--muted); font-weight:600; }
    .meta { color:var(--muted); font-size:12px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; margin:2px 4px 2px 0; }
    .pill.pending { background:#f4f0e4; color:var(--amber); border-color:#e2d3a5; }
    .pill.confirmed { background:#e8f3ec; color:var(--green); border-color:#b9d8c5; }
    .pill.invalidated { background:#f6e8e6; color:var(--red); border-color:#e0bdb7; }
    .pill.conflict { background:#f6e8e6; color:var(--red); border-color:#e0bdb7; }
    .pill.ok { background:#e8f3ec; color:var(--green); border-color:#b9d8c5; }
    .pill.bad { background:#f6e8e6; color:var(--red); border-color:#e0bdb7; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
    .msg { font-size:13px; margin-top:8px; padding:8px; border-radius:6px; display:none; }
    .msg.show { display:block; } .msg.err { background:#f6e8e6; color:var(--red); } .msg.ok2 { background:#e8f3ec; color:var(--green); }
    .sub { color:var(--muted); font-size:12px; margin:2px 0 8px; }
    .inline { display:flex; gap:6px; align-items:center; }
    @media (max-width:960px){ header{display:block;padding:16px;} main{grid-template-columns:1fr;padding:14px;} }
  </style>
</head>
<body>
  <header>
    <div><h1>赛季报名核验台</h1><div class="meta">赛鸽档案 · 疫苗记录 · 转让记录 · 归巢成绩 —— 每只鸽每场比赛只留一个待确认名额</div></div>
    <button id="reload">刷新</button>
  </header>
  <main>
    <div>
      <form id="regForm" class="panel">
        <h2>现场报名 / 重试</h2>
        <div class="sub">两人同时提交：先到者占用名额，后到者留冲突。写盘失败可凭现场单原样重试，不重复生成名额。</div>
        <label>足环号</label><select name="ringNo" id="regRing"></select>
        <label>比赛</label><select name="eventId" id="regEvent"></select>
        <label>提交人（鸽主）</label><input name="applicant" placeholder="如 北岸棚">
        <label>现场单号（留空自动生成；重试请填原单）</label><input name="ticket" placeholder="T-...">
        <div class="row" style="margin-top:10px;">
          <button>提交报名</button>
          <label class="inline meta"><input type="checkbox" name="failNext" style="width:auto;"> 模拟本次写盘失败</label>
        </div>
        <div class="msg" id="regMsg"></div>
      </form>

      <form id="profileForm" class="panel">
        <h2>档案更正</h2>
        <label>足环号</label><select name="ringNo" id="pfRing"></select>
        <div class="grid2">
          <div><label>鸽主</label><input name="owner"></div>
          <div><label>出生棚号</label><input name="loft"></div>
          <div><label>羽色</label><input name="color"></div>
          <div><label>父鸽足环</label><input name="fatherRing"></div>
          <div><label>母鸽足环</label><input name="motherRing"></div>
        </div>
        <div class="row" style="margin-top:10px;"><button class="ghost">保存更正</button></div>
        <div class="msg" id="pfMsg"></div>
        <div class="sub">保存后，该鸽所有<b>未开赛</b>的待确认名额失效，需重新核验。</div>
      </form>

      <form id="vaccineForm" class="panel">
        <h2>疫苗更正 / 补录</h2>
        <label>足环号</label><select name="ringNo" id="vcRing"></select>
        <div class="grid2">
          <div><label>接种日期</label><input name="date" type="date"></div>
          <div><label>到期日期</label><input name="expiresOn" type="date"></div>
        </div>
        <label>疫苗名称</label><input name="name" placeholder="如 新城疫">
        <div class="row" style="margin-top:10px;"><button class="ghost">保存疫苗</button></div>
        <div class="msg" id="vcMsg"></div>
      </form>
    </div>

    <div>
      <div class="panel">
        <h2>待确认名额</h2>
        <div id="slots"></div>
      </div>
      <div class="panel">
        <h2>冲突记录</h2>
        <div id="conflicts"></div>
      </div>
      <div class="panel">
        <h2>逐场报名资格核验</h2>
        <div id="eligibility"></div>
      </div>
      <div class="panel">
        <h2>赛鸽档案 / 转让 / 归巢成绩</h2>
        <div class="row" style="margin-bottom:10px;">
          <input id="search" placeholder="输入足环号查询血统" style="max-width:240px;">
          <button class="ghost" id="searchBtn">查询血统</button>
        </div>
        <div id="detail" class="meta">输入足环号查看父母、子代、转让与归巢（已开赛成绩归原鸽主）。</div>
        <div id="cards"></div>
      </div>
    </div>
  </main>
  <script>
    let state = { pigeons: [], events: [], slots: [], conflicts: [] };
    const $ = s => document.querySelector(s);
    function esc(v){ return String(v == null ? "" : v).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\x22":"&quot;"}[c])); }
    async function api(path, options) {
      const opts = options || {};
      if (opts.body) { opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {}); opts.body = JSON.stringify(opts.body); }
      const res = await fetch(path, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || "请求失败"), { data });
      return data;
    }
    function setMsg(el, ok, text) { el.className = "msg show " + (ok ? "ok2" : "err"); el.textContent = text; }
    const REASON = {
      vaccine_expired: "疫苗到期/缺失", transfer_unsettled: "转让未结清", event_started: "比赛已开赛",
      pigeon_not_found: "鸽只不存在", event_not_found: "赛事不存在", owner_mismatch: "鸽主不一致",
      slot_pending: "已有待确认名额", slot_confirmed: "名额已确认"
    };
    function reasonText(r) {
      if (!r) return "";
      if (r.code === "vaccine_expired" || r.code === "transfer_unsettled" || r.code === "owner_mismatch") return r.detail;
      return REASON[r.code] || r.code;
    }

    function ringOptions() {
      return state.pigeons.map(p => '<option value="'+esc(p.ringNo)+'">'+esc(p.ringNo)+" · "+esc(p.owner)+'</option>').join("");
    }
    function eventOptions() {
      return state.events.map(e => '<option value="'+esc(e.id)+'">'+esc(e.name)+"（"+esc(e.date)+(isStarted(e) ? "，已开赛" : "")+'）</option>').join("");
    }
    function isStarted(e){ return new Date(e.date + "T08:00:00") < new Date(); }

    function renderSlots() {
      const list = state.slots.slice().sort((a,b)=> String(b.createdAt).localeCompare(String(a.createdAt)));
      if (!list.length) { $("#slots").innerHTML = '<div class="meta">暂无名额。</div>'; return; }
      $("#slots").innerHTML = '<table><tr><th>状态</th><th>足环号 / 鸽主</th><th>比赛</th><th>核验</th><th>现场单</th><th>操作</th></tr>' +
        list.map(s => {
          const label = { pending:"待确认", confirmed:"已确认", invalidated:"已失效" }[s.status];
          const recheck = s.status === "pending" && s.recheck && s.recheck.ok === false
            ? '<br><span class="pill bad">重算不通过：'+esc(s.recheck.problems.map(reasonText).join("；"))+'</span>'
            : s.status === "pending" ? '<span class="pill ok">重算通过</span>' : "";
          const stale = s.staleReason ? '<br><span class="meta">失效原因：'+esc(s.staleReason)+'</span>' : "";
          const ops = s.status === "pending"
            ? '<button data-confirm="'+esc(s.id)+'">确认</button> <button class="ghost" data-recheck="'+esc(s.id)+'">重新核验</button>'
            : s.status === "invalidated" ? '<button class="ghost" data-rereg="'+esc(s.ringNo)+"|"+esc(s.eventId)+'">按此重新报名</button>' : "";
          return '<tr><td><span class="pill '+s.status+'">'+label+'</span>'+stale+'</td>'+
            '<td>'+esc(s.ringNo)+'<br><span class="meta">'+esc(s.owner)+' / 提交人 '+esc(s.applicant||"")+'</span></td>'+
            '<td>'+esc(s.eventName)+'<br><span class="meta">'+esc(s.eventDate)+(s.started?" · 已开赛":"")+'</span></td>'+
            '<td>'+(s.ok ? '<span class="pill ok">通过</span>' : '<span class="pill bad">'+esc((s.problems||[]).map(reasonText).join("；"))+'</span>')+recheck+'</td>'+
            '<td class="meta">'+esc(s.ticket)+'</td><td>'+ops+'</td></tr>';
        }).join("") + "</table>";
    }
    function renderConflicts() {
      if (!state.conflicts.length) { $("#conflicts").innerHTML = '<div class="meta">暂无冲突。</div>'; return; }
      $("#conflicts").innerHTML = '<table><tr><th>时间</th><th>后到提交</th><th>比赛</th><th>原因</th><th>现场单</th></tr>' +
        state.conflicts.slice().reverse().map(c =>
          '<tr><td class="meta">'+esc(String(c.createdAt).slice(0,19).replace("T"," "))+'</td>'+
          '<td>'+esc(c.ringNo)+'<br><span class="meta">提交人 '+esc(c.applicant||"")+'</span></td>'+
          '<td>'+esc(c.eventName)+'</td>'+
          '<td><span class="pill conflict">'+esc(REASON[c.reason] || c.reason)+'</span></td>'+
          '<td class="meta">'+esc(c.ticket)+'</td></tr>').join("") + "</table>";
    }
    function renderEligibility() {
      if (!state.events.length) { $("#eligibility").innerHTML = '<div class="meta">暂无赛事。</div>'; return; }
      $("#eligibility").innerHTML = state.events.map(ev => {
        const rows = state.pigeons.map(p => {
          const r = state._eval ? state._eval[ev.id + "|" + p.ringNo] : null;
          if (!r) return "";
          const active = state.slots.find(s => s.ringNo === p.ringNo && s.eventId === ev.id && (s.status === "pending" || s.status === "confirmed"));
          return '<tr><td>'+esc(p.ringNo)+'</td><td>'+esc(p.owner)+'</td>'+
            '<td>'+(r.ok ? '<span class="pill ok">可报名</span>' : '<span class="pill bad">'+esc(r.problems.map(reasonText).join("；"))+'</span>')+'</td>'+
            '<td>'+(active ? '<span class="pill '+active.status+'">'+({pending:"待确认",confirmed:"已确认",invalidated:"已失效"}[active.status] || active.status)+'</span>' : '<span class="meta">—</span>')+'</td>'+
            '<td>'+(r.ok && !active && !isStarted(ev) ? '<button class="ghost" data-use="'+esc(p.ringNo)+"|"+esc(ev.id)+'">填入</button>' : "")+'</td></tr>';
        }).join("");
        return '<h3>'+esc(ev.name)+'（'+esc(ev.date)+' · '+(isStarted(ev) ? "已开赛" : "未开赛")+'）</h3>'+
          '<table><tr><th>足环号</th><th>现鸽主</th><th>资格</th><th>名额</th><th></th></tr>'+rows+'</table>';
      }).join("");
    }
    function vaccineHtml(p) {
      return (p.vaccines||[]).map(v => '<span class="pill">'+esc(v.name)+' '+esc(v.date)+' 至 '+esc(v.expiresOn)+'</span>').join("") || '<span class="meta">无疫苗</span>';
    }
    function transferHtml(p) {
      return (p.transfers||[]).map(t =>
        '<div class="inline"><span class="pill '+(t.settled?"ok":"bad")+'">'+esc(t.date)+" "+esc(t.from)+"→"+esc(t.to)+(t.settled?" 已结清":" 未结清")+'</span>'+
        (!t.settled ? '<button class="ghost" data-settle="'+esc(p.ringNo)+"|"+esc(t.id)+'">结清</button>' : "")+'</div>').join("") || '<span class="meta">无转让</span>';
    }
    function raceHtml(p) {
      return (p.races||[]).map(r =>
        '<div class="meta">'+esc(r.date)+" "+esc(r.event)+" 第"+esc(r.rank)+"名 · 成绩归属：<b>"+esc(r.owner||p.owner)+'</b>'+
        (r.owner && r.owner !== p.owner ? '（现鸽主：'+esc(p.owner)+'）' : '')+'</div>').join("") || '<span class="meta">无归巢成绩</span>';
    }
    function renderCards() {
      $("#cards").innerHTML = '<div class="grid2">' + state.pigeons.map(p =>
        '<div class="card"><h3>'+esc(p.ringNo)+' <span class="pill">'+esc(p.owner)+'</span></h3>'+
        '<div class="meta">'+esc(p.color)+' · '+esc(p.loft)+'</div>'+
        '<div><b>疫苗</b><br>'+vaccineHtml(p)+'</div>'+
        '<div style="margin-top:6px;"><b>转让</b><br>'+transferHtml(p)+'</div>'+
        '<div style="margin-top:6px;"><b>归巢</b><br>'+raceHtml(p)+'</div>'+
        '<div class="grid2" style="margin-top:8px;">'+
          '<div><label>新转让给</label><input data-to="'+esc(p.ringNo)+'" placeholder="新鸽主"></div>'+
          '<div>&nbsp;</div>'+
        '</div>'+
        '<div class="row"><button class="ghost" data-transfer="'+esc(p.ringNo)+'">登记转让（未结清）</button></div>'+
        '<label>归巢成绩（已开赛）</label><div class="inline"><input data-race="'+esc(p.ringNo)+'" placeholder="赛事/距离/名次/日期"><button class="ghost" data-score="'+esc(p.ringNo)+'">保存成绩</button></div>'+
        '</div>').join("") + "</div>";
    }
    function renderRelation(data) {
      if (!data) return;
      const p = data.pigeon;
      $("#detail").innerHTML = '<b>'+esc(p.ringNo)+'</b> 血统：父 '+(esc(data.father?.ringNo || p.fatherRing || "未登记"))+
        ' · 母 '+(esc(data.mother?.ringNo || p.motherRing || "未登记"))+' · 子代 '+(esc(data.children.map(c=>c.ringNo).join("、") || "暂无"));
    }
    function syncSelects() {
      const rings = ringOptions(), events = eventOptions();
      $("#regRing").innerHTML = rings; $("#pfRing").innerHTML = rings; $("#vcRing").innerHTML = rings;
      $("#regEvent").innerHTML = events;
      const pf = state.pigeons.find(p => p.ringNo === $("#pfRing").value) || state.pigeons[0];
      if (pf) {
        const f = $("#profileForm");
        f.owner.value = pf.owner; f.loft.value = pf.loft; f.color.value = pf.color;
        f.fatherRing.value = pf.fatherRing || ""; f.motherRing.value = pf.motherRing || "";
      }
    }
    async function load() {
      state = await api("/api/console");
      state._eval = {};
      for (const ev of state.events) for (const p of state.pigeons) state._eval[ev.id+"|"+p.ringNo] = (await api("/api/evaluate/"+encodeURIComponent(p.ringNo)+"/"+encodeURIComponent(ev.id))).result;
      syncSelects(); renderSlots(); renderConflicts(); renderEligibility(); renderCards();
    }

    $("#reload").onclick = load;
    $("#searchBtn").onclick = async () => {
      const v = $("#search").value.trim();
      if (!v) return;
      renderRelation(await api("/api/pigeons/"+encodeURIComponent(v)+"/relation"));
    };
    $("#pfRing").onchange = syncSelects;

    $("#regForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, fd = new FormData(f);
      const fail = fd.get("failNext") === "on";
      const ticket = String(fd.get("ticket") || "").trim();
      try {
        const out = await api("/api/registrations", {
          method: "POST",
          headers: fail ? { "X-Simulate-Write-Fail": "1" } : {},
          body: { ringNo: fd.get("ringNo"), eventId: fd.get("eventId"), applicant: fd.get("applicant"), ticket: ticket || undefined }
        });
        if (out.slot) setMsg($("#regMsg"), true, "已占用待确认名额，现场单：" + out.slot.ticket + (out.retry ? "（凭原单重试成功）" : ""));
        else if (out.conflict) setMsg($("#regMsg"), false, "后到提交留冲突：" + (REASON[out.conflict.reason] || out.conflict.reason) + "，现场单 " + out.conflict.ticket);
        else setMsg($("#regMsg"), false, out.slotView ? "未通过：" + out.slotView.problems.map(reasonText).join("；") : "未处理");
      } catch (e) {
        if (e.data && e.data.error === "not_eligible") {
          setMsg($("#regMsg"), false, "不让报名：" + (e.data.problems || []).map(reasonText).join("；") + "。现场单 " + ticket + " 未占用名额。");
        } else {
          setMsg($("#regMsg"), false, "写盘失败（" + (e.data?.error || e.message) + "）。请凭现场单 " + (ticket || "(见服务器返回)") + " 原样重试，不会重复生成名额。");
        }
      }
      f.ticket.value = ticket;
      await load();
    };

    $("#profileForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, fd = new FormData(f);
      try {
        await api("/api/pigeons/"+encodeURIComponent(fd.get("ringNo"))+"/profile", {
          method: "PATCH",
          body: { owner: fd.get("owner"), loft: fd.get("loft"), color: fd.get("color"), fatherRing: fd.get("fatherRing"), motherRing: fd.get("motherRing") }
        });
        setMsg($("#pfMsg"), true, "档案已更正，未开赛待确认名额已失效，需重新核验。");
      } catch (e) { setMsg($("#pfMsg"), false, e.message); }
      await load();
    };

    $("#vaccineForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target, fd = new FormData(f);
      try {
        await api("/api/pigeons/"+encodeURIComponent(fd.get("ringNo"))+"/vaccines", {
          method: "POST",
          body: { date: fd.get("date"), expiresOn: fd.get("expiresOn"), name: fd.get("name") }
        });
        setMsg($("#vcMsg"), true, "疫苗已保存，未开赛待确认名额已失效，需重新核验。");
      } catch (e) { setMsg($("#vcMsg"), false, e.message); }
      await load();
    };

    document.addEventListener("click", async ev => {
      const b = ev.target;
      try {
        if (b.dataset.confirm) {
          await api("/api/registrations/"+encodeURIComponent(b.dataset.confirm)+"/confirm", { method: "POST" });
        } else if (b.dataset.recheck) {
          const out = await api("/api/registrations/"+encodeURIComponent(b.dataset.recheck)+"/recheck", { method: "POST" });
          alert(out.result.ok ? "重新核验通过，可确认" : "重新核验不通过：" + out.result.problems.map(reasonText).join("；"));
        } else if (b.dataset.rereg) {
          const [ring, evId] = b.dataset.rereg.split("|");
          $("#regRing").value = ring; $("#regEvent").value = evId;
          window.scrollTo(0, 0);
        } else if (b.dataset.use) {
          const [ring, evId] = b.dataset.use.split("|");
          $("#regRing").value = ring; $("#regEvent").value = evId;
        } else if (b.dataset.settle) {
          const [ring, tid] = b.dataset.settle.split("|");
          await api("/api/pigeons/"+encodeURIComponent(ring)+"/transfers/"+encodeURIComponent(tid)+"/settle", { method: "POST" });
        } else if (b.dataset.transfer) {
          const ring = b.dataset.transfer;
          const to = document.querySelector('[data-to="'+ring+'"]').value.trim();
          if (!to) return alert("请填写新鸽主");
          await api("/api/pigeons/"+encodeURIComponent(ring)+"/transfers", { method: "POST", body: { to } });
        } else if (b.dataset.score) {
          const ring = b.dataset.score;
          const raw = document.querySelector('[data-race="'+ring+'"]').value.split("/");
          await api("/api/pigeons/"+encodeURIComponent(ring)+"/races", {
            method: "POST",
            body: { event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0), date: raw[3] || undefined }
          });
        } else return;
        await load();
      } catch (e) { alert(e.data?.error || e.message); }
    });

    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // 报名提交：先到先占，后到留冲突；现场单幂等，失败可重试
    if (req.method === "POST" && url.pathname === "/api/registrations") {
      const input = await body(req);
      return withLock(async () => {
        const db = await loadDb();
        const ticket = (input.ticket && String(input.ticket).trim()) || ("T-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomUUID().slice(0, 6));
        const priorSlot = db.slots.find(s => s.ticket === ticket);
        const priorConflict = db.conflicts.find(c => c.ticket === ticket);
        if (priorSlot) return sendJson(res, 200, { slot: slotView(db, priorSlot), retry: true });
        if (priorConflict) return sendJson(res, 200, { conflict: priorConflict, retry: true });

        const pigeon = db.pigeons.find(p => p.ringNo === input.ringNo);
        const ev = db.events.find(e => e.id === input.eventId);
        const verdict = evaluate(db, pigeon, ev, input.applicant);

        // 资格不通过：不落名额，直接拒收（疫苗到期/转让未结清/已开赛）
        if (!verdict.ok) return sendJson(res, 422, { error: "not_eligible", problems: verdict.problems, ticket });

        const active = db.slots.find(s => s.ringNo === input.ringNo && s.eventId === input.eventId && (s.status === "pending" || s.status === "confirmed"));
        if (active) {
          const conflict = {
            id: "cf-" + randomUUID(), ticket, ringNo: input.ringNo, eventId: input.eventId,
            applicant: input.applicant || "", winnerSlotId: active.id, reason: active.status === "pending" ? "slot_pending" : "slot_confirmed",
            payload: input, createdAt: new Date().toISOString()
          };
          db.conflicts.push(conflict);
          try {
            await saveDb(db);
          } catch (e) {
            return sendJson(res, 500, { error: "write_failed", ticket, detail: String(e.message || e) });
          }
          return sendJson(res, 409, { conflict: { ...conflict, eventName: ev.name } });
        }

        const slot = {
          id: "slot-" + randomUUID(), ticket, ringNo: input.ringNo, eventId: input.eventId,
          owner: pigeon.owner, applicant: input.applicant || "", status: "pending",
          ok: true, problems: [], basis: basis(pigeon),
          createdAt: new Date().toISOString()
        };
        db.slots.push(slot);
        try {
          // 测试/演练用：X-Simulate-Write-Fail 令本次写盘失败，凭现场单可重试
          if (req.headers["x-simulate-write-fail"]) throw new Error("simulated disk failure");
          await saveDb(db);
        } catch (e) {
          return sendJson(res, 500, { error: "write_failed", ticket, detail: String(e.message || e) });
        }
        return sendJson(res, 201, { slot: slotView(db, slot) });
      });
    }

    // 确认待确认名额
    const confirmMatch = url.pathname.match(/^\/api\/registrations\/(.+)\/confirm$/);
    if (confirmMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const slot = db.slots.find(s => s.id === decodeURIComponent(confirmMatch[1]));
        if (!slot) return sendJson(res, 404, { error: "slot_not_found" });
        if (slot.status !== "pending") return sendJson(res, 409, { error: "slot_not_pending", status: slot.status });
        const pigeon = db.pigeons.find(p => p.ringNo === slot.ringNo);
        const ev = db.events.find(e => e.id === slot.eventId);
        const verdict = evaluate(db, pigeon, ev, null);
        if (!verdict.ok) { slot.recheck = verdict; await saveDb(db); return sendJson(res, 422, { error: "not_eligible", problems: verdict.problems }); }
        slot.status = "confirmed";
        slot.confirmedAt = new Date().toISOString();
        await saveDb(db);
        return sendJson(res, 200, slotView(db, slot));
      });
    }

    // 更正后重算：失效/待确认名额按最新档案与疫苗重验
    const recheckMatch = url.pathname.match(/^\/api\/registrations\/(.+)\/recheck$/);
    if (recheckMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const slot = db.slots.find(s => s.id === decodeURIComponent(recheckMatch[1]));
        if (!slot) return sendJson(res, 404, { error: "slot_not_found" });
        const pigeon = db.pigeons.find(p => p.ringNo === slot.ringNo);
        const ev = db.events.find(e => e.id === slot.eventId);
        const verdict = evaluate(db, pigeon, ev, null);
        slot.recheck = verdict;
        slot.recheckedAt = new Date().toISOString();
        await saveDb(db);
        return sendJson(res, 200, { slot: slotView(db, slot), result: verdict });
      });
    }

    // 核验台聚合数据
    if (req.method === "GET" && url.pathname === "/api/console") {
      const db = await loadDb();
      return sendJson(res, 200, {
        pigeons: db.pigeons,
        events: db.events.map(e => ({ ...e, started: started(e) })),
        slots: db.slots.map(s => slotView(db, s)),
        conflicts: db.conflicts.map(c => ({ ...c, eventName: (db.events.find(e => e.id === c.eventId) || {}).name || c.eventId }))
      });
    }

    // 单鸽单场资格核验
    const evalMatch = url.pathname.match(/^\/api\/evaluate\/(.+)\/(.+)$/);
    if (evalMatch && req.method === "GET") {
      const db = await loadDb();
      const pigeon = db.pigeons.find(p => p.ringNo === decodeURIComponent(evalMatch[1]));
      const ev = db.events.find(e => e.id === decodeURIComponent(evalMatch[2]));
      return sendJson(res, 200, { result: evaluate(db, pigeon, ev, null) });
    }

    if (req.method === "GET" && url.pathname === "/api/pigeons") {
      const db = await loadDb();
      return sendJson(res, 200, db.pigeons);
    }

    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      return withLock(async () => {
        const db = await loadDb();
        if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
        const pigeon = {
          ringNo: input.ringNo, owner: input.owner, fatherRing: input.fatherRing || "", motherRing: input.motherRing || "",
          color: input.color, loft: input.loft, vaccines: [], transfers: [], races: []
        };
        db.pigeons.unshift(pigeon);
        await saveDb(db);
        return sendJson(res, 201, pigeon);
      });
    }

    // 档案更正：未开赛待确认名额失效重算
    const profileMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/profile$/);
    if (profileMatch && req.method === "PATCH") {
      return withLock(async () => {
        const db = await loadDb();
        const pigeon = db.pigeons.find(p => p.ringNo === decodeURIComponent(profileMatch[1]));
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const input = await body(req);
        for (const k of ["owner", "loft", "color", "fatherRing", "motherRing"]) {
          if (typeof input[k] === "string") pigeon[k] = input[k];
        }
        invalidatePending(db, pigeon.ringNo, "档案更正（owner=" + pigeon.owner + "）");
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }

    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const db = await loadDb();
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }

    // 疫苗更正：未开赛待确认名额失效重算
    const vaccineMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/vaccines$/);
    if (vaccineMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const pigeon = db.pigeons.find(p => p.ringNo === decodeURIComponent(vaccineMatch[1]));
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const input = await body(req);
        const date = input.date || new Date().toISOString().slice(0, 10);
        const vaccine = {
          id: "v-" + randomUUID(),
          date,
          name: input.name || "未命名疫苗",
          expiresOn: input.expiresOn || shiftDate(date, VACCINE_DEFAULT_DAYS)
        };
        pigeon.vaccines.push(vaccine);
        invalidatePending(db, pigeon.ringNo, "疫苗记录更正（" + vaccine.name + " " + vaccine.date + "）");
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }

    // 新转让默认未结清：不结清不能报名
    const transferMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/transfers$/);
    if (transferMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const pigeon = db.pigeons.find(p => p.ringNo === decodeURIComponent(transferMatch[1]));
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const input = await body(req);
        if (!input.to) return sendJson(res, 400, { error: "to_required" });
        const transfer = {
          id: "t-" + randomUUID(),
          date: input.date || new Date().toISOString().slice(0, 10),
          from: pigeon.owner, to: input.to, settled: false
        };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
        invalidatePending(db, pigeon.ringNo, "转让记录变更（" + transfer.from + "→" + transfer.to + "）");
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }

    // 转让结清
    const settleMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/transfers\/(.+)\/settle$/);
    if (settleMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const pigeon = db.pigeons.find(p => p.ringNo === decodeURIComponent(settleMatch[1]));
        const t = pigeon && pigeon.transfers.find(x => x.id === decodeURIComponent(settleMatch[2]));
        if (!t) return sendJson(res, 404, { error: "transfer_not_found" });
        t.settled = true;
        invalidatePending(db, pigeon.ringNo, "转让结清重算");
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }

    // 归巢成绩：成绩归属按归巢日原鸽主固化
    const raceMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/races$/);
    if (raceMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const pigeon = db.pigeons.find(p => p.ringNo === decodeURIComponent(raceMatch[1]));
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const input = await body(req);
        const date = input.date || new Date().toISOString().slice(0, 10);
        const record = {
          date,
          event: input.event,
          distance: Number(input.distance || 0),
          returnTime: input.returnTime || "",
          rank: Number(input.rank || 0),
          owner: ownerAt(pigeon, date)
        };
        pigeon.races.push(record);
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registration desk listening on http://localhost:${port}`));
