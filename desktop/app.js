const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let snapshot = null;
let activeView = "routing";
let refreshing = false;
let refreshQueued = null;
// Toggles still waiting on their command, so a status poll that lands first
// cannot render the old state over the user's click.
let autostartPending = false;
const enabledPending = new Map();

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
  // The meter reports what the cycle has spent; the card answers the question
  // the account page does — how much is left — so it shows the remainder.
  $("#account-credits").textContent = credits
    ? `剩余积分 ${creditNumber(credits.left)} / ${creditNumber(credits.limit)}`
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

// One shared hover popup stands in for the browser's title tooltips: white
// and rounded in the app's own style, and up the moment the pointer arrives
// — a title tooltip waits about a second before it shows at all. Content
// goes in data-tip; newlines render as line breaks (pre-line).
const tipNode = $("#tooltip");
const TIP_MARGIN = 8;
const TIP_GAP = 6;

document.addEventListener("mouseover", (event) => {
  const host = event.target.closest?.("[data-tip]");
  if (!host) {
    tipNode.hidden = true;
    return;
  }
  showTip(host);
});

function showTip(host) {
  tipNode.textContent = host.dataset.tip || "";
  tipNode.hidden = false;
  const box = host.getBoundingClientRect();
  const tip = tipNode.getBoundingClientRect();
  // Below the host when it fits, else above; a wide tip at the screen edge
  // is clamped back into view rather than sliding off.
  let top = box.bottom + TIP_GAP;
  if (top + tip.height > window.innerHeight - TIP_MARGIN) {
    top = box.top - tip.height - TIP_GAP;
  }
  let left = box.left + box.width / 2 - tip.width / 2;
  left = Math.max(TIP_MARGIN, Math.min(left, window.innerWidth - tip.width - TIP_MARGIN));
  tipNode.style.left = `${Math.round(left)}px`;
  tipNode.style.top = `${Math.round(Math.max(top, TIP_MARGIN))}px`;
}

// The popup follows the pointer, not the layout: once the page scrolls or
// resizes under it, it is pointing at the wrong thing, so it goes away.
window.addEventListener("scroll", () => { tipNode.hidden = true; }, true);
window.addEventListener("resize", () => { tipNode.hidden = true; });
// Leaving the window fires no mouseover to clear it, and a pointer standing
// still over an element that a re-render just replaced fires none either —
// both leave the popup frozen where it was.
document.addEventListener("mouseout", (event) => {
  if (!event.relatedTarget) tipNode.hidden = true;
});

function go(view) {
  activeView = view;
  // Entering the page always re-reads it: the status poll is paused while
  // it is open, so the figures would otherwise be as old as the last visit.
  if (view === "activity") loadUsage();
  $$(".nav").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
}

async function refresh({ quiet = false } = {}) {
  // A read that lands while another is in flight must not be dropped: an
  // action that just changed state would leave the page showing the old
  // state for up to one poll period. One trailing reload is enough.
  if (refreshing) {
    refreshQueued = quiet;
    return;
  }
  refreshing = true;
  try {
    snapshot = await window.lane.status();
    render();
  } catch (error) {
    if (!quiet) toast(`读取状态失败：${error.message}`, true);
  } finally {
    refreshing = false;
    if (refreshQueued !== null) {
      const queuedQuiet = refreshQueued;
      refreshQueued = null;
      refresh({ quiet: queuedQuiet });
    }
  }
}

