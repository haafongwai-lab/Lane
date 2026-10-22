const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let snapshot = null;
let activeView = "routing";
let refreshing = false;

function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function compact(number) {
  const value = Number(number || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function duration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
}

function creditNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number >= 10000
    ? `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(number);
}

// The plugin's usage hook reports the cycle's credits used against what it
// grants, as a percent plus the two counts, and when the credits run out.
function creditView(usage) {
  if (!usage || usage.error) return null;
  const window = (usage.windows || []).find((item) => item.name === "Credits")
    || (usage.windows || [])[0];
  if (!window) return null;
  const used = Number(window.amount);
  const limit = Number(window.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const percent = Number.isFinite(Number(window.used))
    ? Math.max(0, Math.min(100, Number(window.used)))
    : (used / limit) * 100;
  return {
    plan: usage.plan || "",
    used,
    limit,
    left: Math.max(0, limit - used),
    percent,
    runsOutAt: window.runsOutAt || "",
    runsOut: Number(window.runsOut) || 0
  };
}

function renderCredits(usage) {
  const credits = creditView(usage);
  $("#account-credits").textContent = credits
    ? `积分 ${creditNumber(credits.used)} / ${creditNumber(credits.limit)}`
    : usage?.error ? "积分不可用" : "积分 —";
}

function creditRate(model) {
  if (model.free === true) return "免费";
  if (!Number.isFinite(model.rate)) return "—";
  if (model.rate === 0) return "免费";
  const rate = new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(model.rate);
  return Number.isFinite(model.rateWas) && model.rateWas > model.rate
    ? `<span class="rate-was">×${rate}</span><s>×${model.rateWas}</s>`
    : `×${rate}`;
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = "toast"; }, 3600);
}

function go(view) {
  activeView = view;
  // Entering the page always re-reads it: the status poll is paused while
  // it is open, so the figures would otherwise be as old as the last visit.
  if (view === "activity") loadUsage();
  $$(".nav").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    snapshot = await window.lane.status();
    render();
  } catch (error) {
    if (!quiet) toast(`读取状态失败：${error.message}`, true);
    $("#side-dot").className = "dot bad";
    $("#side-status").textContent = "网关连接失败";
  } finally {
    refreshing = false;
  }
}

function render() {
  if (!snapshot) return;
  const { signedIn, account, agents, models, recent = [] } = snapshot;
  const running = recent.filter((item) => item.status === "running");
  const last = recent[0];
  const codexOn = agents?.codex?.connected;
  const claudeOn = agents?.claudeDesktop?.connected;

  $("#side-dot").className = "dot ok";
  $("#side-status").textContent = snapshot.starting
    ? "网关启动中"
    : signedIn ? "网关已就绪" : "网关运行中 · 等待登录";
  $("#route-live-dot").className = "dot ok";
  $("#route-live").textContent = running.length ? "处理中" : "实时";
  $("#route-count").textContent = `${recent.length} 个请求`;
  // The rail only animates while a request is on the wire, so the motion
  // always means something is happening rather than looping for decoration.
  $(".route-canvas").classList.toggle("busy", running.length > 0);
  renderRouteAgent(last, { codexOn, claudeOn });
  $("#lane-state").textContent = "运行中";
  $("#provider-state").textContent = signedIn ? "已登录" : "未登录";
  $("#provider-state").previousElementSibling.classList.toggle("off", !signedIn);
  $("#account-name").textContent = account || "WorkBuddy";
  $("#account-plan").textContent = snapshot.domain || "本地账号";
  $("#health-account").textContent = account || "未登录";
  $("#health-domain").textContent = snapshot.domain || "WorkBuddy";
  $("#health-codex").textContent = codexOn ? "已接入" : "未接入";
  $("#health-claude").textContent = claudeOn ? "已接入" : "未接入";
  $("#codex-connect-state").textContent = codexOn ? "已接入" : "未接入";
  $("#codex-connect-state").classList.toggle("on", codexOn);
  $("#claude-connect-state").textContent = claudeOn ? "已接入" : "未接入";
  $("#claude-connect-state").classList.toggle("on", claudeOn);
  $("#codex-connect").textContent = codexOn ? "重新接入 Codex" : "接入 Codex";
  $("#claude-connect").textContent = claudeOn ? "重新接入 Claude" : "接入 Claude";
  $("#gateway-address").textContent = (snapshot.gateway || "http://127.0.0.1:3426").replace(/^https?:\/\//, "");
  renderCredits(signedIn ? snapshot.usage : null);
  $("#data-path").textContent = snapshot.dataDir || "%LOCALAPPDATA%\\lane";
  $("#log-name").textContent = snapshot.ownsGateway === false ? "lane.log" : "desktop.log";
  $("#autostart").checked = Boolean(snapshot.autostart);

  renderModels(models || []);
  renderUsageRecent();
  renderAccounts();
  renderCheckin();
}

// ---- accounts -------------------------------------------------------------

// Every signed-in account stays in the list; one of them is the route and
// the rest wait, switched on or off, without losing their sign-in.
//
// The row carries the account's own check-in state, so the daily card beside
// it only has to show the schedule and the day's progress.
function renderAccounts() {
  const accounts = snapshot.accounts || [];
  const activeId = snapshot.activeId || "";
  $("#account-count").textContent = accounts.length ? `${accounts.length} 个` : "";
  const list = $("#account-list");
  const foot = $("#accounts-foot");
  if (!accounts.length) {
    list.innerHTML = '<div class="empty">还没有账号。点「添加账号」登录 WorkBuddy。</div>';
    foot.textContent = "";
    return;
  }
  const carrier = accounts.find((account) => account.id === activeId);
  const off = accounts.filter((account) => !account.enabled).length;
  foot.textContent = [
    carrier ? `${carrier.label} 正在承载请求` : "没有账号承载请求",
    off ? `${off} 个已关闭` : ""
  ].filter(Boolean).join(" · ");
  const checkin = new Map((snapshot.checkin?.accounts || []).map((item) => [item.id, item]));
  list.innerHTML = accounts.map((account) => {
    const active = account.id === activeId;
    const tags = [
      active ? '<em class="tag-on">当前</em>' : "",
      account.enterpriseId ? '<em class="tag-soft">企业</em>' : ""
    ].filter(Boolean).join("");
    return `
    <div class="account-row${active ? " active" : ""}${account.enabled ? "" : " disabled"}" data-id="${esc(account.id)}">
      <div class="account-avatar"><img src="assets/workbuddy-official.svg" alt=""></div>
      <div class="account-main">
        <div class="account-title"><b>${esc(account.label)}</b>${tags}</div>
        <div class="account-meta">
          <span class="account-host">${esc(account.domain || "WorkBuddy")}</span>
          <i>·</i>
          <code>${esc(account.id.slice(0, 8))}</code>
          ${checkinChip(checkin.get(account.id), account)}
        </div>
      </div>
      <div class="account-actions">
        <button class="mini" data-act="activate"${active || !account.enabled ? " disabled" : ""}>${active ? "使用中" : "切换"}</button>
        <label class="switch small" title="${account.enabled ? "关闭该账号" : "启用该账号"}">
          <input type="checkbox" data-act="enabled"${account.enabled ? " checked" : ""}>
          <span></span>
        </label>
        <button class="mini quiet" data-act="checkin">签到</button>
        <button class="icon-mini" data-act="remove" title="移除账号" aria-label="移除账号">✕</button>
      </div>
    </div>`;
  }).join("");
}

// One chip per account, in the row it belongs to, instead of a second list
// to read against.
function checkinChip(item, account) {
  if (!account.enabled) return '<span class="account-chip idle">已关闭</span>';
  if (!item) return '<span class="account-chip idle">今日未签到</span>';
  if (item.status === "done") {
    return `<span class="account-chip ok">${item.reward ? `已签到 +${esc(item.reward)}` : "已签到"}</span>`;
  }
  if (item.status === "failed") return '<span class="account-chip warn">签到失败</span>';
  return '<span class="account-chip idle">今日未签到</span>';
}

function renderCheckin() {
  const checkin = snapshot.checkin || {};
  const settings = checkin.settings || { enabled: true, hour: 9, minute: 0 };
  const enabled = $("#checkin-enabled");
  if (document.activeElement !== enabled) enabled.checked = settings.enabled !== false;
  const hour = $("#checkin-hour");
  const minute = $("#checkin-minute");
  if (document.activeElement !== hour) hour.value = String(settings.hour).padStart(2, "0");
  if (document.activeElement !== minute) minute.value = String(settings.minute).padStart(2, "0");

  const items = (checkin.accounts || []).filter((item) => item.enabled);
  const done = items.filter((item) => item.status === "done").length;
  $("#checkin-progress").hidden = items.length === 0;
  $("#checkin-ratio").textContent = items.length ? `${done} / ${items.length}` : "—";
  $("#checkin-fill").style.width = items.length ? `${Math.round((done / items.length) * 100)}%` : "0%";

  // Only what needs attention stays below the meter.
  const issues = items.filter((item) => item.status === "failed");
  const list = $("#checkin-list");
  list.hidden = issues.length === 0;
  list.innerHTML = issues.map((item) => `
    <div class="checkin-item">
      <span>${esc(item.label)}</span>
      <b class="err">${esc(item.error || "签到失败")}</b>
    </div>`).join("");
}

async function accountAction(action, id, options = {}) {
  try {
    await window.lane.account(action, id, options);
    toast({
      activate: "已切换账号",
      enabled: options.enabled ? "已启用账号" : "已关闭账号",
      remove: "已移除账号"
    }[action] || "操作完成");
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message || String(error), true);
  }
}

// The route's agent slot shows whichever agent sent the latest request,
// falling back to the connected one, and the workflow lists both.
function renderRouteAgent(last, { codexOn, claudeOn }) {
  const both = codexOn && claudeOn;
  const none = !codexOn && !claudeOn;
  $("#client-codex-logo").classList.toggle("hidden", !codexOn);
  $("#client-claude-logo").classList.toggle("hidden", !claudeOn);
  const name = both ? "Codex + Claude" : codexOn ? "Codex" : claudeOn ? "Claude Desktop" : "无智能体接入";
  $("#client-name").textContent = name;
  // "工作模型" only while a request is on the wire, else a quiet hint.
  const working = last?.status === "running";
  $("#client-model").textContent = working
    ? `工作模型 ${last.model}`
    : none ? "等待接入" : "等待请求";
  $("#client-state").textContent = none ? "未接入" : "已接入";
  $("#client-state").previousElementSibling.classList.toggle("off", none);
}

function renderModels(models) {
  const list = $("#model-list");
  if (!models.length) {
    list.innerHTML = '<div class="empty">登录 WorkBuddy 后可读取模型目录。</div>';
    return;
  }
  list.innerHTML = models.map((model) => `
    <div class="model-row">
      <div class="model-name">${esc(model.name || model.id)}</div>
      <span>${model.context ? `${compact(model.context)} tokens` : "—"}</span>
      <span class="credit-rate">${creditRate(model)}</span>
      <code>${esc(model.owned_by || "workbuddy")}</code>
      <span class="soft-label">可用</span>
    </div>`).join("");
}

// ---- usage ----------------------------------------------------------------

// The overview is computed in main over the whole journal, while this page's
// request list comes from the status snapshot. Both are refreshed together.
let usage = null;
let usageRange = "today";
let usageLoading = false;
let usageQueued = false;

// A range switch while a read is in flight must not be dropped: without
// queueing, the page would keep showing the old range while the control says
// the new one. One trailing reload is enough, whatever was clicked meanwhile.
async function loadUsage() {
  if (usageLoading) {
    usageQueued = true;
    return;
  }
  usageLoading = true;
  try {
    usage = await window.lane.usage(usageRange);
    renderUsage();
  } catch (error) {
    $("#usage-chart").innerHTML = `<div class="empty">${esc(error.message || "读取用量失败")}</div>`;
  } finally {
    usageLoading = false;
    if (usageQueued) {
      usageQueued = false;
      loadUsage();
    }
  }
}

const AGENT_LABELS = { codex: "Codex", "claude-desktop": "Claude Desktop", openai: "OpenAI 兼容" };

function agentLabel(agent) {
  return AGENT_LABELS[agent] || agent || "未知来源";
}

// Credits carry a lot of leading zeros at flash-model prices; show enough of
// them to be meaningful, and never claim more precision than was recorded.
function credits(value, digits = 4) {
  const number = Number(value) || 0;
  if (number === 0) return "0";
  if (number >= 1000) return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(number);
  if (number >= 1) return number.toFixed(2).replace(/\.?0+$/, "");
  return number.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function renderUsage() {
  if (!usage) return;
  const { totals, series, models, quota } = usage;

  // One line of headline figures replaces the four metric cards: the totals
  // still read at a glance, and the chart below carries the detail.
  $("#usage-summary").innerHTML = [
    `<b>${credits(totals.credits)}</b> 积分`,
    `<b>${compact(totals.totalTokens)}</b> Token`,
    `<b>${compact(totals.inputTokens)}</b> 输入 / <b>${compact(totals.outputTokens)}</b> 输出`,
    `<b>${totals.requests}</b> 次请求`
  ].join(" · ");

  // The range control comes back with the report, so a stale tab can't
  // leave the page showing one range and offering another.
  for (const button of $$("#usage-range button")) {
    button.classList.toggle("active", button.dataset.range === usage.range);
    button.setAttribute("aria-selected", String(button.dataset.range === usage.range));
  }

  // The page's age is part of the figure: credits are read from a cache, so
  // say when they were last read rather than implying they are live.
  const stamp = usage.at ? new Date(usage.at).toLocaleTimeString("zh-CN", { hour12: false }) : "";
  $("#usage-updated").textContent = stamp ? `更新于 ${stamp}` : "";

  renderUsageChart(series);
  renderUsageQuota(quota);
  renderUsageModels(models, totals);
  renderUsageRecent();
}

// Bars are paired per day: credits and tokens share the column but not the
// scale, since one credit is a multiple of a million tokens. A range where
// nothing ran at all says so instead of drawing a flat empty chart.
function renderUsageChart(series) {
  const node = $("#usage-chart");
  const active = series.filter((item) => (item.requests || 0) > 0);
  if (!active.length) {
    node.innerHTML = '<div class="empty">所选区间内还没有请求。</div>';
    return;
  }
  const creditMax = Math.max(...series.map((item) => Number(item.credits) || 0), 0);
  const tokenMax = Math.max(...series.map((item) => Number(item.totalTokens) || 0), 0);
  const showTokens = series.length > 1;
  const peak = series.reduce((best, item) => ((Number(item.credits) || 0) > (Number(best.credits) || 0) ? item : best), series[0]);
  node.innerHTML = `
    <div class="usage-bars${showTokens ? "" : " single"}">
      ${series.map((item) => {
        const creditHeight = creditMax ? (Number(item.credits) || 0) / creditMax * 100 : 0;
        const tokenHeight = tokenMax ? (Number(item.totalTokens) || 0) / tokenMax * 100 : 0;
        const label = new Date(`${item.date}T00:00:00`).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
        const detail = [
          `${item.date}`,
          `积分 ${credits(item.credits)}`,
          `Token ${compact(item.totalTokens)}`,
          `请求 ${item.requests} 次`
        ].join(" · ");
        const empty = !(item.requests || 0);
        // An empty day keeps a 1px stub (the class supplies its colour);
        // a busy day always shows at least 1.5% so it is never invisible.
        const height = (value) => (empty ? 0.6 : Math.max(value, 1.5)).toFixed(1);
        return `<div class="usage-bar${empty ? " quiet" : ""}" title="${esc(detail)}">
          <div class="usage-bar-track">
            <i class="credits" style="height:${height(creditHeight)}%"></i>
            ${showTokens ? `<i class="tokens" style="height:${height(tokenHeight)}%"></i>` : ""}
          </div>
          <span>${esc(label)}</span>
        </div>`;
      }).join("")}
    </div>
    <p class="usage-chart-note">${esc(peak.date)} 消耗最高 · 积分 ${credits(peak.credits)} · 请求 ${peak.requests} 次</p>`;
}

// WorkBuddy's own meter: the cycle's credits against what the plan grants.
function renderUsageQuota(quota) {
  const node = $("#usage-quota");
  const plan = $("#usage-plan");
  if (!quota || quota.error) {
    plan.textContent = "—";
    node.innerHTML = `<div class="empty">${esc(quota?.error && quota.error !== "not signed in" ? quota.error : "登录后显示账户额度。")}</div>`;
    return;
  }
  plan.textContent = quota.plan || "账户";
  const view = (quota.windows || []).find((item) => item.name === "Credits") || (quota.windows || [])[0];
  if (!view) {
    node.innerHTML = '<div class="empty">该账户没有可读的积分额度。</div>';
    return;
  }
  const used = Number(view.amount) || 0;
  const limit = Number(view.limit) || 0;
  const share = Number.isFinite(Number(view.used))
    ? Math.max(0, Math.min(100, Number(view.used)))
    : limit ? (used / limit) * 100 : 0;
  const left = Math.max(0, limit - used);
  // The reset date lives on the credits window for an enterprise account;
  // a personal account's summary does not carry one at all.
  const resetAt = view.resetsAt || quota.resetsAt;
  const reset = resetAt
    ? new Date(resetAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
    : "";
  node.innerHTML = `
    <div class="quota-amount"><b>${creditNumber(left)}</b><span>剩余积分 / 共 ${creditNumber(limit)}</span></div>
    <div class="quota-meter"><i style="width:${share.toFixed(1)}%"></i></div>
    <div class="quota-foot">
      <span>已用 ${percent(share / 100)}</span>
      ${reset ? `<span>${esc(reset)} 重置</span>` : ""}
    </div>`;
}

function renderUsageModels(models, totals) {
  const node = $("#usage-models");
  if (!models.length) {
    node.innerHTML = '<div class="empty">所选区间内还没有请求。</div>';
    return;
  }
  node.innerHTML = `
    <div class="usage-table-head"><span>模型</span><span>请求</span><span>输入 / 输出</span><span>积分</span><span>占比</span></div>
    ${models.map((row) => `
      <div class="usage-table-row">
        <div class="usage-model"><b>${esc(row.model)}</b><code>${Number.isFinite(row.rate) ? `×${row.rate}` : "—"}</code></div>
        <span>${row.requests}</span>
        <span class="usage-io">${compact(row.inputTokens)} <i>/</i> ${compact(row.outputTokens)}</span>
        <span class="usage-cost">${credits(row.credits)}</span>
        <div class="usage-share"><div class="share-track"><i style="width:${(row.share * 100).toFixed(1)}%"></i></div><span>${percent(row.share)}</span></div>
      </div>`).join("")}
    <div class="usage-table-foot">
      <span>合计</span><span>${totals.requests}</span>
      <span>${compact(totals.inputTokens)} / ${compact(totals.outputTokens)}</span>
      <span>${credits(totals.credits)}</span><span></span>
    </div>`;
}

function renderUsageRecent() {
  // Never truncate the snapshot in place: the route card and the activity
  // page read the same array, and a shorter list would silently shrink them.
  const all = snapshot?.recent || [];
  const rows = all.slice(0, 12);
  $("#usage-recent-count").textContent = rows.length ? `最近 ${rows.length} 条` : "0 条";
  const node = $("#usage-recent");
  if (!rows.length) {
    node.innerHTML = '<div class="empty">还没有请求。先用 Codex 发起一轮对话。</div>';
    return;
  }
  node.innerHTML = rows.map((item) => {
    const when = new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const cache = item.inputTokens ? item.cachedTokens / item.inputTokens : 0;
    const state = item.status === "running" ? "进行中" : item.status === "error" ? "失败" : "完成";
    return `<div class="recent-row">
      <span class="recent-time">${esc(when)}</span>
      <span class="agent-pill">${esc(agentLabel(item.agent))}</span>
      <span class="recent-model">${esc(item.model)}</span>
      <span class="recent-state ${item.status === "error" ? "err" : item.status === "running" ? "live" : "ok"}">${state}</span>
      <span class="recent-tokens">${compact(item.totalTokens)}<i>${cache ? ` · 缓存 ${percent(cache)}` : ""}</i></span>
      <span class="recent-cost">${credits(item.credits ?? 0)}</span>
    </div>`;
  }).join("");
}

async function command(command, options = {}, success = "操作完成") {
  try {
    await window.lane.command(command, options);
    toast(success);
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message || String(error), true);
  }
}

async function signIn() {
  try {
    const result = await window.lane.signIn();
    if (result.url) await window.lane.openURL(result.url);
    toast("已打开 WorkBuddy 登录页，完成后会自动更新状态");
  } catch (error) {
    toast(`登录失败：${error.message}`, true);
  }
}

$$(".nav").forEach((button) => button.addEventListener("click", () => go(button.dataset.view)));
$("#refresh-agents").addEventListener("click", () => refresh());
$("#refresh-models").addEventListener("click", () => refresh());
$("#refresh-activity").addEventListener("click", async () => {
  await refresh();
  await loadUsage();
});
$("#usage-range").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button || button.dataset.range === usageRange) return;
  usageRange = button.dataset.range;
  for (const item of $$("#usage-range button")) item.classList.toggle("active", item === button);
  loadUsage();
});
$("#codex-connect").addEventListener("click", () => command("connect", { agent: "codex" }, "Codex 已接入，请新建会话"));
$("#codex-disconnect").addEventListener("click", () => command("disconnect", { agent: "codex" }, "Codex 已断开"));
$("#claude-connect").addEventListener("click", () => command("connect", { agent: "claude-desktop" }, "Claude Desktop 已接入，请重启客户端"));
$("#claude-disconnect").addEventListener("click", () => command("disconnect", { agent: "claude-desktop" }, "Claude Desktop 已断开"));
$("#quick-signin").addEventListener("click", signIn);
$("#add-account").addEventListener("click", signIn);
$("#refresh-accounts").addEventListener("click", () => refresh());
$("#account-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button || button.disabled) return;
  const row = button.closest("[data-id]");
  const id = row?.dataset.id;
  if (!id) return;
  if (button.dataset.act === "activate") return accountAction("activate", id);
  if (button.dataset.act === "checkin") return runCheckin(id);
  if (button.dataset.act === "remove") {
    const label = row.querySelector("b")?.textContent || id;
    if (!confirm(`移除账号「${label}」？这会删除 Lane 保存的该账号登录信息。`)) return;
    return accountAction("remove", id);
  }
});
$("#account-list").addEventListener("change", (event) => {
  const input = event.target.closest('input[data-act="enabled"]');
  if (!input) return;
  const id = input.closest("[data-id]")?.dataset.id;
  if (id) accountAction("enabled", id, { enabled: input.checked });
});
$("#checkin-enabled").addEventListener("change", (event) => {
  saveCheckinSettings({ enabled: event.target.checked },
    event.target.checked ? "已开启每日签到" : "已关闭每日签到");
});
$("#checkin-save").addEventListener("click", () => {
  const hour = Number($("#checkin-hour").value);
  const minute = Number($("#checkin-minute").value);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    toast("时间需要在 0–23 时、0–59 分之间", true);
    return;
  }
  saveCheckinSettings({ hour, minute }, `签到时间已设为 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
});
$("#checkin-now").addEventListener("click", () => runCheckin(""));

