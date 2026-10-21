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
    .replaceAll('"', "&quot;");
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
  const card = $("#credit-card");
  const credits = creditView(usage);
  if (!credits) {
    card.hidden = true;
    $("#account-credits").textContent = usage?.error ? "积分不可用" : "积分 —";
    return;
  }
  card.hidden = false;
  $("#credit-plan").textContent = credits.plan || "WorkBuddy";
  $("#credit-used").textContent = creditNumber(credits.used);
  $("#credit-limit").textContent = `/ ${creditNumber(credits.limit)} 积分`;
  const fill = $("#credit-fill");
  fill.style.width = `${credits.percent}%`;
  fill.classList.toggle("warn", credits.percent >= 75 && credits.percent < 90);
  fill.classList.toggle("crit", credits.percent >= 90);
  $("#credit-left").textContent = `剩余 ${creditNumber(credits.left)} 积分`;
  const runsOut = $("#credit-runsout");
  if (credits.runsOutAt) {
    const at = new Date(credits.runsOutAt);
    const when = Number.isNaN(at.getTime())
      ? credits.runsOutAt
      : at.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    runsOut.textContent = credits.runsOut
      ? `${when} 用完 ${creditNumber(credits.runsOut)}`
      : `${when} 到期`;
  } else {
    runsOut.textContent = "";
  }
  $("#account-credits").textContent = `积分 ${creditNumber(credits.used)} / ${creditNumber(credits.limit)}`;
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
  $$(".nav").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  $$(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
}

async function refresh({ quiet = false } = {}) {
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
  // The route's model tag only shows while a request is actually running.
  $("#route-model-label").textContent = running.length ? `· ${running[0].model}` : "";
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
  $("#settings-account").textContent = account || "未登录";
  $("#settings-domain").textContent = signedIn
    ? (snapshot.domain || "WorkBuddy 已连接")
    : "登录 WorkBuddy 后即可发请求";
  renderCredits(signedIn ? snapshot.usage : null);
  $("#data-path").textContent = snapshot.dataDir || "%LOCALAPPDATA%\\lane";
  $("#log-name").textContent = snapshot.ownsGateway === false ? "lane.log" : "desktop.log";
  $("#autostart").checked = Boolean(snapshot.autostart);

  renderRoute();
  renderModels(models || []);
  renderActivity();
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

// The request card and summary line are gone; activity history tells the rest.
function renderRoute() {}

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

function renderActivity() {
  if (!snapshot) return;
  const rows = snapshot.recent || [];
  if (!rows.length) {
    $("#activity-list").innerHTML = '<div class="empty">还没有请求。先用 Codex 发起一轮对话。</div>';
    return;
  }
  $("#activity-list").innerHTML = rows.map((item) => `
    <div class="activity-row">
      <span class="muted">${new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false })}</span>
      <span class="agent-pill">${esc(item.agent)}</span>
      <span>${esc(item.model)}</span>
      <span class="${item.status === "error" ? "status-err" : "status-ok"}">${item.status === "running" ? "进行中" : item.status === "error" ? "失败" : "完成"}</span>
      <span>${duration(item.durationMs)}</span>
      <span>${compact(item.totalTokens)}</span>
    </div>`).join("");
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
$$("[data-go]").forEach((button) => button.addEventListener("click", () => go(button.dataset.go)));
$("#refresh-agents").addEventListener("click", () => refresh());
$("#refresh-models").addEventListener("click", () => refresh());
$("#refresh-activity").addEventListener("click", () => refresh());
$("#codex-connect").addEventListener("click", () => command("connect", { agent: "codex" }, "Codex 已接入，请新建会话"));
$("#codex-disconnect").addEventListener("click", () => command("disconnect", { agent: "codex" }, "Codex 已断开"));
$("#claude-connect").addEventListener("click", () => command("connect", { agent: "claude-desktop" }, "Claude Desktop 已接入，请重启客户端"));
$("#claude-disconnect").addEventListener("click", () => command("disconnect", { agent: "claude-desktop" }, "Claude Desktop 已断开"));
$("#quick-signin").addEventListener("click", signIn);
$("#settings-signin").addEventListener("click", signIn);
$("#signout").addEventListener("click", async () => {
  if (!confirm("确定退出当前 WorkBuddy 账号？")) return;
  try {
    await window.lane.signOut();
    toast("已退出 WorkBuddy");
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message, true);
  }
});
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
setInterval(() => refresh({ quiet: true }), 3000);