function render() {
  if (!snapshot) return;
  // The re-render replaces the elements any visible popup is attached to;
  // a tip frozen over detached content reads as a bug, so it goes first.
  tipNode.hidden = true;
  const { signedIn, account, agents, models, recent = [] } = snapshot;
  const running = recent.filter((item) => item.status === "running");
  const last = recent[0];
  const codexOn = agents?.codex?.connected;
  const claudeOn = agents?.claudeDesktop?.connected;
  const zcodeOn = agents?.zcode?.connected;

  $("#route-live-dot").className = "dot ok";
  $("#route-live").textContent = running.length ? "处理中" : "实时";
  $("#route-count").textContent = `${recent.length} 个请求`;
  // The rail only animates while a request is on the wire, so the motion
  // always means something is happening rather than looping for decoration.
  $(".route-canvas").classList.toggle("busy", running.length > 0);
  renderRouteAgent(last, { codexOn, claudeOn, zcodeOn });
  // "starting" is what the main process answers while the gateway is coming
  // up or retrying after a failed start; a fixed "运行中" would mask that.
  $("#lane-state").textContent = snapshot.starting ? "启动中…" : "运行中";
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
  $("#health-zcode").textContent = zcodeOn ? "已接入" : "未接入";
  $("#zcode-connect-state").textContent = zcodeOn ? "已接入" : "未接入";
  $("#zcode-connect-state").classList.toggle("on", zcodeOn);
  $("#zcode-connect").textContent = zcodeOn ? "重新接入 ZCode" : "接入 ZCode";
  // The settings page owns the port field now; keep it from being cleared
  // while the user is typing, and only fill it once.
  const portField = $("#gateway-port");
  if (portField && document.activeElement !== portField && !portField.value) {
    portField.value = snapshot.gateway ? String(new URL(snapshot.gateway).port) : "";
  }
  // Every address shown in the UI derives from the snapshot, so a saved
  // port change is reflected everywhere once the gateway restarts on it.
  // (The sidebar shows none of them: that corner is blank by design.)
  const address = (snapshot.gateway || "http://127.0.0.1:3426").replace(/^https?:\/\//, "");
  $("#lane-address").textContent = address;
  $("#health-address").textContent = address;
  $("#codex-address").textContent = `${address}/v1`;
  $("#claude-address").textContent = address;
  renderCredits(signedIn ? snapshot.usage : null);
  $("#data-path").textContent = snapshot.dataDir || "%LOCALAPPDATA%\\lane";
  $("#log-name").textContent = snapshot.ownsGateway === false ? "lane.log" : "desktop.log";
  $("#app-version").textContent = snapshot.version ? `v${snapshot.version}` : "—";
  // A toggle that is still running its command keeps its own state: the
  // autostart call spawns PowerShell with a 30s timeout, and a poll tick
  // that lands first would visibly snap the switch back and invite a second
  // flip.
  if (!autostartPending) $("#autostart").checked = Boolean(snapshot.autostart);

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
  // A sign-in that failed leaves a line here: the toast is gone after three
  // seconds, and a missing account otherwise looks like nothing happened.
  const failed = snapshot.signInError || "";
  const errorNode = $("#accounts-error");
  errorNode.hidden = !failed;
  errorNode.textContent = failed ? `上次登录未完成：${failed}` : "";
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
    // An enable toggle still waiting on its command shows the state the user
    // asked for, not the snapshot from before the click.
    const enabled = enabledPending.get(account.id) ?? account.enabled;
    const tags = [
      active ? '<em class="tag-on">当前</em>' : "",
      account.enterpriseId ? '<em class="tag-soft">企业</em>' : "",
      account.site === "workbuddy-ai" ? '<em class="tag-soft">海外</em>' : ""
    ].filter(Boolean).join("");
    return `
    <div class="account-row${active ? " active" : ""}${enabled ? "" : " disabled"}" data-id="${esc(account.id)}">
      <div class="account-avatar"><img src="assets/workbuddy-official.svg" alt=""></div>
      <div class="account-main">
        <div class="account-title"><b>${esc(account.label)}</b>${tags}</div>
        <div class="account-meta">
          <span class="account-host">${esc(account.domain || "WorkBuddy")}</span>
          <i>·</i>
          <code>${esc(account.id.slice(0, 8))}</code>
          ${checkinChip(checkin.get(account.id), { ...account, enabled })}
        </div>
      </div>
      <div class="account-actions">
        <button class="mini" data-act="activate"${active || !enabled ? " disabled" : ""}>${active ? "使用中" : "切换"}</button>
        <label class="switch small" data-tip="${enabled ? "关闭该账号" : "启用该账号"}">
          <input type="checkbox" data-act="enabled"${enabled ? " checked" : ""}>
          <span></span>
        </label>
        <button class="icon-mini" data-act="remove" data-tip="移除账号" aria-label="移除账号">✕</button>
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
function renderRouteAgent(last, { codexOn, claudeOn, zcodeOn }) {
  // The AGENT node shows every client that is wired, so the route reads the
  // same whether one, two or all of them are in use. Each mark carries its
  // own name under its logo: Codex's star and Claude's asterisk read alike
  // at this size, so a joined name line left the marks unattributable.
  const clients = [
    { on: codexOn, mark: "#client-codex-mark", full: "Codex" },
    { on: claudeOn, mark: "#client-claude-mark", full: "Claude Desktop" },
    { on: zcodeOn, mark: "#client-zcode-mark", full: "ZCode" }
  ];
  const live = clients.filter((client) => client.on);
  for (const client of clients) {
    $(client.mark).classList.toggle("hidden", !client.on);
  }
  const none = live.length === 0;
  // Two or more marks label themselves, so the name line would only repeat
  // them; one mark shows the full name below instead of its short label.
  const nameNode = $("#client-name");
  nameNode.textContent = none ? "无智能体接入" : live.length === 1 ? live[0].full : "";
  nameNode.classList.toggle("hidden", live.length > 1);
  for (const client of live) {
    $(`${client.mark} span`)?.classList.toggle("hidden", live.length === 1);
  }
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
// The page opens on the week view: it is the span people actually compare,
// while "today" is one click away at the left of the segmented control.
let usageRange = "7d";
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

// Short forms: the recent list's source column is one narrow grid cell, and a
// long label there wraps the row to double height.
const AGENT_LABELS = { codex: "Codex", "claude-desktop": "Claude", zcode: "ZCode", openai: "OpenAI" };

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
  const text = number.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
  // The journal keeps six decimals because a flash-model request can cost a
  // ten-thousandth of one credit; rendering that as "0" reads as free.
  return text === "0" ? `<0.${"0".repeat(digits - 1)}1` : text;
}

function percent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

// The RMB value of WorkBuddy credits: 10 yuan buys 200 credits, so a credit
// is a twentieth of a yuan. Billed credits are the only input — the
// token-formula estimates proved untrustworthy and no longer show anywhere.
const CREDITS_PER_YUAN = 20;

function rmb(value) {
  const yuan = (Number(value) || 0) / CREDITS_PER_YUAN;
  if (yuan >= 100) return yuan.toFixed(0);
  if (yuan >= 1) return yuan.toFixed(2);
  return yuan.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function renderUsage() {
  if (!usage) return;
  const { totals, series, models, quota, context, projects } = usage;

  // One line of headline figures replaces the four metric cards: the totals
  // still read at a glance, and the chart below carries the detail. The
  // credits figure is what WorkBuddy charged (its own `credit` report); the
  // money line under it converts that same figure at the plan's rate.
  $("#usage-summary").innerHTML = [
    `<b>${credits(totals.credits)}</b> 积分`,
    `<b>${compact(totals.totalTokens)}</b> Token`,
    `<b>${compact(totals.inputTokens)}</b> 输入 / <b>${compact(totals.outputTokens)}</b> 输出`,
    `<b>${totals.requests}</b> 次请求`
  ].join(" · ");
  const money = $("#usage-estimate");
  money.hidden = !(totals.credits > 0);
  money.textContent = totals.credits > 0
    ? `折合 ¥${rmb(totals.credits)} · 按 10 元 = 200 积分换算`
    : "";

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
  renderUsageContext(context, projects);
  renderUsageRecent();
}

// Bars are paired per day: billed credits and tokens share the column but not
// the scale. A range where nothing ran at all says so instead of drawing a
// flat empty chart.
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
  const peak = series.reduce((best, item) => (
    (Number(item.credits) || 0) > (Number(best.credits) || 0) ? item : best
  ), series[0]);
  node.innerHTML = `
    <div class="usage-bars${showTokens ? "" : " single"}">
      ${series.map((item) => {
        const dayCredits = Number(item.credits) || 0;
        const creditHeight = creditMax ? dayCredits / creditMax * 100 : 0;
        const tokenHeight = tokenMax ? (Number(item.totalTokens) || 0) / tokenMax * 100 : 0;
        const label = new Date(`${item.date}T00:00:00`).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
        // One line per figure: the popup renders data-tip verbatim, with
        // newlines as breaks.
        const detail = [
          `${item.date}`,
          `积分 ${credits(item.credits)}`,
          ...(dayCredits > 0 ? [`折合 ¥${rmb(dayCredits)}`] : []),
          `Token ${compact(item.totalTokens)}`,
          `请求 ${item.requests} 次`
        ].join("\n");
        const empty = !(item.requests || 0);
        // An empty day keeps a 1px stub (the class supplies its colour);
        // a busy day always shows at least 1.5% so it is never invisible.
        const height = (value) => (empty ? 0.6 : Math.max(value, 1.5)).toFixed(1);
        return `<div class="usage-bar${empty ? " quiet" : ""}" data-tip="${esc(detail)}">
          <div class="usage-bar-track">
            <i class="credits" data-h="${height(creditHeight)}" style="height:0%"></i>
            ${showTokens ? `<i class="tokens" data-h="${height(tokenHeight)}" style="height:0%"></i>` : ""}
          </div>
          <span>${esc(label)}</span>
        </div>`;
      }).join("")}
    </div>
    <p class="usage-chart-note">${esc(peak.date)} 消耗最高 · 积分 ${credits(peak.credits)}（¥${rmb(peak.credits)}） · 请求 ${peak.requests} 次</p>`;
  growUsageBars(node);
}

// The bars' entrance: they start at zero and grow to their day's height,
// staggered left to right — the same easing and stagger language as the
// donut's sweep-in. Motion-averse settings get the finished chart.
function growUsageBars(node) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  node.querySelectorAll(".usage-bar-track i").forEach((bar, i) => {
    const target = bar.dataset.h;
    if (!target) return;
    bar.style.transition = "none";
    bar.getBoundingClientRect();
    bar.style.transition = `height .7s cubic-bezier(.25,.7,.3,1) ${i * 40}ms`;
    bar.style.height = `${target}%`;
  });
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

// The donut's slice colours: a ramp around the app's own greens, ordered so
// adjacent slices always contrast. The tail beyond six models folds into a
// neutral "others" grey rather than a seventh guess.
const MODEL_COLORS = ["#1f6b46", "#4d8a68", "#7fa98d", "#aecab6", "#55685e", "#8a9a90"];
const OTHERS_COLOR = "#c7cfc8";
const PIE_MAX_SLICES = 6;

// One arc per slice: a full circle whose dash shows only its share, offset
// to where the previous slice ended. A small dash gap separates slices, so
// the ring reads as segments instead of one solid band.
function modelPieSvg(slices, totals) {
  const R = 84;
  const C = 2 * Math.PI * R;
  const GAP = 2.5;
  let cum = 0;
  const segs = slices.map((slice, i) => {
    const raw = slice.share * C;
    const len = Math.max(raw - GAP, raw > GAP ? 2 : 0);
    const seg = `<circle class="seg" data-i="${i}" cx="100" cy="100" r="${R}" fill="none" stroke="${slice.color}" stroke-width="24" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-cum).toFixed(2)}"/>`;
    cum += raw;
    return seg;
  }).join("");
  const cap = totals.credits > 0 ? `¥${rmb(totals.credits)}` : "暂无积分消耗";
  return `
    <svg viewBox="0 0 200 200" role="img" aria-label="按模型的积分占比">
      <circle cx="100" cy="100" r="${R}" fill="none" stroke="var(--line-soft)" stroke-width="24" opacity=".55"/>
      <g transform="rotate(-90 100 100)">${segs}</g>
      <text class="pie-num" x="100" y="98" text-anchor="middle">${credits(totals.credits)}</text>
      <text class="pie-cap" x="100" y="116" text-anchor="middle">${esc(cap)}</text>
    </svg>`;
}