async function saveCheckinSettings(patch, message) {
  try {
    await window.lane.checkinSettings(patch);
    toast(message);
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message || String(error), true);
  }
}

async function runCheckin(id) {
  const button = id ? null : $("#checkin-now");
  if (button) {
    button.disabled = true;
    button.textContent = "正在签到…";
  }
  try {
    const result = await window.lane.checkin(id);
    const results = result?.results || [];
    const done = results.filter((item) => item.status === "done").length;
    const failed = results.filter((item) => item.status === "failed").length;
    toast(
      failed ? `签到完成 ${done} 个，失败 ${failed} 个` : `签到完成 ${done} 个`,
      failed > 0
    );
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message || String(error), true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "立即签到";
    }
  }
}
$("#test-route").addEventListener("click", async () => {
  const button = $("#test-route");
  button.disabled = true;
  button.textContent = "正在测试…";
  try {
    const result = await window.lane.test();
    toast(result.ok ? `链路正常 · ${result.elapsed}ms · ${result.text}` : `测试失败：${result.text}`, !result.ok);
    await refresh({ quiet: true });
  } finally {
    button.disabled = false;
    button.textContent = "测试链路";
  }
});
$("#autostart").addEventListener("change", (event) => {
  command("autostart", { enabled: event.target.checked },
    event.target.checked ? "已开启登录启动" : "已关闭登录启动");
});
$("#open-data").addEventListener("click", () => window.lane.open("data"));
$("#open-log").addEventListener("click", () => window.lane.open("log"));
$("#refresh-route").addEventListener("click", () => refresh());
$("#quit-app").addEventListener("click", async () => {
  if (!confirm("退出 Lane 会同时停止本地网关，确定吗？")) return;
  await window.lane.quit();
});

window.lane.onSignIn(async ({ result, error }) => {
  if (error) toast(`WorkBuddy 登录失败：${error}`, true);
  else if (result) toast("WorkBuddy 登录成功");
  await refresh({ quiet: true });
});

refresh();
setInterval(() => {
  // The usage page already has its own numbers and a range control; polling
  // status behind it would only redraw the request list under the user.
  if (activeView === "activity") return;
  refresh({ quiet: true });
}, 3000);
