// 端到端验证：赛季报名核验台六条规则
// 用法：node test/verify.mjs
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 43123;
const BASE = `http://localhost:${PORT}`;
const dbFile = join(tmpdir(), `pigeons-verify-${Date.now()}.json`);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra != null ? JSON.stringify(extra) : ""); }
}

const child = spawn(process.execPath, [join(process.cwd(), "server.js")], {
  env: { ...process.env, PORT: String(PORT), PIGEON_DB: dbFile },
  stdio: ["ignore", "pipe", "inherit"]
});

async function api(path, opts = {}) {
  if (opts.body) {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

try {
  // 等服务起来
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + "/api/console"); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }

  const { data: console0 } = await api("/api/console");
  const ev300 = console0.events.find(e => e.id === "ev-300");
  const evOld = console0.events.find(e => e.id === "ev-old");
  check("种子：未来赛事未开赛", ev300.started === false, ev300);
  check("种子：历史赛事已开赛", evOld.started === true, evOld);

  // 规则1：每只鸽每场比赛只留一个待确认名额
  console.log("\n[1] 唯一待确认名额");
  const r1 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-300", applicant: "东湾棚" } });
  check("首次提交 201 占用名额", r1.status === 201 && r1.data.slot && r1.data.slot.status === "pending", r1.data);
  const ticketA = r1.data.slot.ticket;

  // 规则2：两人同时提交（序列化触发），先到者占用，后到留冲突
  console.log("\n[2] 并发提交 → 先到占名额，后到留冲突");
  const fired = await Promise.all([
    api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-003", eventId: "ev-300", applicant: "X" } }), // 会因未结清被拒
    api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2022-188", eventId: "ev-300", applicant: "育种棚" } }), // 无疫苗被拒
  ]);
  check("资格门槛先于名额：未结清/无疫苗均 422", fired.every(r => r.status === 422), fired.map(r => r.status));

  const [a, b] = await Promise.all([
    api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: "T-CONC-1" } }),
    api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: "T-CONC-2" } })
  ]);
  const codes = [a.status, b.status].sort();
  check("并发同鸽同场：一个 201 一个 409", codes.join(",") === "201,409", [a.status, b.status]);
  const loser = a.status === 409 ? a : b;
  check("后到响应为冲突（slot_pending）且带现场单", loser.data.conflict && loser.data.conflict.reason === "slot_pending" && /^T-CONC-/.test(loser.data.conflict.ticket), loser.data);

  // 再来第三个提交（同一鸽主重复提交），仍然只冲突不新增名额
  const c = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: "T-CONC-3" } });
  check("第三提交仍落冲突", c.status === 409 && c.data.conflict.reason === "slot_pending");
  const { data: c1 } = await api("/api/console");
  check("ev-500 上该鸽只有一个名额", c1.slots.filter(s => s.ringNo === "CHN-2026-002" && s.eventId === "ev-500").length === 1);
  check("冲突记录共 2 条", c1.conflicts.filter(x => x.ringNo === "CHN-2026-002" && x.eventId === "ev-500").length === 2);

  // 规则3a：疫苗到期不让报名
  console.log("\n[3] 疫苗到期 / 转让未结清 / 已开赛 → 拒收");
  const rv = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-001", eventId: "ev-300", applicant: "北岸棚", ticket: "T-VAX" } });
  check("疫苗到期：422 vaccine_expired", rv.status === 422 && rv.data.problems.some(p => p.code === "vaccine_expired"), rv.data);
  const rt = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-003", eventId: "ev-300", applicant: "西岭新棚", ticket: "T-TRF" } });
  check("转让未结清：422 transfer_unsettled", rt.status === 422 && rt.data.problems.some(p => p.code === "transfer_unsettled"), rt.data);
  const rs = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-old", applicant: "东湾棚", ticket: "T-OLD" } });
  check("已开赛：422 event_started", rs.status === 422 && rs.data.problems.some(p => p.code === "event_started"), rs.data);
  const { data: c2 } = await api("/api/console");
  check("拒收均未生成名额/冲突", !c2.slots.some(s => ["T-VAX", "T-TRF", "T-OLD"].includes(s.ticket)) && !c2.conflicts.some(x => ["T-VAX", "T-TRF", "T-OLD"].includes(x.ticket)));
  check("提交人与现鸽主不一致也被拒", (await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-300", applicant: "冒充者", ticket: "T-FAKE" } })).data.problems?.[0]?.code === "owner_mismatch");

  // 规则4：已开赛成绩归原鸽主
  console.log("\n[4] 已开赛成绩归原鸽主");
  // 003 有未结清转让 南岸老棚→西岭新棚（3天前）。录入更早一场归巢成绩，应归南岸老棚
  const race = await api("/api/pigeons/CHN-2026-003/races", { method: "POST", body: { event: "历史站", distance: 200, rank: 5, date: new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10) } });
  check("历史归巢成绩归属原鸽主 南岸老棚", race.data.races.at(-1).owner === "南岸老棚", race.data.races.at(-1));
  // 录入后再补一条更新的转让，成绩归属不变（已固化）
  await api("/api/pigeons/CHN-2026-003/transfers", { method: "POST", body: { to: "再转一手", date: new Date().toISOString().slice(0, 10) } });
  const { data: p3 } = await api("/api/pigeons/CHN-2026-003/relation");
  check("档案再转让后，已录入成绩仍归原鸽主", p3.pigeon.races.some(r => r.event === "历史站" && r.owner === "南岸老棚") && p3.pigeon.owner === "再转一手");

  // 规则5：写盘失败凭现场单重试，不重复生成名额
  console.log("\n[5] 写盘失败 → 凭现场单幂等重试");
  // 先给 001 补一针覆盖比赛日的疫苗，使其具备资格（该鸽此刻没有待确认名额）
  const future = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  await api("/api/pigeons/CHN-2026-001/vaccines", { method: "POST", body: { date: new Date().toISOString().slice(0, 10), expiresOn: future, name: "补打新城疫" } });
  const fail = await api("/api/registrations", { method: "POST", headers: { "X-Simulate-Write-Fail": "1" }, body: { ringNo: "CHN-2026-001", eventId: "ev-500", applicant: "北岸棚", ticket: "T-WF-1" } });
  check("模拟写盘失败返回 500 并附现场单", fail.status === 500 && fail.data.ticket === "T-WF-1", fail.data);
  const { data: c3 } = await api("/api/console");
  check("失败后没有残留名额", !c3.slots.some(s => s.ticket === "T-WF-1"));
  // 凭原单重试 → 成功占用（之前没落过盘，所以新建 201）
  const retry2 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-001", eventId: "ev-500", applicant: "北岸棚", ticket: "T-WF-1" } });
  check("原单重试成功 201", retry2.status === 201 && retry2.data.slot.ticket === "T-WF-1", retry2.data);
  const retry3 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-001", eventId: "ev-500", applicant: "北岸棚", ticket: "T-WF-1" } });
  check("同一现场单再试：200 retry=true，仍是同一个名额（不重复生成）", retry3.status === 200 && retry3.data.retry === true && retry3.data.slot.id === retry2.data.slot.id, retry3.data);
  // 后到输家的现场单重试：幂等返回原冲突（首次 409，重试 200 retry=true，并发下输家单号不确定）
  const cfRetry = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: loser.data.conflict.ticket } });
  check("冲突现场单重试幂等（200 retry=true，仍是原冲突）", cfRetry.status === 200 && cfRetry.data.retry === true && cfRetry.data.conflict.id === loser.data.conflict.id);

  // 规则6：档案/疫苗更正后，未开赛名额失效重算
  console.log("\n[6] 档案/疫苗更正 → 未开赛名额失效");
  check("前置：002/ev-300 名额待确认", c3.slots.find(s => s.ticket === ticketA)?.status === "pending");
  check("前置：002/ev-500 名额待确认", c3.slots.some(s => s.ringNo === "CHN-2026-002" && s.eventId === "ev-500" && s.status === "pending"));
  await api("/api/pigeons/CHN-2026-002/profile", { method: "PATCH", body: { color: "白条雨点" } });
  const { data: c4 } = await api("/api/console");
  const after = c4.slots.find(s => s.ticket === ticketA);
  check("档案更正后 ev-300 名额 invalidated 且带原因", after.status === "invalidated" && /档案更正/.test(after.staleReason), after);
  check("档案更正同时失效该鸽全部未开赛待确认名额", c4.slots.filter(s => s.ringNo === "CHN-2026-002" && s.status === "invalidated").length === 2);
  // 已失效后重新提交：允许，生成新名额（旧的仍保留可追溯）
  const reg2 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-300", applicant: "东湾棚", ticket: "T-RE-1" } });
  check("失效后重报 ev-300 成功", reg2.status === 201 && reg2.data.slot.status === "pending");
  const regEv500 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: "T-RE-2" } });
  check("失效后重报 ev-500 成功", regEv500.status === 201);
  // 疫苗更正：使新名额失效
  await api("/api/pigeons/CHN-2026-002/vaccines", { method: "POST", body: { date: new Date().toISOString().slice(0, 10), expiresOn: new Date().toISOString().slice(0, 10), name: "当天到期针" } });
  const { data: c5 } = await api("/api/console");
  const w2 = c5.slots.find(s => s.id === regEv500.data.slot.id);
  check("疫苗更正后名额失效且带疫苗原因", w2.status === "invalidated" && /疫苗记录更正/.test(w2.staleReason), w2);
  // 旧针（-30/+150）对 ev-500 仍有效 → 可重新占用
  const reg3 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: "T-RE-3" } });
  check("重算仍合格 → 可重新占用名额", reg3.status === 201);

  // 转让结清后可报名；未结清期间一律拒
  console.log("\n[补充] 转让结清 → 放行");
  const { data: p3b } = await api("/api/pigeons/CHN-2026-003/relation");
  const unsettledId = p3b.pigeon.transfers.find(t => !t.settled).id;
  const blocked = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-003", eventId: "ev-300", applicant: "再转一手", ticket: "T-BLK" } });
  check("未结清：仍 422", blocked.status === 422);
  await api(`/api/pigeons/CHN-2026-003/transfers/${unsettledId}/settle`, { method: "POST" });
  // 还有第二条也未结清
  const { data: p3c } = await api("/api/pigeons/CHN-2026-003/relation");
  const left = p3c.pigeon.transfers.find(t => !t.settled);
  check("结清一条后仍有未结清", !!left);
  await api(`/api/pigeons/CHN-2026-003/transfers/${left.id}/settle`, { method: "POST" });
  const ok3 = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-003", eventId: "ev-300", applicant: "再转一手", ticket: "T-OK3" } });
  check("全部结清且疫苗有效 → 201", ok3.status === 201, ok3.data);

  // 确认名额 & 已确认后再提交 → conflict(slot_confirmed)
  console.log("\n[补充] 确认与确认后冲突");
  const cf = await api(`/api/registrations/${reg3.data.slot.id}/confirm`, { method: "POST" });
  check("确认成功", cf.status === 200 && cf.data.status === "confirmed");
  const afterConf = await api("/api/registrations", { method: "POST", body: { ringNo: "CHN-2026-002", eventId: "ev-500", applicant: "东湾棚", ticket: "T-AFTER" } });
  check("已确认后提交 → 409 slot_confirmed", afterConf.status === 409 && afterConf.data.conflict.reason === "slot_confirmed", afterConf.data);

  // 页面列出待确认名额和冲突
  console.log("\n[页面]");
  const pageRes = await fetch(BASE + "/");
  const html = await pageRes.text();
  check("页面含待确认名额区", html.includes("待确认名额"));
  check("页面含冲突记录区", html.includes("冲突记录"));

} catch (e) {
  fail++;
  console.error("测试异常：", e);
} finally {
  child.kill();
  await once(child, "exit").catch(() => {});
  rmSync(dbFile, { force: true });
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