// The sweep-in: each dash grows from nothing at its own start point, and the
// stagger makes the ring assemble in share order. Motion-averse settings
// keep the finished ring.
function animateModelPie(node) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  node.querySelectorAll(".seg").forEach((seg, i) => {
    const final = seg.getAttribute("stroke-dasharray");
    seg.style.transition = "none";
    seg.setAttribute("stroke-dasharray", `0 ${final.split(" ")[1]}`);
    seg.getBoundingClientRect();
    seg.style.transition = `stroke-dasharray .7s cubic-bezier(.25,.7,.3,1) ${i * 50}ms`;
    seg.setAttribute("stroke-dasharray", final);
  });
}

function renderUsageModels(models, totals) {
  const node = $("#usage-models");
  if (!models.length) {
    node.innerHTML = '<div class="empty">所选区间内还没有请求。</div>';
    return;
  }
  // The donut shares out billed credits only — rows without a WorkBuddy
  // charge have no proportion to draw.
  const ranked = models.filter((row) => row.credits > 0).sort((a, b) => b.credits - a.credits);
  const kept = ranked.slice(0, PIE_MAX_SLICES);
  const rest = ranked.slice(PIE_MAX_SLICES);
  const totalCredits = ranked.reduce((sum, row) => sum + row.credits, 0) || 1;
  const slices = kept.map((row, i) => ({
    name: row.model, credits: row.credits, share: row.credits / totalCredits, color: MODEL_COLORS[i]
  }));
  if (rest.length) {
    const creditsSum = rest.reduce((sum, row) => sum + row.credits, 0);
    slices.push({ name: `其他 ${rest.length} 个模型`, credits: creditsSum, share: creditsSum / totalCredits, color: OTHERS_COLOR });
  }
  const colorFor = (model) => {
    const i = kept.findIndex((row) => row.model === model);
    if (i >= 0) return MODEL_COLORS[i];
    // Only a row actually folded into the "others" slice wears its grey; a
    // row with no billed credits sits in no slice at all.
    return rest.some((row) => row.model === model) ? OTHERS_COLOR : null;
  };
  node.innerHTML = `
    <div class="models-split">
      <div class="model-chart">${modelPieSvg(slices, totals)}</div>
      <div class="model-table">
        <div class="usage-table-head"><span>模型</span><span>请求</span><span>输入 / 输出</span><span>积分</span></div>
        ${models.map((row) => {
          const color = colorFor(row.model);
          return `
          <div class="usage-table-row">
            <div class="usage-model">${color ? `<i class="model-dot" style="background:${color}"></i>` : ""}<b>${esc(row.model)}</b><code>${Number.isFinite(row.rate) ? `×${row.rate}` : "—"}</code></div>
            <span>${row.requests}</span>
            <span class="usage-io">${compact(row.inputTokens)} <i>/</i> ${compact(row.outputTokens)}</span>
            <span class="usage-cost">${credits(row.credits)}${row.credits > 0 ? ` <i class="soft-label">¥${rmb(row.credits)}</i>` : ""}</span>
          </div>`;
        }).join("")}
        <div class="usage-table-foot">
          <span>合计</span><span>${totals.requests}</span>
          <span>${compact(totals.inputTokens)} / ${compact(totals.outputTokens)}</span>
          <span>${credits(totals.credits)}${totals.credits > 0 ? `（¥${rmb(totals.credits)}）` : ""}</span>
        </div>
      </div>
    </div>`;
  animateModelPie(node);
  // Hovering a slice dims the rest and swaps the centre to that model's own
  // figures; leaving the chart restores the totals.
  const chart = node.querySelector(".model-chart");
  const num = chart.querySelector(".pie-num");
  const cap = chart.querySelector(".pie-cap");
  const setCenter = (value, label) => { num.textContent = value; cap.textContent = label; };
  chart.addEventListener("mouseover", (event) => {
    const seg = event.target.closest(".seg");
    if (!seg) return;
    chart.classList.add("hovering");
    for (const item of chart.querySelectorAll(".seg")) item.classList.toggle("on", item === seg);
    const slice = slices[+seg.dataset.i];
    const name = slice.name.length > 14 ? `${slice.name.slice(0, 13)}…` : slice.name;
    setCenter(credits(slice.credits), `${name} · ${percent(slice.share)}`);
  });
  chart.addEventListener("mouseout", (event) => {
    if (!event.target.closest(".seg")) return;
    chart.classList.remove("hovering");
    setCenter(credits(totals.credits), totals.credits > 0 ? `¥${rmb(totals.credits)}` : "暂无积分消耗");
  });
}

