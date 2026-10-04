import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);

// 疫苗有效期：自接种日起 180 天（半年），到期则报名核验不通过
const VACCINE_VALID_DAYS = 180;

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚",
      vaccines: [{ date: "2026-04-01", name: "新城疫" }],
      transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚", settled: true }],
      races: [{ date: "2026-06-01", event: "120公里训放", raceId: "race-2026-120", distance: 120, returnTime: "10:42", rank: 18, owner: "北岸棚" }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  races: [
    { id: "race-2026-120", name: "120公里训放", date: "2026-06-01" },
    { id: "race-2026-10-10", name: "2026秋季300公里预赛", date: "2026-10-10" },
    { id: "race-2026-10-20", name: "2026秋季500公里大奖赛", date: "2026-10-20" }
  ],
  slots: [],
  conflicts: []
};

function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function genId(prefix) { return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }

// 信鸽在某一比赛日的归属：取不晚于比赛日的最后一次转让的承接方；
// 若该日之前没有转让，则归原鸽主（首次转让的出让方）。已开赛成绩仍归原鸽主。
function ownerAtDate(pigeon, dateStr) {
  const transfers = [...(pigeon.transfers || [])].sort((a, b) => a.date.localeCompare(b.date));
  const before = transfers.filter(t => t.date <= dateStr);
  if (before.length) return before[before.length - 1].to;
  if (transfers.length) return transfers[0].from;
  return pigeon.owner;
}

// 报名资格核验：疫苗须在有效期内，且无未结清转让
function checkEligibility(pigeon, race) {
  const vaccines = [...(pigeon.vaccines || [])].sort((a, b) => a.date.localeCompare(b.date));
  const latest = vaccines[vaccines.length - 1];
  if (!latest) return { eligible: false, reason: "vaccine_missing", message: "未接种疫苗，无法报名" };
  if (latest.date > race.date) return { eligible: false, reason: "vaccine_after_race", message: "接种日期晚于比赛日" };
  if (addDays(latest.date, VACCINE_VALID_DAYS) < race.date) {
    return { eligible: false, reason: "vaccine_expired", message: "疫苗已到期（有效期 " + VACCINE_VALID_DAYS + " 天），请更正疫苗记录" };
  }
  const unsettled = (pigeon.transfers || []).some(t => t.settled === false);
  if (unsettled) return { eligible: false, reason: "transfer_unsettled", message: "存在未结清转让，无法报名" };
  return { eligible: true };
}

// 档案或疫苗更正后，未开赛（比赛日晚于今天）的名额一律重算：
// 仍合规则保持/恢复待确认，不合规则置失效；已开赛名额锁定不动。
function invalidateAndRecompute(db, pigeonRing) {
  const today = todayStr();
  const pigeon = db.pigeons.find(p => p.ringNo === pigeonRing);
  if (!pigeon) return;
  for (const slot of db.slots) {
    if (slot.pigeonRing !== pigeonRing) continue;
    const race = db.races.find(r => r.id === slot.raceId);
    if (!race || race.date <= today) continue; // 已开赛，归属锁定
    const elig = checkEligibility(pigeon, race);
    if (elig.eligible) { slot.status = "pending"; slot.reason = null; slot.message = null; }
    else { slot.status = "invalid"; slot.reason = elig.reason; slot.message = elig.message; }
    slot.updatedAt = new Date().toISOString();
  }
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  let changed = false;
  if (!Array.isArray(db.races)) { db.races = seed.races; changed = true; }
  if (!Array.isArray(db.slots)) { db.slots = []; changed = true; }
  if (!Array.isArray(db.conflicts)) { db.conflicts = []; changed = true; }
  for (const p of db.pigeons) {
    for (const t of (p.transfers || [])) if (t.settled === undefined) { t.settled = true; changed = true; }
    for (const r of (p.races || [])) if (r.owner === undefined) { r.owner = ownerAtDate(p, r.date); changed = true; }
  }
  if (changed) await saveDb(db);
  return db;
}