// The context card answers two questions the totals cannot, per project —
// one long-running repository and a one-shot question are not comparable, so
// the newest request's window fill and the range's cache hit are computed for
// each working directory separately, newest first. The two single meters at
// the top show the busiest project; the rows below carry the rest.
function renderUsageContext(context, projects = []) {
  const capacity = $("#usage-context-capacity");
  const meter = $("#usage-context-meter");
  const cache = $("#usage-context-cache");
  const cacheMeter = $("#usage-cache-meter");
  const model = $("#usage-context-model");
  const note = $("#usage-context-note");

  const attributed = projects.filter((row) => row.context);
  const featured = attributed[0];
  if (!featured) {
    capacity.textContent = "—";
    meter.style.width = "0";
    cache.textContent = "—";
    cacheMeter.style.width = "0";
    model.textContent = "";
    note.textContent = "所选区间内还没有记录到上下文窗口的请求。";
    return;
  }
  const fill = featured.context;
  capacity.textContent = `${compact(fill.used)} / ${compact(fill.window)}（${percent(fill.fill)}）`;
  meter.style.width = `${gaugeWidth(fill.fill)}%`;
  cache.textContent = featured.cacheHit == null ? "—" : percent(featured.cacheHit);
  cacheMeter.style.width = `${gaugeWidth(featured.cacheHit || 0)}%`;
  model.textContent = fill.model || "";
  note.textContent = `「${featured.name || "未归属"}」最近一次请求的输入占模型上下文窗口。`;

  // One row per project with requests in the range: capacity from its own
  // newest request, cache hit over its own traffic. Unattributed requests
  // (a client that names no working directory) show as such.
  const list = $("#usage-context-projects");
  if (!list) return;
  const rows = projects.filter((row) => row.requests > 0);
  if (rows.length <= 1) {
    list.innerHTML = "";
    list.hidden = true;
    return;
  }
  list.hidden = false;
  list.innerHTML = rows.map((row) => {
    const ctx = row.context;
    const fillText = ctx
      ? `${compact(ctx.used)} / ${compact(ctx.window)} · ${percent(ctx.fill)}`
      : "—";
    const hit = row.cacheHit == null ? "—" : percent(row.cacheHit);
    // The ✕ deletes this project's whole record from the journal; the count
    // rides along so the confirm dialog states what will go.
    return `<div class="usage-table-row">
      <div class="usage-model"><b>${esc(row.name || "未归属")}</b><code>${esc(row.id ? "" : "无目录信息")}</code></div>
      <span>${row.requests}</span>
      <span class="usage-io">${fillText}</span>
      <span class="usage-cost">${hit}</span>
      <button class="icon-mini" data-project="${esc(row.id)}" data-name="${esc(row.name || "未归属")}" data-count="${row.requests || 0}" data-tip="删除该项目的全部记录" aria-label="删除项目 ${esc(row.name || "未归属")} 的记录">✕</button>
    </div>`;
  }).join("");
}

// A near-empty gauge is invisible at its true width, so a non-zero share
// keeps the chart bars' floor; zero stays zero, or "no cache used" would
// read as a full bar.
function gaugeWidth(share) {
  const value = Number(share || 0) * 100;
  if (value <= 0) return 0;
  return Math.min(Math.max(value, 1.5), 100).toFixed(1);
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
    syncRecentSelection();
    return;
  }
  // The head repeats the cells' own classes, so the narrow-width rule that
  // hides a column hides its label with it. The first cell is the select
  // box: tick rows to delete them, or the head box for all of them.
  const selectable = rows.filter((item) => item.status !== "running");
  const head = `<div class="recent-row recent-head">
    <input type="checkbox" class="recent-pick" id="recent-pick-all" aria-label="全选"${selectable.length ? "" : " disabled"}>
    <span>时间</span><span>来源</span><span>模型</span><span>状态</span>
    <span>上下文</span><span>缓存</span>
    <span class="recent-tokens">Token</span><span class="recent-cost">积分</span>
  </div>`;
  node.innerHTML = head + rows.map((item) => {
    const when = new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    // Rows written before the journal kept cachedTokens have no figure to
    // show: a missing value is unknown, not a zero percent.
    const cacheKnown = item.cachedTokens != null;
    const cache = cacheKnown && item.inputTokens ? item.cachedTokens / item.inputTokens : 0;
    const state = item.status === "running" ? "进行中" : item.status === "error" ? "失败" : "完成";
    // A billed credit is WorkBuddy's own number and the only one shown; a
    // row it did not cost stays uncosted — the token-formula estimate proved
    // untrustworthy and no longer displays.
    const cost = item.creditsSource === "upstream" ? credits(item.credits ?? 0) : "—";
    // A live request cannot be deleted; its box says so by being disabled.
    const running = item.status === "running";
    return `<div class="recent-row" data-id="${esc(item.id)}">
      <input type="checkbox" class="recent-pick" data-pick="${esc(item.id)}"${running ? " disabled" : ""} aria-label="选择这条记录">
      <span class="recent-time">${esc(when)}</span>
      <span class="agent-pill">${esc(agentLabel(item.agent))}</span>
      <span class="recent-model">${esc(item.model)}</span>
      <span class="recent-state ${item.status === "error" ? "err" : item.status === "running" ? "live" : "ok"}">${state}</span>
      <span class="recent-ctx">${item.contextWindow ? compact(item.contextWindow) : "—"}</span>
      <span class="recent-cache">${cacheKnown && item.inputTokens ? percent(cache) : "—"}</span>
      <span class="recent-tokens">${compact(item.totalTokens)}</span>
      <span class="recent-cost">${cost}</span>
    </div>`;
  }).join("");
}