// 原子写盘：先写临时文件再改名，避免写盘失败产生半截数据
async function saveDb(db) {
  const tmp = dbPath + ".tmp";
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath);
}

// 进程内互斥：把“读库—改—写库”串成串行，保证两人同时提交时先到者占用
let chain = Promise.resolve();
function withLock(fn) {
  const result = chain.then(fn, fn);
  chain = result.then(() => {}, () => {});
  return result;
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
  <title>赛鸽血统环号登记站 · 报名核验台</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2e7d52; --amber:#a06a1c; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    h3 { margin:14px 0 8px; font-size:15px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#eef2f5; color:var(--accent); } button.danger { background:var(--red); }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--green); border-color:var(--green); } .pill.no { color:var(--red); border-color:var(--red); } .pill.warn { color:var(--amber); border-color:var(--amber); }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; margin-bottom:8px; font-size:13px; }
    .small.conflict { border-color:var(--red); background:#fdf3f2; } .small.invalid { border-color:var(--amber); background:#fdf8ef; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; } .grow { flex:1; }
    .banner { padding:10px 12px; border-radius:8px; margin-bottom:10px; font-size:13px; display:none; }
    .banner.err { background:#fdf3f2; border:1px solid var(--red); color:var(--red); display:block; }
    .banner.ok { background:#eef7f1; border:1px solid var(--green); color:var(--green); display:block; }
    .mono { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、疫苗、转让、归巢成绩 · 报名核验台</div></div><button id="reload">刷新</button></header>
  <main>
    <div>
      <form id="form">
        <h2>创建鸽只档案</h2>
        <label>足环号</label><input name="ringNo" required>
        <label>鸽主</label><input name="owner" required>
        <label>父鸽足环号</label><input name="fatherRing">
        <label>母鸽足环号</label><input name="motherRing">
        <label>羽色</label><input name="color" required>
        <label>出生棚号</label><input name="loft" required>
        <button>保存档案</button>
      </form>
      <form id="regForm" class="section">
        <h2>报名核验台</h2>
        <div class="banner" id="regBanner"></div>
        <label>现场单号（写盘失败凭此重试，不会重复占名额）</label>
        <input name="formNo" id="regFormNo" class="mono" readonly>
        <label>足环号</label><input name="pigeonRing" required list="pigeonList" placeholder="如 CHN-2026-001">
        <datalist id="pigeonList"></datalist>
        <label>比赛</label><select name="raceId" id="regRace" required></select>
        <button>提交报名</button>
        <div class="meta" id="regElig" style="margin-top:8px;"></div>
      </form>
      <form id="raceForm" class="section">
        <h2>创建比赛</h2>
        <label>比赛名称</label><input name="name" required>
        <label>比赛日期</label><input name="date" type="date" required>
        <button>保存比赛</button>
      </form>
    </div>
    <section>
      <div class="panel" id="verify"></div>
      <div class="toolbar section"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const verify = document.querySelector("#verify");
    const regForm = document.querySelector("#regForm");
    const regBanner = document.querySelector("#regBanner");
    const regFormNo = document.querySelector("#regFormNo");
    const regRace = document.querySelector("#regRace");
    const regElig = document.querySelector("#regElig");
    const raceForm = document.querySelector("#raceForm");
    let pigeons = [];
    let races = [];
    let regs = { slots: [], conflicts: [] };

    function newFormNo() { return "XD-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
    function resetFormNo() { regFormNo.value = newFormNo(); }

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || "请求失败"); err.status = res.status; err.data = data; throw err; }
      return data;
    }
    // 写盘失败（5xx/网络异常）时，凭同一现场单号重试，服务端按单号去重，不会重复生成名额
    async function submitRegistration(payload) {
      const maxRetry = 4;
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try { return await api("/api/registrations", { method: "POST", body: JSON.stringify(payload) }); }
        catch (e) {
          const retryable = !e.status || e.status >= 500;
          if (!retryable || attempt === maxRetry) throw e;
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }

    function vaccineInfo(p) {
      const list = (p.vaccines || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      const latest = list[list.length - 1];
      if (!latest) return { text: "未接种", cls: "no" };
      return { text: latest.date + " " + latest.name, cls: "ok" };
    }
    function unsettledCount(p) { return (p.transfers || []).filter(t => t.settled === false).length; }

    function renderCards() {
      cards.innerHTML = pigeons.map(p => {
        const v = vaccineInfo(p);
        const unsettled = unsettledCount(p);
        const raceOpts = races.map(r => '<option value="' + r.id + '">' + r.name + "（" + r.date + "）</option>").join("");
        const transfers = (p.transfers || []).map((t, i) =>
          '<div class="meta">' + t.date + " " + t.from + "→" + t.to +
          (t.settled === false ? ' <span class="pill no">未结清</span> <button class="ghost" data-settle="' + p.ringNo + '" data-i="' + i + '">结清</button>' : ' <span class="pill ok">已结清</span>') +
          "</div>").join("");
        const raceList = (p.races || []).map(r =>
          '<div class="meta">' + r.date + " " + r.event + " 第" + r.rank + "名 · 归属 " + (r.owner || p.owner) + "</div>").join("");
        return '<article class="card"><h3>' + p.ringNo + '</h3>' +
          '<div class="row"><span class="pill">' + p.owner + '</span><span class="pill ' + v.cls + '">疫苗 ' + v.text + '</span>' +
          (unsettled ? '<span class="pill no">转让未结清 ' + unsettled + '</span>' : '') + '</div>' +
          '<div class="meta">' + p.color + " · " + p.loft + '</div>' +
          '<div>父：' + (p.fatherRing || "未登记") + '</div><div>母：' + (p.motherRing || "未登记") + '</div>' +
          '<div class="section"><b>转让记录</b>' + (transfers || '<div class="meta">暂无</div>') +
          '<label>录入转让（转棚）</label><input data-to="' + p.ringNo + '" placeholder="新归属人"><div class="row"><label class="grow" style="margin:0;"><input type="checkbox" data-unsettled="' + p.ringNo + '"> 未结清</label><button data-transfer="' + p.ringNo + '">保存转让</button></div></div>' +
          '<div class="section"><b>归巢成绩</b>' + (raceList || '<div class="meta">暂无</div>') +
          '<label>比赛</label><select data-race="' + p.ringNo + '">' + raceOpts + '</select>' +
          '<label>距离（公里）</label><input data-dist="' + p.ringNo + '" placeholder="如 200">' +
          '<label>归巢时间</label><input data-return="' + p.ringNo + '" placeholder="如 10:42">' +
          '<label>名次</label><input data-rank="' + p.ringNo + '" placeholder="如 6">' +
          '<button data-score="' + p.ringNo + '">保存成绩</button></div>' +
          '<div class="section"><b>疫苗记录</b>' + (p.vaccines || []).map(x => '<div class="meta">' + x.date + " " + x.name + "</div>").join("") +
          '<label>接种日期</label><input data-vdate="' + p.ringNo + '" type="date">' +
          '<label>疫苗名称</label><input data-vname="' + p.ringNo + '" placeholder="如 新城疫">' +
          '<button data-vaccine="' + p.ringNo + '">保存疫苗</button></div>' +
          '</article>';
      }).join("");

      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer;
        const to = document.querySelector('[data-to="' + ringNo + '"]').value;
        const unsettled = document.querySelector('[data-unsettled="' + ringNo + '"]').checked;
        await api("/api/pigeons/" + encodeURIComponent(ringNo) + "/transfers", { method: "POST", body: JSON.stringify({ to, settled: !unsettled }) });
        await load();
      });
      document.querySelectorAll("[data-settle]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.settle; const i = btn.dataset.i;
        await api("/api/pigeons/" + encodeURIComponent(ringNo) + "/transfers/" + i + "/settle", { method: "POST" });
        await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score;
        const raceId = document.querySelector('[data-race="' + ringNo + '"]').value;
        const race = races.find(r => r.id === raceId);
        const distance = Number(document.querySelector('[data-dist="' + ringNo + '"]').value || 0);
        const returnTime = document.querySelector('[data-return="' + ringNo + '"]').value || "";
        const rank = Number(document.querySelector('[data-rank="' + ringNo + '"]').value || 0);
        await api("/api/pigeons/" + encodeURIComponent(ringNo) + "/races", { method: "POST", body: JSON.stringify({ raceId, event: race ? race.name : "未命名赛事", date: race ? race.date : undefined, distance, returnTime, rank }) });
        await load();
      });
      document.querySelectorAll("[data-vaccine]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.vaccine;
        const date = document.querySelector('[data-vdate="' + ringNo + '"]').value;
        const name = document.querySelector('[data-vname="' + ringNo + '"]').value;
        await api("/api/pigeons/" + encodeURIComponent(ringNo) + "/vaccines", { method: "POST", body: JSON.stringify({ date, name }) });
        await load();
      });
    }

    function renderVerify() {
      const pending = (regs.slots || []).filter(s => s.status === "pending");
      const invalid = (regs.slots || []).filter(s => s.status === "invalid");
      const conflicts = regs.conflicts || [];
      const slotHtml = s => '<div class="small"><b>' + s.pigeonRing + '</b> · ' + s.raceName +
        ' <span class="pill ok">待确认</span><div class="meta">提交鸽主 ' + (s.ownerAtSubmit || "?") + ' · ' + (s.createdAt || "") + '</div>' +
        '<div class="meta mono">现场单 ' + s.formNo + '</div></div>';
      const invalidHtml = s => '<div class="small invalid"><b>' + s.pigeonRing + '</b> · ' + s.raceName +
        ' <span class="pill warn">失效重算</span><div class="meta">' + (s.message || s.reason || '') + '</div>' +
        '<div class="meta mono">现场单 ' + s.formNo + '</div></div>';
      const conflictHtml = c => '<div class="small conflict"><b>' + c.pigeonRing + '</b> · ' + c.raceName +
        ' <span class="pill no">冲突</span><div class="meta">后到内容未占用名额，先到名额 ' + (c.conflictWith || "") + '</div>' +
        '<div class="meta mono">现场单 ' + c.formNo + ' · ' + (c.submittedAt || "") + '</div></div>';
      verify.innerHTML = '<h2>报名核验台</h2>' +
        '<div class="section"><h3>待确认名额（' + pending.length + '）</h3>' + (pending.length ? pending.map(slotHtml).join("") : '<p class="meta">暂无</p>') + '</div>' +
        '<div class="section"><h3>失效重算名额（' + invalid.length + '）</h3>' + (invalid.length ? invalid.map(invalidHtml).join("") : '<p class="meta">暂无</p>') + '</div>' +
        '<div class="section"><h3>冲突（' + conflicts.length + '）</h3>' + (conflicts.length ? conflicts.map(conflictHtml).join("") : '<p class="meta">暂无</p>') + '</div>';
    }

    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让和成绩。</p>'; return; }
      const p = data.pigeon;
      detail.innerHTML = '<h2>' + p.ringNo + ' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>' + (data.father?.ringNo || p.fatherRing || "未登记") + '</div><div class="small"><b>本鸽</b><br>' + p.owner + ' · ' + p.color + '</div><div class="small"><b>母鸽</b><br>' + (data.mother?.ringNo || p.motherRing || "未登记") + '</div></div><div><b>子代</b> ' + (data.children.map(c => c.ringNo).join("、") || "暂无") + '</div><div class="meta">转让：' + (p.transfers || []).map(t => t.from + "→" + t.to + (t.settled === false ? "（未结清）" : "")).join(" / ") + '</div><div class="meta">归巢：' + (p.races || []).map(r => r.event + " 第" + r.rank + "名（" + (r.owner || p.owner) + "）").join(" / ") + '</div>';
    }

    async function load() {
      pigeons = await api("/api/pigeons");
      races = await api("/api/races");
      regs = await api("/api/registrations");
      renderCards();
      renderVerify();
      renderRelation(null);
      regRace.innerHTML = races.map(r => '<option value="' + r.id + '">' + r.name + "（" + r.date + "）</option>").join("");
      document.querySelector("#pigeonList").innerHTML = pigeons.map(p => '<option value="' + p.ringNo + '">').join("");
    }

    function showBanner(kind, msg) {
      regBanner.className = "banner " + kind;
      regBanner.textContent = msg;
    }

    regForm.onsubmit = async event => {
      event.preventDefault();
      const fd = new FormData(regForm);
      const payload = { formNo: fd.get("formNo"), pigeonRing: fd.get("pigeonRing"), raceId: fd.get("raceId") };
      regElig.textContent = "";
      try {
        const out = await submitRegistration(payload);
        if (out.status === "conflict") showBanner("err", "提交冲突：该鸽该比赛已有先到名额，后到内容已留冲突（现场单 " + payload.formNo + "）");
        else if (out.status === "idempotent") showBanner("ok", "同一现场单已提交过，已返回原名额，未重复生成");
        else showBanner("ok", "报名成功：名额已占用（现场单 " + payload.formNo + "）");
        resetFormNo();
        await load();
      } catch (e) {
        showBanner("err", "报名失败：" + (e.data?.message || e.message) + "（可凭现场单 " + payload.formNo + " 重试，不会重复占名额）");
      }
    };

    raceForm.onsubmit = async event => {
      event.preventDefault();
      await api("/api/races", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(raceForm).entries())) });
      raceForm.reset();
      await load();
    };

    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset();
      await load();
    };

    document.querySelector("#searchBtn").onclick = async () => renderRelation(await api("/api/pigeons/" + encodeURIComponent(search.value) + "/relation"));
    document.querySelector("#reload").onclick = load;
    resetFormNo();
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
    if (req.method === "GET" && url.pathname === "/api/pigeons") {
      const db = await loadDb();
      return sendJson(res, 200, db.pigeons);
    }
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      return withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
        const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
        db.pigeons.unshift(pigeon);
        await saveDb(db);
        return sendJson(res, 201, pigeon);
      });
    }
    if (req.method === "PATCH" && url.pathname.match(/^\/api\/pigeons\/[^/]+$/)) {
      return withLock(async () => {
        const db = await loadDb();
        const ringNo = decodeURIComponent(url.pathname.split("/").pop());
        const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const input = await body(req);
        for (const key of ["owner", "fatherRing", "motherRing", "color", "loft"]) {
          if (input[key] !== undefined) pigeon[key] = input[key];
        }
        // 档案更正后，未开赛名额失效重算
        invalidateAndRecompute(db, ringNo);
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
    const settleMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/transfers\/(\d+)\/settle$/);
    if (settleMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const ringNo = decodeURIComponent(settleMatch[1]);
        const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const i = Number(settleMatch[2]);
        const transfer = pigeon.transfers[i];
        if (!transfer) return sendJson(res, 404, { error: "transfer_not_found" });
        transfer.settled = true;
        // 转让结清后，未开赛名额失效重算
        invalidateAndRecompute(db, ringNo);
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }
    const vaccineMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/vaccines\/(\d+)$/);
    if (vaccineMatch && req.method === "PATCH") {
      return withLock(async () => {
        const db = await loadDb();
        const ringNo = decodeURIComponent(vaccineMatch[1]);
        const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const i = Number(vaccineMatch[2]);
        const vaccine = pigeon.vaccines[i];
        if (!vaccine) return sendJson(res, 404, { error: "vaccine_not_found" });
        const input = await body(req);
        if (input.date !== undefined) vaccine.date = input.date;
        if (input.name !== undefined) vaccine.name = input.name;
        // 疫苗更正后，未开赛名额失效重算
        invalidateAndRecompute(db, ringNo);
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      return withLock(async () => {
        const db = await loadDb();
        const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
        const input = await body(req);
        if (actionMatch[2] === "transfers") {
          const transfer = { date: input.date || todayStr(), from: pigeon.owner, to: input.to, settled: input.settled !== undefined ? !!input.settled : true };
          pigeon.owner = input.to;
          pigeon.transfers.push(transfer);
          // 新增转让（尤其未结清）后，未开赛名额失效重算
          invalidateAndRecompute(db, pigeon.ringNo);
        }
        if (actionMatch[2] === "races") {
          const race = db.races.find(r => r.id === input.raceId);
          const raceDate = input.date || (race ? race.date : todayStr());
          // 已开赛成绩仍归原鸽主：按比赛日归属，转棚不改变既往成绩归属
          const owner = ownerAtDate(pigeon, raceDate);
          pigeon.races.push({ date: raceDate, event: input.event || (race ? race.name : "未命名赛事"), raceId: input.raceId || "", distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0), owner });
        }
        if (actionMatch[2] === "vaccines") {
          pigeon.vaccines.push({ date: input.date || todayStr(), name: input.name });
          // 疫苗更正后，未开赛名额失效重算
          invalidateAndRecompute(db, pigeon.ringNo);
        }
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      });
    }
    if (req.method === "GET" && url.pathname === "/api/races") {
      const db = await loadDb();
      return sendJson(res, 200, db.races);
    }
    if (req.method === "POST" && url.pathname === "/api/races") {
      return withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        const race = { id: genId("race"), name: input.name, date: input.date };
        db.races.push(race);
        await saveDb(db);
        return sendJson(res, 201, race);
      });
    }
    if (req.method === "GET" && url.pathname === "/api/registrations") {
      const db = await loadDb();
      return sendJson(res, 200, { slots: db.slots, conflicts: db.conflicts });
    }
    if (req.method === "POST" && url.pathname === "/api/registrations") {
      return withLock(async () => {
        const db = await loadDb();
        const input = await body(req);
        const formNo = String(input.formNo || "").trim();
        const pigeonRing = String(input.pigeonRing || "").trim();
        const raceId = String(input.raceId || "").trim();
        if (!formNo) return sendJson(res, 400, { error: "form_no_required", message: "缺少现场单号" });
        if (!pigeonRing) return sendJson(res, 400, { error: "pigeon_ring_required", message: "缺少足环号" });
        const pigeon = db.pigeons.find(item => item.ringNo === pigeonRing);
        if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found", message: "鸽只不存在" });
        const race = db.races.find(r => r.id === raceId);
        if (!race) return sendJson(res, 404, { error: "race_not_found", message: "比赛不存在" });
        if (race.date < todayStr()) return sendJson(res, 400, { error: "race_started", message: "比赛已开赛，不再接受报名" });

        // 凭现场单号去重：同一单号重试，无论之前生成的是名额还是冲突，都原样返回，不重复生成
        const dupSlot = db.slots.find(s => s.formNo === formNo);
        if (dupSlot) return sendJson(res, 200, { status: "idempotent", slot: dupSlot });
        const dupConflict = db.conflicts.find(c => c.formNo === formNo);
        if (dupConflict) return sendJson(res, 200, { status: "idempotent", conflict: dupConflict });

        // 报名资格核验：疫苗到期或转让未结清则不让报名
        const elig = checkEligibility(pigeon, race);
        if (!elig.eligible) return sendJson(res, 403, { error: elig.reason, message: elig.message });

        // 每只鸽每场比赛只留一个待确认名额；先到者占用，后到内容留冲突
        const active = db.slots.find(s => s.pigeonRing === pigeonRing && s.raceId === raceId && s.status === "pending");
        if (active) {
          const conflict = {
            id: genId("conflict"), formNo, pigeonRing, raceId, raceName: race.name,
            payload: input, submittedAt: new Date().toISOString(), conflictWith: active.id, status: "conflict"
          };
          db.conflicts.push(conflict);
          await saveDb(db);
          return sendJson(res, 200, { status: "conflict", conflict, occupiedBy: active });
        }

        const slot = {
          id: genId("slot"), formNo, pigeonRing, raceId, raceName: race.name,
          status: "pending", reason: null, message: null,
          ownerAtSubmit: pigeon.owner, payload: input,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        db.slots.push(slot);
        await saveDb(db);
        return sendJson(res, 201, { status: "occupied", slot });
      });
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