// The picked rows drive both actions: 清除选中 appears with the count, and
// the head box mirrors the tick state of every selectable row.
function syncRecentSelection() {
  const picks = [...document.querySelectorAll("#usage-recent [data-pick]")];
  const on = picks.filter((box) => box.checked);
  const action = $("#clear-selected");
  action.hidden = on.length === 0;
  action.textContent = on.length ? `清除选中（${on.length}）` : "清除选中";
  const all = $("#recent-pick-all");
  if (all) {
    const selectable = picks.filter((box) => !box.disabled);
    all.checked = selectable.length > 0 && selectable.every((box) => box.checked);
    all.indeterminate = !all.checked && on.length > 0;
  }
}

function pickedIds() {
  return [...document.querySelectorAll("#usage-recent [data-pick]")]
    .filter((box) => box.checked)
    .map((box) => box.dataset.pick);
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

async function signIn(site = "workbuddy") {
  try {
    const result = await window.lane.signIn({ site });
    if (result.url) await window.lane.openURL(result.url);
    toast(`已打开 ${site === "workbuddy-ai" ? "WorkBuddy AI" : "WorkBuddy"} 登录页，完成后会自动更新状态`);
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
$("#clear-history").addEventListener("click", async () => {
  const count = snapshot?.clearableHistory || 0;
  if (!count) {
    // The button stays for good, so a click with nothing to clear explains
    // itself instead of reporting a bare zero.
    toast("今天凌晨之前没有记录，无需清除");
    return;
  }
  if (!confirm(`清除今天凌晨之前的全部 ${count} 条请求记录？此操作不可恢复。`)) return;
  const button = $("#clear-history");
  button.disabled = true;
  try {
    const result = await window.lane.clearHistory();
    toast(`已清除 ${result?.removed ?? 0} 条历史记录`);
  } catch (error) {
    toast(error.message || "清除失败", true);
  } finally {
    button.disabled = false;
  }
  await refresh();
  await loadUsage();
});
$("#usage-recent").addEventListener("change", (event) => {
  const box = event.target.closest(".recent-pick");
  if (!box) return;
  // The head box toggles every selectable row.
  if (box.id === "recent-pick-all") {
    const on = box.checked;
    for (const pick of document.querySelectorAll("#usage-recent [data-pick]")) {
      if (!pick.disabled) pick.checked = on;
    }
  }
  syncRecentSelection();
});
$("#clear-selected").addEventListener("click", async () => {
  const ids = pickedIds();
  if (!ids.length) return;
  if (!confirm(`删除选中的 ${ids.length} 条记录？此操作不可恢复。`)) return;
  const button = $("#clear-selected");
  button.disabled = true;
  try {
    const result = await window.lane.clearHistory(ids);
    if ((result?.removed ?? 0) > 0) toast(`已删除 ${result.removed} 条记录`);
    else toast("没有删除记录：所选内容可能已被清除", true);
  } catch (error) {
    toast(error.message || "删除失败", true);
  } finally {
    button.disabled = false;
  }
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
$("#zcode-connect").addEventListener("click", () => command("connect", { agent: "zcode" }, "ZCode 已接入，请重启客户端"));
$("#zcode-disconnect").addEventListener("click", () => command("disconnect", { agent: "zcode" }, "ZCode 已断开"));
$("#quick-signin").addEventListener("click", () => signIn());
// Two builds, two sign-in pages: the menu picks which one this account joins.
$("#add-account").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#add-menu");
  menu.hidden = !menu.hidden;
});
$("#add-menu").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-site]");
  if (!button) return;
  $("#add-menu").hidden = true;
  signIn(button.dataset.site);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".add-account")) $("#add-menu").hidden = true;
});
$("#refresh-accounts").addEventListener("click", () => refresh());
$("#account-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button || button.disabled) return;
  const row = button.closest("[data-id]");
  const id = row?.dataset.id;
  if (!id) return;
  if (button.dataset.act === "activate") return accountAction("activate", id);
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
  if (!id) return;
  enabledPending.set(id, input.checked);
  accountAction("enabled", id, { enabled: input.checked }).finally(() => {
    // The command is over: the next snapshot (this action's own refresh, or
    // the poll behind it) is the truth.
    enabledPending.delete(id);
  });
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
    const skipped = results.filter((item) => item.status === "skipped" && item.reason);
    // A check-in the switch blocked says so, instead of counting zero.
    if (!done && !failed && skipped.length) {
      toast(skipped.map((item) => item.reason).join("；"), true);
    } else if (failed) {
      toast(`签到完成 ${done} 个，失败 ${failed} 个`, true);
    } else {
      toast(`签到完成 ${done} 个`);
    }
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
  } catch (error) {
    toast(`测试失败：${error?.message || error}`, true);
  } finally {
    button.disabled = false;
    button.textContent = "测试链路";
  }
});
$("#autostart").addEventListener("change", async (event) => {
  autostartPending = true;
  try {
    await command("autostart", { enabled: event.target.checked },
      event.target.checked ? "已开启登录启动" : "已关闭登录启动");
  } finally {
    autostartPending = false;
  }
});
$("#open-data").addEventListener("click", () => window.lane.open("data"));
$("#open-log").addEventListener("click", () => window.lane.open("log"));

// The gateway port only takes effect on a restart: the listen call happens
// once, at start. The note spells that out, so a saved port that seems to
// do nothing does not read as a bug.
function gatewayNote(text, error = false) {
  const node = $("#gateway-port-note");
  node.hidden = !text;
  node.textContent = text || "";
  node.classList.toggle("error", error);
}
$("#gateway-port-save").addEventListener("click", async () => {
  const port = Number($("#gateway-port").value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    gatewayNote("端口需为 1024–65535 之间的整数", true);
    return;
  }
  const button = $("#gateway-port-save");
  button.disabled = true;
  try {
    const result = await window.lane.saveGatewaySettings({ port });
    if (!result.changed) {
      gatewayNote(`当前就是端口 ${port}，无需保存`);
      return;
    }
    const agents = result.rewritten?.length
      ? `已同步更新接入配置：${result.rewritten.join("、")}`
      : "当前没有已接入的 Agent，无需改写";
    gatewayNote(`已保存。重启 Lane 后生效，新地址 127.0.0.1:${result.port}。${agents}。`);
    toast(`网关端口已保存为 ${result.port}`, false);
  } catch (error) {
    gatewayNote(error.message || "保存失败", true);
  } finally {
    button.disabled = false;
  }
});
$("#refresh-route").addEventListener("click", () => refresh());
$("#quit-app").addEventListener("click", async () => {
  if (!confirm("退出 Lane 会同时停止本地网关，确定吗？")) return;
  await window.lane.quit();
});

window.lane.onSignIn(async ({ error } = {}) => {
  // The event only ever arrives when a sign-in finished: it failed if it
  // carries an error, otherwise the account landed and the window refreshes.
  if (error) toast(`WorkBuddy 登录失败：${error}`, true);
  else toast("WorkBuddy 登录成功");
  await refresh({ quiet: true });
});

refresh();
setInterval(() => {
  // The usage page already has its own numbers and a range control; polling
  // status behind it would only redraw the request list under the user.
  if (activeView === "activity") return;
  refresh({ quiet: true });
}, 3000);
