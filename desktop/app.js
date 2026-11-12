import { esc, credits, rmb, percent, requestState, rateBadge, modelStatus, parseMcpJson, creditView, creditWindowOf, creditBreakdown, tokenWindowsOf } from "./format.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let snapshot = null;
let activeView = "routing";
let refreshing = false;
let lastAnomalyToasted = null;
let refreshQueued = null;
// Toggles still waiting on their command, so a status poll that lands first
// cannot render the old state over the user's click.
let autostartPending = false;
// The "contributes models" switch: a poll that lands between the click and
// its reply must not put the old state back.
const routablePending = new Map();
// Theme: theme.js applied the saved choice before the stylesheet loaded; this
// keeps the settings control in sync and lets the page switch live. "system"
// follows the OS preference without asking the main process each time.
const THEME_MODES = ["light", "dark", "system"];
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
function readThemeMode() {
  try {
    const saved = localStorage.getItem("lane.themeMode");
    return THEME_MODES.includes(saved) ? saved : "system";
  } catch {
    return "system";
  }
}
let themeMode = readThemeMode();
function resolvedTheme() {
  return themeMode === "system" ? (systemTheme.matches ? "dark" : "light") : themeMode;
}
function applyTheme({ notify = true } = {}) {
  document.documentElement.dataset.theme = resolvedTheme();
  document.documentElement.dataset.themeMode = themeMode;
  for (const button of $$("#theme-seg button")) {
    const active = button.dataset.themeMode === themeMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (notify) window.lane?.setTheme?.(themeMode)?.catch?.(() => {});
}
applyTheme();
// Account masking: a display preference, not account state, so it lives in
// the renderer and survives restarts without touching the gateway's files.
// Default off; the list shows real names until the user asks otherwise.
let accountMasked = false;
try { accountMasked = localStorage.getItem("lane.accountMasked") === "1"; } catch {}

// Masks a label for the account list. One ASCII/Chinese character at each
// end stays legible so the user can still tell two accounts apart, while the
// middle is replaced; very short names lose everything but the first char.
function maskName(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length === 1) return "*";
  if (text.length === 2) return `${text[0]}*`;
  return `${text[0]}${"*".repeat(Math.min(3, text.length - 2))}${text[text.length - 1]}`;
}

// The row shows only the first 8 characters of the account hash; masking
// keeps two of them so the row is still distinguishable in a screenshot.
function maskId(value) {
  const text = String(value ?? "");
  return text.length <= 2 ? "*".repeat(text.length || 1) : `${text.slice(0, 2)}${"*".repeat(4)}`;
}



function compact(number) {
  const value = Number(number || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
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
// `creditView` in format.js picks the window and reads it.
//
// `usage` here is the account the node is describing: each account carries
// its own figures in the status snapshot, so switching the chip switches the
// number rather than leaving the route account's balance under another
// account's name.
function renderCredits(usage) {
  const credits = creditView(usage);
  // The meter reports what the cycle has spent; the card answers the question
  // the account page does — how much is left — so it shows the remainder.
  // A prepaid balance has no cycle total: it is all left, and saying "42.5 /
  // 42.5" would claim a ceiling the account never had. Trae Global reports its
  // entitlement in dollars, so the label says that rather than "积分".
  const money = credits?.unit === "usd";
  const prefix = money ? "$" : "";
  const label = money ? "剩余额度" : "剩余积分";
  $("#account-credits").textContent = credits
    ? credits.prepaid
      ? `${label} ${prefix}${creditNumber(credits.left)}`
      : `${label} ${prefix}${creditNumber(credits.left)} / ${prefix}${creditNumber(credits.limit)}`
    : usage?.error
      ? usage.signIn === "expired" ? "需重新登录" : "积分不可用"
      : "积分 —";
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
  if (view === "extensions") loadExtensions();
  if (view === "plugins") loadPlugins();
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

// The outbound guard's mode menu. It mirrors DeepSeek Harness's menu: a quiet
// trigger plus a padded popover, because a native <select> cannot be styled
// into that shape. The selected value lives on the wrapper's data-value so a
// status poll can repaint it without losing an open menu.
const EGRESS_LABELS = { monitor: "只记录", enforce: "拦截第三方", off: "关闭" };

function setEgressSelection(root, value) {
  if (!root) return;
  const mode = EGRESS_LABELS[value] ? value : "monitor";
  root.dataset.value = mode;
  const label = $("#egress-label");
  if (label) label.textContent = EGRESS_LABELS[mode];
  for (const item of $$("#egress-menu [data-value]")) {
    item.setAttribute("aria-checked", String(item.dataset.value === mode));
  }
}

function closeEgressMenu() {
  const menu = $("#egress-menu");
  const trigger = $("#egress-trigger");
  if (menu) menu.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
}

function openEgressMenu() {
  const menu = $("#egress-menu");
  const trigger = $("#egress-trigger");
  if (!menu || !trigger) return;
  // The settings sheet is tall and the guard row sits near its bottom: a menu
  // that always opens downward is clipped by the window. Measure first, then
  // flip above the trigger when there is no room below.
  menu.hidden = false;
  menu.classList.remove("above");
  const rect = trigger.getBoundingClientRect();
  const room = window.innerHeight - rect.bottom;
  if (room < menu.offsetHeight + 12) menu.classList.add("above");
  trigger.setAttribute("aria-expanded", "true");
  menu.querySelector('[aria-checked="true"]')?.focus?.();
}

$("#egress-trigger")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#egress-menu");
  if (!menu) return;
  if (menu.hidden) openEgressMenu();
  else closeEgressMenu();
});

$("#egress-menu")?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-value]");
  if (!item) return;
  const root = $("#egress-select");
  setEgressSelection(root, item.dataset.value);
  closeEgressMenu();
  saveRedact({ egressMode: item.dataset.value });
});

// A menu that stays open while the page scrolls or another control is clicked
// reads as stuck; one document-level listener closes it.
document.addEventListener("click", (event) => {
  const menu = $("#egress-menu");
  if (!menu || menu.hidden) return;
  if (event.target.closest("#egress-select")) return;
  closeEgressMenu();
});

document.addEventListener("keydown", (event) => {
  const menu = $("#egress-menu");
  if (!menu || menu.hidden) return;
  if (event.key === "Escape") {
    closeEgressMenu();
    $("#egress-trigger")?.focus?.();
  }
});

// The hosts the vendored plugins actually reached. This is the list a user
// reads before switching the guard to "enforce": an entry marked 第三方 is a
// host no upstream needs, and the one worth investigating.
function renderEgress() {
  const node = $("#egress-list");
  if (!node) return;
  const report = snapshot?.egress || { mode: "off", hosts: [] };
  const hosts = Array.isArray(report.hosts) ? report.hosts : [];
  if (!hosts.length) {
    node.innerHTML = '<span class="soft-label">暂无记录</span>';
    return;
  }
  const parts = hosts.map((item) => {
    const verdict = item.verdict === "allowed"
      ? "上游"
      : item.verdict === "family" ? "厂商域名" : "第三方";
    const tone = item.verdict === "third-party" ? " third-party" : "";
    const when = item.at
      ? new Date(item.at).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    // A host that was only ever reached by an unexpected path, or with a body
    // too big for its endpoint, is what a leak would look like: say so on the
    // row instead of burying it in a detail list.
    const flagged = Array.isArray(item.suspicious) ? item.suspicious : [];
    const reasons = flagged.slice(0, 2).map((entry) => REASON_LABELS[entry.reason?.split(":")[0]] || entry.reason).join("、");
    const paths = Array.isArray(item.paths) ? item.paths : [];
    const pathNote = paths.length ? ` · ${paths.length} 个路径` : "";
    return `<div class="egress-row${tone}"><code>${esc(item.host)}</code><small>${esc(verdict)}${esc(pathNote)}${when ? ` · ${esc(when)}` : ""}${item.blocked ? " · 已拦截" : ""}${reasons ? ` · <b>${esc(reasons)}</b>` : ""}</small></div>`;
  }).join("");
  const total = Number(report.suspicious) || 0;
  const head = total > 0
    ? `<div class="egress-alert">${total} 项异常记录，展开下方域名查看路径</div>`
    : "";
  node.innerHTML = head + parts;
}

// Short Chinese labels for the audit reasons. The full reason carries detail
// after a colon (the offending field names); the label is what fits a row.
const REASON_LABELS = {
  "unknown-path": "未知路径",
  "large-body-outside-chat": "非聊天请求携带大请求体",
  "unexpected-chat-fields": "聊天请求含未知字段"
};

// Which account the PROVIDER node is describing. The node used to name the
// route account, which is the one left over from the single-account design
// and never changes on its own: with several accounts serving models the
// card sat on a stale name. It now follows the pool, defaulting to the first
// account switched in, and a click picks another.
let providerViewId = "";

function providerViewAccount() {
  const serving = (snapshot?.accounts || []).filter((item) => item.routable === true);
  if (!serving.length) return null;
  const picked = serving.find((item) => item.id === providerViewId);
  return picked || serving[0];
}

function renderAccountIdentity() {
  // The route/health cards name the account too; masking is a whole-page
  // display preference, not just an account-list one.
  const account = snapshot?.account || "";
  const shown = accountMasked ? maskName(account) : account;
  $("#health-account").textContent = shown || "未登录";

  const serving = (snapshot?.accounts || []).filter((item) => item.routable === true);
  const view = providerViewAccount();
  const nameOf = (item) => (accountMasked ? maskName(item.label) : item.label);
  const upstreamOf = (item) => upstreamLabel(item);

  // The node's own headline follows the account being shown, not the route.
  $("#account-name").textContent = view ? nameOf(view) : (shown || "上游账号");

  // Every account that serves models, not just the route one: with several
  // upstreams live at once, the provider node has to show which ones — and
  // which of them the card is describing.
  const pool = $("#provider-pool");
  if (!pool) return;
  pool.hidden = serving.length === 0;
  pool.innerHTML = serving.map((item) => {
    const on = Boolean(view) && item.id === view.id;
    const name = nameOf(item);
    const upstream = upstreamOf(item);
    const tip = on
      ? `${name} · ${upstream}（正在查看）`
      : `${name} · ${upstream}，点击查看这个账号的额度`;
    return `<button type="button" class="pool-chip${on ? " on" : ""}" data-provider-account="${esc(item.id)}" data-tip="${esc(tip)}">
      <img src="${upstreamIcon(item)}" alt="">
      <b>${esc(name)}</b>
      <small>${esc(upstream)}</small>
    </button>`;
  }).join("");
}

function render() {
  if (!snapshot) return;
  bootOut();
  // The re-render replaces the elements any visible popup is attached to;
  // a tip frozen over detached content reads as a bug, so it goes first.
  tipNode.hidden = true;
  const { signedIn, agents, models, recent = [] } = snapshot;
  // One callout per anomalous row: the cost is the vendor's own number, and
  // the user should see it the moment it lands, not on the next visit to the
  // usage page. The wording says what was actually detected - a charge well
  // above comparable requests - because "expensive" alone is not a fault and
  // a big prompt at full price is a normal bill. The id guard keeps a poll
  // from repeating it.
  var anomalyHead = recent.find(function (r) { return r.anomaly; });
  if (anomalyHead && anomalyHead.id !== lastAnomalyToasted && anomalyHead.credits != null) {
    lastAnomalyToasted = anomalyHead.id;
    toast("计费异常：" + (anomalyHead.model || "") + " 单次扣 " + anomalyHead.credits + " 积分，远高于同尺寸请求");
  }
  const running = recent.filter((item) => item.status === "running");
  const last = recent[0];
  const codexOn = agents?.codex?.connected;
  const claudeOn = agents?.claudeDesktop?.connected;
  const zcodeOn = agents?.zcode?.connected;
  const vscodeOn = agents?.vscode?.connected;
  const dshOn = agents?.dsh?.connected;

  $("#route-live-dot").className = "dot ok";
  $("#route-live").textContent = running.length ? "处理中" : "实时";
  $("#route-count").textContent = `${recent.length} 个请求`;
  // The rail only animates while a request is on the wire, so the motion
  // always means something is happening rather than looping for decoration.
  $(".route-canvas").classList.toggle("busy", running.length > 0);
  renderRouteAgent(last, { codexOn, claudeOn, zcodeOn, vscodeOn, dshOn });
  // "starting" is what the main process answers while the gateway is coming
  // up or retrying after a failed start; a fixed "运行中" would mask that.
  $("#lane-state").textContent = snapshot.starting ? "启动中…" : "运行中";
  // The state belongs to the account the node is describing, not to the
  // gateway as a whole: a card naming one account while reporting another's
  // login would say "已登录" for an account that is not.
  const viewAccount = providerViewAccount();
  const viewSignedIn = viewAccount ? true : signedIn;
  $("#provider-state").textContent = viewSignedIn ? "已登录" : "未登录";
  $("#provider-state").previousElementSibling.classList.toggle("off", !viewSignedIn);
  // The route node names the account being shown — the first one switched
  // into the pool unless another is picked — and its icon follows that
  // upstream, so a Trae account is not drawn with WorkBuddy's mark.
  const carrier = (snapshot.accounts || []).find((item) => item.id === snapshot.activeId);
  const view = providerViewAccount();
  const upstreamName = upstreamLabel(view || carrier);
  const shownMark = view || carrier;
  $("#provider-logo").src = upstreamIcon(shownMark);
  // Qoder ships a rounded-square tile; clipping it into the circular slot
  // the other upstreams use would cut its corners off, so the node swaps to
  // the same rounded-square box for that provider.
  $("#provider-logo").parentElement?.classList.toggle("tile", shownMark?.provider === "qoder");
  $("#account-plan").textContent = view?.domain || snapshot.domain || upstreamName;
  renderAccountIdentity();
  $("#health-domain").textContent = snapshot.domain || upstreamName;
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
  $("#vscode-connect-state").textContent = vscodeOn ? "已接入" : "未接入";
  $("#vscode-connect-state").classList.toggle("on", vscodeOn);
  $("#vscode-connect").textContent = vscodeOn ? "重新接入 VS Code" : "接入 VS Code";
  $("#dsh-connect-state").textContent = dshOn ? "已接入" : "未接入";
  $("#dsh-connect-state").classList.toggle("on", dshOn);
  $("#dsh-connect").textContent = dshOn ? "重新接入 DSH" : "接入 DSH";
  // The settings page owns the port field now; keep it from being cleared
  // while the user is typing, and only fill it once.
  const portField = $("#gateway-port");
  if (portField && document.activeElement !== portField && !portField.value) {
    portField.value = snapshot.gateway ? String(new URL(snapshot.gateway).port) : "";
  }
  // The privacy switch is a setting, not a per-account state: read it once,
  // and never while the user is flipping it.
  const hideDshBox = $("#hide-dsh");
  if (hideDshBox && !hideDshPending) {
    if (!hideDshLoaded) {
      hideDshLoaded = true;
      window.lane.gatewaySettings()
        .then((settings) => { if (!hideDshPending) hideDshBox.checked = settings.hideDsh !== false; })
        .catch(() => { hideDshLoaded = false; });
    }
  }
  // The redaction switches share one settings read: they are two halves of
  // the same privacy surface.
  const redactSecretsBox = $("#redact-secrets");
  const redactPersonalBox = $("#redact-personal");
  const redactRuleBoxes = $$("#redact-details [data-redact-rule]");
  if ((redactSecretsBox || redactPersonalBox) && !redactPending) {
    if (!redactLoaded) {
      redactLoaded = true;
      window.lane.gatewaySettings()
        .then((settings) => {
          if (redactPending) return;
          if (redactSecretsBox) redactSecretsBox.checked = settings.redactSecrets !== false;
          if (redactPersonalBox) redactPersonalBox.checked = settings.redactPersonal !== false;
          for (const box of redactRuleBoxes) {
            box.checked = settings.redactRules?.[box.dataset.redactRule] !== false;
          }
          const allowlist = $("#redact-allowlist");
          if (allowlist && document.activeElement !== allowlist) {
            allowlist.value = (settings.redactAllowlist || []).join("\n");
          }
          const custom = $("#redact-custom");
          if (custom && document.activeElement !== custom) {
            custom.value = (settings.redactCustom || []).join("\n");
          }
          const egressSelect = $("#egress-select");
          if (egressSelect && document.activeElement !== $("#egress-trigger")) {
            setEgressSelection(egressSelect, settings.egressMode || "monitor");
          }
        })
        .catch(() => { redactLoaded = false; });
    }
  }
  renderEgress();
  // Every address shown in the UI derives from the snapshot, so a saved
  // port change is reflected everywhere once the gateway restarts on it.
  // (The sidebar shows none of them: that corner is blank by design.)
  const address = (snapshot.gateway || "http://127.0.0.1:3426").replace(/^https?:\/\//, "");
  $("#lane-address").textContent = address;
  $("#health-address").textContent = address;
  $("#codex-address").textContent = `${address}/v1`;
  $("#claude-address").textContent = address;
  $("#zcode-address").textContent = address;
  $("#vscode-address").textContent = `${address}/v1`;
  $("#dsh-address").textContent = address;
  // The cards name the config file Lane actually writes, read from the status
  // snapshot. A hard-coded path was wrong as soon as CODEX_HOME / ZCODE_HOME
  // / DSH_HOME pointed somewhere else, and a hard-coded model name went
  // stale the moment the account's catalogue changed.
  const setAgentPath = (id, value) => {
    const node = $(`#${id}`);
    if (!node) return;
    node.textContent = value || "未检测到配置文件";
    node.title = value || "";
  };
  setAgentPath("codex-path", agents?.codex?.configPath);
  setAgentPath("claude-path", agents?.claudeDesktop?.modeConfig);
  setAgentPath("zcode-path", agents?.zcode?.configPath);
  setAgentPath("vscode-path", agents?.vscode?.configPath);
  setAgentPath("dsh-path", agents?.dsh?.configPath);
  // The account the node describes, not the route: each account's own
  // figures ride in the snapshot, so the card shows the balance that belongs
  // to the name above it.
  const shownAccount = providerViewAccount();
  renderCredits(shownAccount ? (shownAccount.credits || null) : (signedIn ? snapshot.usage : null));
  $("#data-path").textContent = snapshot.dataDir || "%LOCALAPPDATA%\\lane";
  $("#log-name").textContent = snapshot.ownsGateway === false ? "lane.log" : "desktop.log";
  $("#app-version").textContent = snapshot.version ? `v${snapshot.version}` : "—";
  // A toggle that is still running its command keeps its own state: the
  // autostart call spawns PowerShell with a 30s timeout, and a poll tick
  // that lands first would visibly snap the switch back and invite a second
  // flip.
  if (!autostartPending) $("#autostart").checked = Boolean(snapshot.autostart);

  renderModels(snapshot.catalogue || models || [], snapshot.freeAllowance || null, snapshot.modelGate || null);
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
  $("#account-count").textContent = accounts.length ? `${accounts.length} 个` : "";
  // A sign-in that failed leaves a line here: the toast is gone after three
  // seconds, and a missing account otherwise looks like nothing happened.
  const failed = snapshot.signInError || "";
  const errorNode = $("#accounts-error");
  errorNode.hidden = !failed;
  errorNode.textContent = failed ? `上次登录未完成：${failed}` : "";
  const list = $("#account-list");
  const foot = $("#accounts-foot");
  // The toggle reflects the stored preference even when the list is empty.
  const maskButton = $("#account-mask");
  if (maskButton) {
    maskButton.textContent = accountMasked ? "显示" : "打码";
    maskButton.setAttribute("aria-pressed", String(accountMasked));
    maskButton.classList.toggle("on", accountMasked);
  }
  if (!accounts.length) {
    list.innerHTML = '<div class="empty">还没有账号。点「添加账号」登录上游。</div>';
    foot.textContent = "";
    return;
  }
  const shownName = (account) => (accountMasked ? maskName(account.label) : account.label);
  // No single account carries requests any more: a request goes to whichever
  // account owns the model it names, so naming one here was a leftover from
  // the single-route design and pointed at an account that may serve nothing.
  // What is worth saying is which accounts are in the pool at all.
  const serving = accounts.filter((account) => (routablePending.get(account.id) ?? account.routable === true));
  foot.textContent = serving.length
    ? `${serving.length} 个账号供模型${serving.length <= 2 ? `：${serving.map(shownName).join("、")}` : ""}`
    : "还没有账号供模型，客户端读不到模型";
  const checkin = new Map((snapshot.checkin?.accounts || []).map((item) => [item.id, item]));
  list.innerHTML = accounts.map((account) => {
    const routable = routablePending.get(account.id) ?? account.routable === true;
    // No "default" badge and no locked row: which account carries a request
    // follows the model being asked for, not a chosen primary. The footer
    // still names the account that happens to be carrying right now.
    const tags = [
      account.enterpriseId ? '<em class="tag-soft">企业</em>' : "",
      account.site === "workbuddy-ai" ? '<em class="tag-soft">海外</em>' : "",
      (account.provider === "trae" || account.provider === "qoder") ? `<em class="tag-soft">${upstreamLabel(account)}</em>` : "",
      routable ? "" : '<em class="tag-soft">不供模型</em>'
    ].filter(Boolean).join("");
    return `
    <div class="account-row" data-id="${esc(account.id)}">
      <div class="account-avatar${account.provider === "qoder" ? " tile" : ""}"><img src="${upstreamIcon(account)}" alt=""></div>
      <div class="account-main">
        <div class="account-title"><b>${esc(shownName(account))}</b>${tags}</div>
        <div class="account-meta">
          <span class="account-host">${esc(account.domain || upstreamLabel(account))}</span>
          <i>·</i>
          <code>${esc(accountMasked ? maskId(account.id) : account.id.slice(0, 8))}</code>
          ${checkinChip(checkin.get(account.id))}
          ${creditsChip(account)}
        </div>
      </div>
      <div class="account-actions">
        <label class="account-toggle" data-tip="${routable ? "该账号的模型可供客户端使用，点此退出模型池" : "该账号的模型不参与路由，点此加入模型池（同一供应商只能开一个）"}">
          <span class="account-toggle-label">供模型</span>
          <span class="switch small"><input type="checkbox" data-act="routable"${routable ? " checked" : ""}><span></span></span>
        </label>
        <button class="icon-mini" data-act="remove" data-tip="移除账号" aria-label="移除账号">✕</button>
      </div>
    </div>`;
  }).join("");
}

// One chip per account, in the row it belongs to, instead of a second list
// to read against.
function checkinChip(item) {
  if (!item) return '<span class="account-chip idle">今日未签到</span>';
  if (item.status === "done") {
    return `<span class="account-chip ok">${item.reward ? `已签到 +${esc(item.reward)}` : "已签到"}</span>`;
  }
  if (item.status === "failed") return '<span class="account-chip warn">签到失败</span>';
  // No claim exists on this build, so "未签到" would read as a missed task.
  if (item.status === "unavailable") return '<span class="account-chip idle">积分自动发放</span>';
  return '<span class="account-chip idle">今日未签到</span>';
}

// The account's own balance, read behind the status poll: the first snapshot
// after a start answers null (the read runs behind it), and the figure fills
// in on the next tick. A failing read says so rather than showing a number
// the upstream did not report.
function creditsChip(account) {
  const view = creditView(account.credits);
  if (!view) {
    if (account.credits?.error) {
      // A sign-in the upstream refused is not a billing glitch: the chip says
      // which it is, because this row is where the account is managed.
      const expired = account.credits?.signIn === "expired";
      return `<span class="account-chip ${expired ? "warn" : "idle"}" data-tip="${esc(account.credits.error)}">${expired ? "需重新登录" : "积分不可用"}</span>`;
    }
    return '<span class="account-chip idle">积分 …</span>';
  }
  // A prepaid balance only falls: there is no cycle percent to warn about.
  if (view.prepaid) {
    const prefix = view.unit === "usd" ? "$" : "";
    return `<span class="account-chip" data-tip="${esc("预付积分余额")}">剩余 ${prefix}${creditNumber(view.left)}</span>`;
  }
  // Ninety percent gone is the point where the next long task may not fit;
  // below that the plain chip keeps the list calm.
  const tone = view.percent >= 90 ? " warn" : "";
  const prefix = view.unit === "usd" ? "$" : "";
  const tip = [`本周期已用 ${creditNumber(view.used)} / ${creditNumber(view.limit)}（${Math.round(view.percent)}%）`];
  if (view.resetsAt) tip.push(`${new Date(view.resetsAt).toLocaleDateString("zh-CN")} 重置`);
  if (view.runsOutAt) tip.push(`${new Date(view.runsOutAt).toLocaleDateString("zh-CN")} 未用额度过期`);
  return `<span class="account-chip${tone}" data-tip="${esc(tip.join(" · "))}">剩余 ${prefix}${creditNumber(view.left)}</span>`;
}

// The next time the scheduler will fire, as "今天 09:00" / "明天 21:30".
function nextCheckinText(settings) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(settings.hour, settings.minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const hm = `${String(settings.hour).padStart(2, "0")}:${String(settings.minute).padStart(2, "0")}`;
  return `${next.getDate() === now.getDate() ? "今天" : "明天"} ${hm}`;
}

// The 保存 button exists only while the typed time differs from the saved
// one — a resting card reads as "already saved", not as a form.
function syncCheckinSave(settings) {
  const hour = Number($("#checkin-hour").value);
  const minute = Number($("#checkin-minute").value);
  const dirty = hour !== Number(settings.hour) || minute !== Number(settings.minute)
    || !Number.isInteger(hour) || hour < 0 || hour > 23
    || !Number.isInteger(minute) || minute < 0 || minute > 59;
  $("#checkin-save").hidden = !dirty;
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
  syncCheckinSave(settings);

  // Accounts that never have a claim are not part of "日签到" accounting;
  // counting them leaves the day's count permanently short of its total.
  const accounts = checkin.accounts || [];
  const items = accounts.filter((item) => item.enabled && item.status !== "unavailable");
  const done = items.filter((item) => item.status === "done").length;
  const failed = items.filter((item) => item.status === "failed").length;
  const total = items.length;
  const reward = items.reduce((sum, item) => {
    const n = Number(item.reward);
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  // One sentence answers "how is today going"; everything else on the card
  // is schedule or failure detail.
  const state = $("#checkin-state");
  const sub = $("#checkin-state-sub");
  const hhmm = `${String(settings.hour).padStart(2, "0")}:${String(settings.minute).padStart(2, "0")}`;
  const retryNote = failed ? `${failed} 个失败，稍后自动重试` : "";
  if (!total) {
    state.textContent = accounts.length ? "暂无可签到的账号" : "还没有账号";
    sub.textContent = accounts.length ? "开启的账号到点自动签到" : "登录账号后每天自动领取积分";
  } else if (settings.enabled === false) {
    state.textContent = "自动签到已关闭";
    sub.textContent = `打开开关后每天 ${hhmm} 定时领取`;
  } else if (done === total) {
    state.textContent = `今日已全部签到（${done}/${total}）`;
    sub.textContent = `${reward > 0 ? `共领 ${creditNumber(reward)} 积分 · ` : ""}明天 ${hhmm} 再来`;
  } else if (done === 0) {
    state.textContent = "今日还未签到";
    sub.textContent = retryNote || `自动签到 ${nextCheckinText(settings)}`;
  } else {
    state.textContent = `今日已签 ${done} / ${total}`;
    sub.textContent = retryNote || `下次自动签到 ${nextCheckinText(settings)}`;
  }

  // Only what needs attention stays below the state line.
  const issues = items.filter((item) => item.status === "failed");
  const list = $("#checkin-list");
  list.hidden = issues.length === 0;
  list.innerHTML = issues.map((item) => `
    <div class="checkin-item">
      <span>${esc(accountMasked ? maskName(item.label) : item.label)}</span>
      <b class="err">${esc(item.error || "签到失败")}</b>
    </div>`).join("");
}

async function accountAction(action, id, options = {}) {
  try {
    await window.lane.account(action, id, options);
    toast({
      enabled: options.enabled ? "已启用账号" : "已关闭账号",
      routable: options.routable ? "该账号已加入模型池" : "该账号已退出模型池",
      remove: "已移除账号"
    }[action] || "操作完成");
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message || String(error), true);
  }
}

// The route's agent slot shows whichever agent sent the latest request,
// falling back to the connected one, and the workflow lists both.
function renderRouteAgent(last, { codexOn, claudeOn, zcodeOn, vscodeOn, dshOn }) {
  // The AGENT node shows every client that is wired, so the route reads the
  // same whether one, two or all of them are in use. Each mark carries its
  // own name under its logo: Codex's star and Claude's asterisk read alike
  // at this size, so a joined name line left the marks unattributable.
  const clients = [
    { on: codexOn, mark: "#client-codex-mark", full: "Codex" },
    { on: claudeOn, mark: "#client-claude-mark", full: "Claude Desktop" },
    { on: zcodeOn, mark: "#client-zcode-mark", full: "ZCode" },
    { on: vscodeOn, mark: "#client-vscode-mark", full: "VS Code" },
    { on: dshOn, mark: "#client-dsh-mark", full: "DeepSeek Harness" }
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

function renderModels(models, freeAllowance = null, gate = null) {
  const list = $("#model-list");
  // The page shows the FULL upstream catalogue so every model can be added
  // or removed; `models` is the agent-facing subset the gateway serves.
  const rowsData = Array.isArray(models) && models.length ? models : [];
  if (!rowsData.length) {
    list.innerHTML = '<div class="empty">登录账号后可读取模型目录。</div>';
    return;
  }
  // A live search narrows what the page shows without touching the allowlist.
  const modelSearchEl = $("#model-search");
  const search = String((modelSearchEl?.value || "").trim()).toLowerCase();
  // New entries are `provider:id`; a legacy bare id still matches every
  // provider, which is exactly how models.json behaves before migration.
  const enabled = new Set([
    ...(Array.isArray(gate?.enabledKeys) ? gate.enabledKeys : []),
    ...(Array.isArray(gate?.enabledIds) ? gate.enabledIds : [])
  ]);
  const visible = search
    ? rowsData.filter((model) =>
      String(model.name || model.id).toLowerCase().includes(search)
      || String(model.id).toLowerCase().includes(search))
    : rowsData;
  const count = $("#model-count");
  if (count) count.textContent = gate?.corrupt
    ? "模型配置损坏，暂按未添加处理"
    : search ? `${visible.length} / ${rowsData.length}` : `${rowsData.length} 个模型`;
  list.innerHTML = visible.map((model) => {
    const status = modelStatus(model, freeAllowance);
    const provider = String(model.owned_by || model.provider || "workbuddy");
    const on = enabled.has(String(model.id)) || enabled.has(`${provider}:${model.id}`);
    // The source column names the account that serves the model. With
    // several accounts live one id can come from more than one of them, and
    // that is exactly what the user has to see to choose between them.
    const owner = model.ownerLabel
      ? `${model.ownerLabel}${model.sharedWith?.length ? ` +${model.sharedWith.length}` : ""}`
      : (model.owned_by || "upstream");
    const ownerTip = model.sharedWith?.length
      ? `同一模型还来自：${model.sharedWith.map((item) => item.ownerLabel).join("、")}`
      : "";
    // The plain name is what the upstream calls the model; the namespaced id
    // is Lane's, and only worth showing when it differs.
    const qualified = model.bareId && model.id !== model.bareId ? model.id : "";
    return `
    <div class="model-row">
      <div class="model-name">${esc(model.name || model.id)}${qualified ? `<code class="model-qualified" data-tip="Trae 等上游与 WorkBuddy 有同名模型，用前缀区分">${esc(qualified)}</code>` : ""}</div>
      <span>${model.context ? `${compact(model.context)} tokens` : "—"}</span>
      <span class="credit-rate">${creditRate(model)}</span>
      <code${ownerTip ? ` data-tip="${esc(ownerTip)}"` : ""}>${esc(owner)}</code>
      <span class="model-status${status.tone ? ` ${status.tone}` : ""}"${status.title ? ` data-tip="${esc(status.title)}"` : ""}>${esc(status.text)}${status.hint ? `<small>${esc(status.hint)}</small>` : ""}</span>
      <label class="model-switch" data-tip="${on ? "移除后 Agent 不再读取该模型" : "添加后 Agent 才能读取该模型"}">
        <input type="checkbox" data-model-add="${esc(model.id)}" data-model-provider="${esc(provider)}"${on ? " checked" : ""}>
        <span></span>
      </label>
    </div>`;
  }).join("");
  if (!visible.length) {
    list.innerHTML = '<div class="empty">没有匹配「' + esc(search) + '」的模型。</div>';
  }
}

// The per-model 添加/移除 switch: only added models are served to agents.
$("#model-list").addEventListener("change", async (event) => {
  const box = event.target.closest("input[data-model-add]");
  if (!box) return;
  box.disabled = true;
  try {
    await window.lane.setModel(box.dataset.modelAdd, box.checked, box.dataset.modelProvider || "");
    toast(box.checked ? `已添加 ${box.dataset.modelAdd}，Agent 可以读取` : `已移除 ${box.dataset.modelAdd}，Agent 不再读取`);
  } catch (error) {
    toast(`操作失败：${error.message}`, true);
    box.checked = !box.checked;
  } finally {
    box.disabled = false;
    refresh({ quiet: true });
  }
});

// The search box narrows the page's model rows; the allowlist is untouched.
const modelSearchEl = $("#model-search");
modelSearchEl.addEventListener("input", () => {
  // The status snapshot from a follower attached to an older gateway may not
  // carry `catalogue`; fall back to the models list it did send instead of
  // making a search keystroke blank the page.
  renderModels(snapshot?.catalogue || snapshot?.models || [], snapshot?.freeAllowance || null, snapshot?.modelGate || null);
});

// ---- usage ----------------------------------------------------------------

// The overview is computed in main over the whole journal, while this page's
// request list comes from the status snapshot. Both are refreshed together.
let usage = null;
// The page opens on the week view: it is the span people actually compare,
// while "today" is one click away at the left of the segmented control.
let usageRange = "7d";
// Which account's allowance the quota card shows. Empty means "follow the
// card above it": the same account the PROVIDER node describes, which is the
// first one switched into the pool. It used to mean the route account, and
// the route is a field left over from the single-account design — it stays on
// whatever was chosen last, so the card sat on that account forever.
let usageAccountId = "";

/**
 * The account whose allowance the card should read.
 *
 * An explicit pick wins; otherwise the PROVIDER node's account, so the two
 * cards describe the same one. The route account is the last resort, for an
 * install whose pool is still empty.
 */
function quotaAccountId() {
  return usageAccountId || providerViewAccount()?.id || snapshot?.activeId || "";
}
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
    usage = await window.lane.usage(usageRange, quotaAccountId());
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
const AGENT_LABELS = { codex: "Codex", "claude-desktop": "Claude", zcode: "ZCode", vscode: "VS Code", dsh: "DSH", openai: "OpenAI" };

// The mark each agent is drawn with in the recent-request list. The same
// official icons the agent cards use, so a row is attributable at a glance
// instead of by reading the name; an agent Lane has no icon for falls back to
// the text-only pill it always had.
const AGENT_ICONS = {
  codex: "assets/codex-official.svg",
  "claude-desktop": "assets/claude-official.svg",
  zcode: "assets/zcode-official-256.png",
  vscode: "assets/vscode-official.svg",
  dsh: "assets/dsh-official-256.png"
};

function agentLabel(agent) {
  return AGENT_LABELS[agent] || agent || "未知来源";
}

function agentIcon(agent) {
  return AGENT_ICONS[agent] || "";
}

// Three upstreams now, each with its own sites. The label and the mark live
// here so every card, row and picker names and draws the same account the
// same way, instead of each call site repeating a two-way branch.
const UPSTREAM_LABELS = {
  workbuddy: "WorkBuddy",
  "workbuddy-ai": "WorkBuddy AI",
  "trae-cn": "Trae CN",
  "trae-global": "Trae Global",
  qoder: "Qoder",
  "qoder-cn": "Qoder CN"
};
function upstreamLabel(account) {
  const site = String(account?.site || "");
  if (UPSTREAM_LABELS[site]) return UPSTREAM_LABELS[site];
  const provider = String(account?.provider || "");
  if (provider === "trae") return "Trae";
  if (provider === "qoder") return "Qoder";
  return "WorkBuddy";
}
function upstreamIcon(account) {
  const provider = String(account?.provider || "");
  if (provider === "trae") return "assets/trae-official-256.png";
  if (provider === "qoder") return "assets/qoder-official-256.png";
  return "assets/workbuddy-official.svg";
}







function renderUsage() {
  if (!usage) return;
  const { totals, series, models, quota } = usage;

  // One line of headline figures replaces the four metric cards: the totals
  // still read at a glance, and the chart below carries the detail. The
  // credits figure is what the upstream charged (its own `credit` report); the
  // money line under it converts that same figure at the plan's rate.
  $("#usage-summary").innerHTML = [
    `<b>${credits(totals.credits)}</b> 积分`,
    `<b>${totals.requests}</b> 次请求`
  ].join(" · ");
  const money = $("#usage-estimate");
  // Trae and other cycle-billed upstreams report token counts but no
  // per-request charge, so their rows carry credits: null. Saying nothing
  // made those requests look untracked; name the upstream's billing model
  // and show the tokens Lane did count, and point at the cycle quota card.
  const unbilled = Number(totals.unbilledRequests) || 0;
  const unbilledTokens = Number(totals.unbilledTokens) || 0;
  if (unbilled > 0) {
    money.hidden = false;
    money.textContent = `其中 ${unbilled} 次请求上游未逐请求计费（按周期额度结算），本机统计 ${compact(unbilledTokens)} tokens；周期额度见右侧卡片`;
  } else {
    money.hidden = !(totals.credits > 0);
    money.textContent = totals.credits > 0
      ? `折合 ¥${rmb(totals.credits)} · 按 10 元 = 200 积分换算`
      : "";
  }

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

// A smooth area trend for the daily spend. The old bar chart reserved a fixed
// 72px slot per day and centred a 16px bar in it, so a week of data floated in
// a wide panel with most of the card empty. This draws the same numbers as one
// continuous line across the full width: a soft area, a thin curve, a dot on
// every day that spent something, and the peak labelled in place.
function niceCeil(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

// Monotone cubic interpolation (Fritsch-Carlson): a smooth curve that never
// overshoots a day's own value, so the line cannot dip below zero or invent a
// peak between two quiet days.
function trendPath(points) {
  const n = points.length;
  if (n < 2) return "";
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = points[i + 1].x - points[i].x;
    slope[i] = dx[i] ? (points[i + 1].y - points[i].y) / dx[i] : 0;
  }
  const m = new Array(n);
  m[0] = slope[0];
  m[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (!slope[i]) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      m[i] = (3 / h) * a * slope[i];
      m[i + 1] = (3 / h) * b * slope[i];
    }
  }
  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const p = points[i];
    const q = points[i + 1];
    d += ` C${(p.x + dx[i] / 3).toFixed(2)},${(p.y + (m[i] * dx[i]) / 3).toFixed(2)} ` +
      `${(q.x - dx[i] / 3).toFixed(2)},${(q.y - (m[i + 1] * dx[i]) / 3).toFixed(2)} ` +
      `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
  }
  return d;
}

function renderUsageChart(series) {
  const node = $("#usage-chart");
  const active = series.filter((item) => (item.requests || 0) > 0);
  if (!active.length) {
    node.innerHTML = '<div class="empty">所选区间内还没有请求。</div>';
    return;
  }
  // An upstream that bills by cycle (Trae) reports tokens, not a per-request
  // charge. A flat zero line would look like nothing happened; say what the
  // chart cannot draw and point at the token figures that do exist.
  const billedPeak = Math.max(...series.map((item) => Number(item.credits) || 0), 0);
  const estimatedPeak = Math.max(...series.map((item) => Number(item.estimatedCredits) || 0), 0);
  if (!(billedPeak > 0)) {
    node.innerHTML = estimatedPeak > 0
      ? '<div class="empty">本区间只有按 token 估算的积分，没有上游逐请求扣费；token 用量见模型与请求列表。</div>'
      : '<div class="empty">本区间上游按周期额度结算，未逐请求返回扣费，积分趋势无数据；token 用量见模型与请求列表。</div>';
    return;
  }
  const W = 720;
  const H = 236;
  const pad = { top: 26, right: 16, bottom: 30, left: 48 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const maxCredits = Math.max(...series.map((item) => Number(item.credits) || 0), 0);
  // A little headroom above the peak keeps its label inside the plot.
  const yMax = niceCeil(maxCredits * 1.12 || 1);
  const n = series.length;
  const xAt = (i) => (n === 1 ? pad.left + plotW / 2 : pad.left + (plotW * i) / (n - 1));
  const yAt = (v) => pad.top + plotH - (Math.max(0, Number(v) || 0) / yMax) * plotH;
  const today = new Date();
  const pad2 = (v) => String(v).padStart(2, "0");
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const points = series.map((item, i) => ({ x: xAt(i), y: yAt(item.credits), item }));
  const line = trendPath(points);
  const baseline = pad.top + plotH;
  const area = points.length > 1
    ? `${line} L${points[n - 1].x.toFixed(2)},${baseline} L${points[0].x.toFixed(2)},${baseline} Z`
    : "";

  // Horizontal guides at 0, half and full scale, labelled on the left gutter.
  const grid = [0, 0.5, 1].map((t) => {
    const y = pad.top + plotH * (1 - t);
    return `<line class="trend-grid" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}"></line>` +
      `<text class="trend-axis" x="${pad.left - 10}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${credits(yMax * t)}</text>`;
  }).join("");

  // One label per point while they fit; a 15-day range thins to every other
  // date plus the last one so labels never touch.
  const step = n > 9 ? Math.ceil(n / 6) : 1;
  const ticks = new Set();
  for (let i = 0; i < n; i += step) ticks.add(i);
  ticks.add(n - 1);
  const xlabels = [...ticks].sort((a, b) => a - b).map((i) => {
    const item = series[i];
    const label = item.date === todayKey
      ? "今天"
      : new Date(`${item.date}T00:00:00`).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
    return `<text class="trend-axis trend-x" x="${xAt(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(label)}</text>`;
  }).join("");

  const slot = n === 1 ? plotW : plotW / (n - 1);
  const days = series.map((item, i) => {
    const dayCredits = Number(item.credits) || 0;
    const detail = [
      `${item.date}`,
      `积分 ${credits(item.credits)}`,
      ...(dayCredits > 0 ? [`折合 ¥${rmb(dayCredits)}`] : []),
      `请求 ${item.requests} 次`
    ].join("\n");
    const x = xAt(i);
    const dot = dayCredits > 0
      ? `<circle class="trend-dot" cx="${x.toFixed(1)}" cy="${yAt(dayCredits).toFixed(1)}" r="3.2"></circle>`
      : "";
    return `<g class="usage-day" data-tip="${esc(detail)}">` +
      `<rect x="${(x - slot / 2).toFixed(1)}" y="${pad.top}" width="${Math.max(slot, 8).toFixed(1)}" height="${plotH}" fill="transparent"></rect>` +
      `<line class="day-line" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${baseline}"></line>` +
      dot +
      `</g>`;
  }).join("");

  const peak = series.reduce((best, item) => (
    (Number(item.credits) || 0) > (Number(best.credits) || 0) ? item : best
  ), series[0]);
  const peakIndex = series.indexOf(peak);
  const peakLabel = Number(peak.credits) > 0
    ? `<text class="trend-peak" x="${xAt(peakIndex).toFixed(1)}" y="${(yAt(peak.credits) - 11).toFixed(1)}" text-anchor="middle">${credits(peak.credits)}</text>`
    : "";

  const single = n === 1
    ? `<rect class="trend-single" x="${(xAt(0) - 17).toFixed(1)}" y="${yAt(peak.credits).toFixed(1)}" width="34" height="${Math.max(2, baseline - yAt(peak.credits)).toFixed(1)}" rx="7"></rect>`
    : `<path class="trend-area" d="${area}"></path>` +
      `<path class="trend-line" d="${line}" pathLength="1"></path>`;

  node.innerHTML = `
    <div class="usage-trend">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日消耗趋势">
        <defs>
          <linearGradient id="usageTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#4f7d60" stop-opacity="0.22"></stop>
            <stop offset="100%" stop-color="#4f7d60" stop-opacity="0.02"></stop>
          </linearGradient>
        </defs>
        ${grid}
        ${single}
        ${days}
        ${xlabels}
        ${peakLabel}
      </svg>
    </div>
    <p class="usage-chart-note">${esc(peak.date)} 消耗最高 · 积分 ${credits(peak.credits)}（¥${rmb(peak.credits)}） · 请求 ${peak.requests} 次</p>`;
}

// The free-model allowance card used to sit here. It restated the credit
// windows the quota card already shows and counted this machine's free-model
// traffic, which the usage tables cover in detail; it was removed as noise.
// A per-model exhaustion still reaches the model list through
// `freeAllowance.refusedModels`.

// The quota card's account switch: one upstream allowance per account, so
// comparing them is the reason to open this page at all. The list is rebuilt
// only when its contents change, so an open dropdown is not closed under the
// user's pointer by the status poll behind it.
let quotaPickerKey = "";
function renderQuotaAccountPicker() {
  const button = $("#usage-account-button");
  const menu = $("#usage-account-menu");
  const label = $("#usage-account-label");
  if (!button || !menu || !label) return;
  const accounts = snapshot?.accounts || [];
  // The same account the card above describes, so the label never names one
  // account while the card shows another's balance.
  const current = quotaAccountId();
  const picked = accounts.find((account) => account.id === current);
  const masked = (account) => (accountMasked ? maskName(account.label) : account.label);
  // The button names the account being shown; with none there is nothing to
  // switch between, so the whole control steps aside.
  button.hidden = accounts.length < 2;
  label.textContent = picked ? masked(picked) : "选择账号";
  const key = accounts.map((a) => `${a.id}:${a.label}`).join("|") + `#${current}`;
  if (key === quotaPickerKey) return;
  quotaPickerKey = key;
  menu.innerHTML = accounts.map((account) => {
    const upstream = upstreamLabel(account);
    return `<button type="button" data-account="${esc(account.id)}"${account.id === current ? ' class="active"' : ""}>
      <img src="${upstreamIcon(account)}" alt="">
      <span><b>${esc(masked(account))}</b><small>${esc(upstream)}</small></span>
    </button>`;
  }).join("");
}

function renderUsageQuota(quota) {
  const node = $("#usage-quota");
  const plan = $("#usage-plan");
  renderQuotaAccountPicker();
  if (!quota || quota.error) {
    plan.textContent = "—";
    node.innerHTML = quota?.signIn === "expired"
      ? '<div class="empty">上游已拒绝这个账号的登录，请在「账号」页重新登录。</div>'
      : `<div class="empty">${esc(quota?.error && quota.error !== "not signed in" ? quota.error : "登录后显示账户额度。")}</div>`;
    return;
  }
  plan.textContent = quota.plan || "账户";
  const view = creditWindowOf(quota);
  if (!view) {
    node.innerHTML = '<div class="empty">该账户没有可读的积分额度。</div>';
    return;
  }
  // A prepaid balance is not a cycle: it has no total to fill, nothing spent
  // this cycle, and no reset. Drawing "0%" beside it would say the account has
  // its full allowance, which is the opposite of what a falling balance means.
  if (view.balance != null && !(Number(view.limit) > 0)) {
    node.innerHTML = `
      <div class="quota-hero">
        <div class="quota-figure">
          <span class="quota-label">预付积分余额</span>
          <div class="quota-amount"><b>${creditNumber(view.balance)}</b></div>
        </div>
        <span class="quota-badge">按次扣减</span>
      </div>
      <div class="quota-facts">
        <div class="quota-fact"><span>计费方式</span><b>用完为止</b></div>
      </div>`;
    return;
  }
  const used = Number(view.amount) || 0;
  const limit = Number(view.limit) || 0;
  const share = Number.isFinite(Number(view.used))
    ? Math.max(0, Math.min(100, Number(view.used)))
    : limit ? (used / limit) * 100 : 0;
  const left = Math.max(0, limit - used);
  // The cycle's reset date (an enterprise account carries one; a personal
  // account's summary carries none) is separate from the day credits left
  // would lapse (`runsOutAt`), and the card says which is which.
  const resetAt = view.resetsAt || quota.resetsAt;
  const reset = resetAt
    ? new Date(resetAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
    : "";
  const lapsesAt = view.runsOutAt
    ? new Date(view.runsOutAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
    : "";
  // Trae Global's entitlement window is in dollars, not credits; say the
  // unit rather than printing "$12" under a "剩余积分" heading.
  const money = view.unit === "usd";
  const prefix = money ? "$" : "";
  // 0.2.27 reports one measured token window per model, separate from the
  // credits above and separate from each other: a model can be out of its own
  // window while the account still has credits, which is the state the card
  // used to hide. Shown as their own rows, in the window's own unit.
  const tokenRows = tokenWindowsOf(quota).map((window) => {
    const cap = Number(window.limit) || 0;
    const amount = Number(window.amount) || 0;
    const share = cap > 0 ? Math.max(0, Math.min(100, (100 * amount) / cap)) : 0;
    const at = window.resetsAt
      ? new Date(window.resetsAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "";
    const label = String(window.name || "模型额度");
    return `<div class="quota-model${window.refused ? " used-up" : ""}">
      <div class="quota-model-head"><b>${esc(label)}</b><span>${window.refused ? "已用尽" : percent(share / 100)}</span></div>
      <div class="quota-meter slim"><i style="width:${share.toFixed(1)}%"></i></div>
      <div class="quota-model-foot"><span>${compact(amount)} / ${compact(cap)}</span>${at ? `<span>${esc(at)} 重置</span>` : ""}</div>
    </div>`;
  }).join("");
  // The two credit windows are different allowances with different end dates:
  // the plan's monthly grant renews with the cycle, while the extra credits
  // (daily check-in and other rewards) each lapse on their own day. Showing
  // them apart is what tells a user which one is about to be lost.
  const breakdown = creditBreakdown(quota);
  const breakdownRows = breakdown.map((row) => {
    const share = row.limit > 0 ? Math.max(0, Math.min(100, (100 * row.used) / row.limit)) : 0;
    const day = (iso) => (iso
      ? new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })
      : "");
    // Each allowance answers two different questions, and they are not the
    // same date: when this part is lost, and when it comes back. A plan
    // window renews (it has a reset date); reward credits only lapse.
    const lost = day(row.lapsesAt);
    const back = day(row.resetsAt);
    const dates = [
      lost ? `${lost} 到期` : "",
      back ? `${back} 重置` : ""
    ].filter(Boolean).join(" · ");
    return `<div class="quota-model${row.first ? " lapsing-first" : ""}">
      <div class="quota-model-head">
        <b>${esc(row.label)}${row.first ? ' <em class="quota-soon">先消耗</em>' : ""}</b>
        <span>剩 ${creditNumber(row.left)} / ${creditNumber(row.limit)}</span>
      </div>
      <div class="quota-meter slim"><i style="width:${share.toFixed(1)}%"></i></div>
      <div class="quota-model-foot">
        <span>${row.kind === "plan" ? "按周期重置" : "用不完即作废"}</span>
        ${dates ? `<span>${esc(dates)}</span>` : ""}
      </div>
    </div>`;
  }).join("");
  node.innerHTML = `
    <div class="quota-hero">
      <div class="quota-figure">
        <span class="quota-label">${money ? "剩余额度" : "剩余积分"}</span>
        <div class="quota-amount"><b>${prefix}${creditNumber(left)}</b><span>/ 共 ${prefix}${creditNumber(limit)}</span></div>
      </div>
      <span class="quota-badge${share >= 90 ? " warn" : ""}">剩余 ${percent((100 - share) / 100)}</span>
    </div>
    <div class="quota-meter"><i style="width:${share.toFixed(1)}%"></i></div>
    <div class="quota-facts">
      <div class="quota-fact"><span>已用</span><b>${percent(share / 100)}</b></div>
      <div class="quota-fact"><span>重置</span><b>${reset ? esc(reset) : "—"}</b></div>
      <div class="quota-fact"><span>未用额度</span><b>${lapsesAt ? `${esc(lapsesAt)} 到期` : "—"}</b></div>
    </div>
    ${breakdownRows ? `<div class="quota-models">${breakdownRows}</div>` : ""}
    ${tokenRows ? `<div class="quota-models">${tokenRows}</div>` : ""}`;
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
  // The donut shares out billed credits only — rows without an upstream
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
        <div class="usage-table-head"><span>模型</span><span>请求</span><span>积分</span><span class="usage-row-actions" aria-hidden="true"></span></div>
        ${models.map((row) => {
          const color = colorFor(row.model);
          const badge = rateBadge(row.rate);
          return `
          <div class="usage-table-row">
            <div class="usage-model">${color ? `<i class="model-dot" style="background:${color}"></i>` : ""}<b>${esc(row.model)}</b><code class="${badge.tone}">${esc(badge.text)}</code></div>
            <span>${row.requests}</span>
            <span class="usage-cost"${row.credits > 0 ? "" : ` data-tip="上游按周期额度结算，未逐请求返回扣费；本机统计 ${compact(row.totalTokens || 0)} tokens"`}>${row.credits > 0 ? `${credits(row.credits)} <i class="soft-label">¥${rmb(row.credits)}</i>` : (row.unbilledRequests > 0 ? "—" : credits(0))}</span>
            <button type="button" class="model-delete" data-model-delete="${esc(row.model)}" data-tip="删除「${esc(row.model)}」在当前区间的记录" aria-label="删除 ${esc(row.model)} 的使用记录">✕</button>
          </div>`;
        }).join("")}
        <div class="usage-table-foot">
          <span>合计</span><span>${totals.requests}</span>
          <span>${credits(totals.credits)}${totals.credits > 0 ? `（¥${rmb(totals.credits)}）` : ""}</span>
          <span></span>
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
    <span class="recent-cost">积分/token</span>
  </div>`;
  node.innerHTML = head + rows.map((item) => {
    const when = new Date(item.startedAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    // Rows written before the journal kept cachedTokens have no figure to
    // show: a missing value is unknown, not a zero percent. An upstream that
    // never reports a cache figure (Trae) is unknown too — showing 0% there
    // claimed a full miss the upstream never said.
    const cacheKnown = item.cachedTokens != null && item.cacheUnknown !== true;
    const cache = cacheKnown && item.inputTokens ? item.cachedTokens / item.inputTokens : 0;
    const state = requestState(item);
    // A billed credit is the upstream's own number and the only one shown as
    // credits. An upstream that bills by cycle (Qoder, Trae) returns no
    // per-request charge, so the column falls back to its real token count
    // rather than a bare dash. The model's multiplier — Qoder's "0.8×", the
    // price its own client prints — goes in the tooltip: it is a multiple, not
    // an amount, so printing it in the credit column would have claimed a
    // charge nobody measured.
    const measured = item.creditsSource === "upstream";
    const tokens = item.totalTokens || item.inputTokens + item.outputTokens || 0;
    const cost = measured
      ? credits(item.credits ?? 0)
      : (tokens ? `${compact(tokens)} tk` : "—");
    const multiple = Number.isFinite(item.rate) ? `×${item.rate}` : "";
    const costTip = measured
      ? ""
      : [
        "上游按周期额度结算，未逐请求计费",
        multiple ? `模型倍率 ${multiple}` : "",
        tokens ? `本机统计 ${compact(tokens)} tokens` : ""
      ].filter(Boolean).join(" · ");
    // A live request cannot be deleted; its box says so by being disabled.
    const running = item.status === "running";
    return `<div class="recent-row" data-id="${esc(item.id)}">
      <input type="checkbox" class="recent-pick" data-pick="${esc(item.id)}"${running ? " disabled" : ""} aria-label="选择这条记录">
      <span class="recent-time">${esc(when)}</span>
      <span class="agent-pill">${agentIcon(item.agent) ? `<img class="agent-mark" src="${agentIcon(item.agent)}" alt="">` : ""}${esc(agentLabel(item.agent))}</span>
      <span class="recent-model">${esc(item.model)}</span>
      <span class="recent-state ${state.tone}">${esc(state.text)}</span>
      <span class="recent-ctx">${item.contextWindow ? compact(item.contextWindow) : "—"}</span>
      <span class="recent-cache">${cacheKnown && item.inputTokens ? percent(cache) : "—"}</span>
      <span class="recent-cost"${costTip ? ` data-tip="${esc(costTip)}"` : ""}>${cost}${item.anomaly ? ' <i class="cost-flag" data-tip="同样大小、同样缓存命中率的请求通常远低于此">⚠ 异常</i>' : ""}</span>
    </div>`;
  }).join("");
  // The re-render created fresh, unchecked boxes: the button's visibility
  // and count must be recomputed against them, or a cleared selection left
  // the old 删除选中 button on screen, clicking through to nothing.
  syncRecentSelection();
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
  const siteNames = { "workbuddy": "WorkBuddy", "workbuddy-ai": "WorkBuddy AI", "trae-cn": "Trae CN", "trae-global": "Trae Global", "qoder": "Qoder", "qoder-cn": "Qoder CN" };
  try {
    const result = await window.lane.signIn({ site });
    if (result.url) await window.lane.openURL(result.url);
    toast(`已打开 ${siteNames[site] || site} 登录页，完成后会自动更新状态`);
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

// One model's row in the aggregate table: delete the records that fed it.
// The table is a per-range aggregate, so only that range's rows go — a wider
// range still tells its own story. The backend spares requests still running.
let modelDeleteBusy = false;
$("#usage-models").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-model-delete]");
  if (!button || modelDeleteBusy) return;
  const model = button.getAttribute("data-model-delete");
  const row = (usage?.models || []).find((item) => item.model === model);
  const count = row?.requests || 0;
  if (!count) {
    toast("该模型在当前区间没有可删除的记录", true);
    return;
  }
  // Send the range the table on screen was drawn with, not whichever button
  // was clicked most recently: a load can still be in flight.
  const range = usage?.range || usageRange;
  const label = (usage?.ranges || []).find((item) => item.key === range)?.label || "当前区间";
  if (!confirm(`删除「${model}」在${label}内的 ${count} 条使用记录？\n其它区间的记录会保留，此操作不可恢复。`)) return;
  modelDeleteBusy = true;
  button.disabled = true;
  try {
    const result = await window.lane.clearModel(model, range);
    const removed = result?.removed ?? 0;
    toast(removed ? `已删除「${model}」的 ${removed} 条记录` : "没有删除记录：请求可能仍在进行中", !removed);
  } catch (error) {
    toast(error.message || "删除失败", true);
  } finally {
    modelDeleteBusy = false;
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
// The quota card's account switch: reading another account's allowance is a
// new usage read, so it goes through the same loader as a range change.
$("#usage-account-button")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#usage-account-menu");
  const button = $("#usage-account-button");
  if (!menu || !button) return;
  const open = menu.hidden;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
});
$("#usage-account-menu")?.addEventListener("click", (event) => {
  const pick = event.target.closest("button[data-account]");
  if (!pick) return;
  usageAccountId = pick.dataset.account || "";
  // The quota card lists every account (a balance is worth reading whether or
  // not the account serves models), while the PROVIDER node only draws the
  // ones in the pool. Setting the node's choice to an account it cannot draw
  // would leave the two disagreeing, so it only follows when that account is
  // actually in the pool.
  const serving = (snapshot?.accounts || []).some(
    (account) => account.id === usageAccountId && account.routable === true
  );
  if (serving) providerViewId = usageAccountId;
  $("#usage-account-menu").hidden = true;
  $("#usage-account-button")?.setAttribute("aria-expanded", "false");
  renderAccountIdentity();
  loadUsage();
});
// A click anywhere else closes the menu, the same way the add-account one
// behaves: leaving it open over the card reads as a stuck control.
document.addEventListener("click", (event) => {
  const menu = $("#usage-account-menu");
  if (!menu || menu.hidden) return;
  if (event.target.closest(".quota-account-picker")) return;
  menu.hidden = true;
  $("#usage-account-button")?.setAttribute("aria-expanded", "false");
});
// The PROVIDER node's chips pick which serving account the card describes.
// This changes nothing about routing — the model still decides that — it only
// answers "whose balance am I looking at".
$("#provider-pool")?.addEventListener("click", (event) => {
  const chip = event.target.closest("button[data-provider-account]");
  if (!chip) return;
  providerViewId = chip.dataset.providerAccount || "";
  // The quota card's own switch follows the same choice, so the two views of
  // "which account" never disagree. Its label is repainted here rather than
  // waiting for the usage read, which would leave it naming the old account
  // until the response lands.
  usageAccountId = providerViewId;
  renderAccountIdentity();
  renderQuotaAccountPicker();
  loadUsage();
});
$("#codex-connect").addEventListener("click", () => command("connect", { agent: "codex" }, "Codex 已接入，请新建会话"));
$("#codex-disconnect").addEventListener("click", () => command("disconnect", { agent: "codex" }, "Codex 已断开"));
$("#claude-connect").addEventListener("click", () => command("connect", { agent: "claude-desktop" }, "Claude Desktop 已接入，请重启客户端"));
$("#claude-disconnect").addEventListener("click", () => command("disconnect", { agent: "claude-desktop" }, "Claude Desktop 已断开"));
$("#zcode-connect").addEventListener("click", () => command("connect", { agent: "zcode" }, "ZCode 已接入，请重启客户端"));
$("#vscode-connect").addEventListener("click", () => command("connect", { agent: "vscode" }, "VS Code 已接入，请重载窗口"));
$("#dsh-connect").addEventListener("click", () => command("connect", { agent: "dsh" }, "DeepSeek Harness 已接入，请重启客户端"));
$("#zcode-disconnect").addEventListener("click", () => command("disconnect", { agent: "zcode" }, "ZCode 已断开"));
$("#vscode-disconnect").addEventListener("click", () => command("disconnect", { agent: "vscode" }, "VS Code 已断开"));
$("#dsh-disconnect").addEventListener("click", () => command("disconnect", { agent: "dsh" }, "DeepSeek Harness 已断开"));
$("#quick-signin").addEventListener("click", () => {
  // More than one upstream can sign in now: take the user to the account page
  // and let them pick which one, rather than silently starting WorkBuddy's.
  go("accounts");
  $("#add-menu").hidden = false;
});
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
  // The 切换 button is gone: with several accounts live at once the route is
  // no longer a single "which one serves" choice, so there is nothing to
  // switch. `activate` stays reachable through the CLI for a default account.
  if (button.dataset.act === "remove") {
    const label = row.querySelector("b")?.textContent || id;
    if (!confirm(`移除账号「${label}」？这会删除 Lane 保存的该账号登录信息。`)) return;
    return accountAction("remove", id);
  }
});
$("#account-mask").addEventListener("click", () => {
  accountMasked = !accountMasked;
  try { localStorage.setItem("lane.accountMasked", accountMasked ? "1" : "0"); } catch {}
  renderAccounts();
  renderAccountIdentity();
});
$("#account-list").addEventListener("change", (event) => {
  const routableInput = event.target.closest('input[data-act="routable"]');
  if (!routableInput) return;
  const id = routableInput.closest("[data-id]")?.dataset.id;
  if (!id) return;
  const on = routableInput.checked;
  routablePending.set(id, on);
  // Turning one on switches the same provider's other account off. That is a
  // second row changing, and the row that loses its place must not keep
  // showing "on" until the next poll lands: mirror the rule here so the two
  // rows move together.
  if (on) {
    const clicked = (snapshot?.accounts || []).find((account) => account.id === id);
    const same = (account) => account.provider;
    if (clicked) {
      for (const other of snapshot?.accounts || []) {
        if (other.id === id || other.routable !== true) continue;
        if (same(other) === same(clicked)) routablePending.set(other.id, false);
      }
      renderAccounts();
    }
  }
  // Turning one on switches the same provider's other account off, so the
  // whole list is re-read rather than just this row.
  accountAction("routable", id, { routable: on }).finally(() => {
    // The reply is the truth for every row the command touched.
    routablePending.delete(id);
    for (const account of snapshot?.accounts || []) {
      if (account.id !== id) routablePending.delete(account.id);
    }
  });
});
$("#checkin-enabled").addEventListener("change", (event) => {
  saveCheckinSettings({ enabled: event.target.checked },
    event.target.checked ? "已开启每日签到" : "已关闭每日签到");
});
// Typing reveals 保存; leaving the saved value hides it again.
["checkin-hour", "checkin-minute"].forEach((id) => {
  $("#" + id).addEventListener("input", () => {
    syncCheckinSave((snapshot && snapshot.checkin && snapshot.checkin.settings) || { hour: 9, minute: 0 });
  });
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

// The DSH privacy switch: takes effect on the next request, no restart.
$("#hide-dsh").addEventListener("change", async (event) => {
  const box = event.target;
  const wanted = box.checked;
  hideDshPending = true;
  box.disabled = true;
  try {
    const result = await window.lane.hideDsh(wanted);
    box.checked = result.hideDsh !== false;
    toast(result.hideDsh !== false ? "已隐去 DSH 的名字" : "已恢复发送 DSH 的名字");
  } catch (error) {
    box.checked = !wanted;
    toast(error.message || "设置失败", true);
  } finally {
    box.disabled = false;
    hideDshPending = false;
  }
});

// Request redaction: both switches write the same settings object. The
// originals never enter settings.json — only these booleans do.
async function saveRedact(patch) {
  const secretsBox = $("#redact-secrets");
  const personalBox = $("#redact-personal");
  const ruleBoxes = $$("#redact-details [data-redact-rule]");
  const allowlist = $("#redact-allowlist");
  const custom = $("#redact-custom");
  redactPending = true;
  for (const node of [secretsBox, personalBox, allowlist, custom, ...ruleBoxes]) {
    if (node) node.disabled = true;
  }
  try {
    const result = await window.lane.redactSettings(patch);
    if (secretsBox) secretsBox.checked = result.redactSecrets !== false;
    if (personalBox) personalBox.checked = result.redactPersonal !== false;
    for (const box of ruleBoxes) {
      box.checked = result.redactRules?.[box.dataset.redactRule] !== false;
    }
    if (allowlist && document.activeElement !== allowlist) {
      allowlist.value = (result.redactAllowlist || []).join("\n");
    }
    if (custom && document.activeElement !== custom) {
      custom.value = (result.redactCustom || []).join("\n");
    }
    toast(patch.redactSecrets === false ? "已关闭请求脱敏" : "请求脱敏设置已更新");
  } catch (error) {
    toast(error.message || "设置失败", true);
  } finally {
    for (const node of [secretsBox, personalBox, allowlist, custom, ...ruleBoxes]) {
      if (node) node.disabled = false;
    }
    redactPending = false;
  }
}
$("#redact-secrets").addEventListener("change", (event) => saveRedact({ redactSecrets: event.target.checked }));
$("#redact-personal").addEventListener("change", (event) => saveRedact({ redactPersonal: event.target.checked }));
for (const box of $$("#redact-details [data-redact-rule]")) {
  box.addEventListener("change", (event) => {
    saveRedact({ redactRules: { [event.target.dataset.redactRule]: event.target.checked } });
  });
}
const lines = (value) => value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
for (const field of [$("#redact-allowlist"), $("#redact-custom")]) {
  field?.addEventListener("change", () => {
    saveRedact({
      redactAllowlist: lines($("#redact-allowlist").value),
      redactCustom: lines($("#redact-custom").value)
    });
  });
}

// The check-in lives in the account list's head now; the GitHub star link
// went with the welcome card it sat in.

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
    // Builds that grant credits with the plan have nothing to claim; saying
    // "0 done" would imply the round misfired.
    const automatic = results.filter((item) => item.status === "unavailable");
    // A check-in the switch blocked says so, instead of counting zero.
    if (!done && !failed && skipped.length) {
      toast(skipped.map((item) => item.reason).join("；"), true);
    } else if (failed) {
      toast(`签到完成 ${done} 个，失败 ${failed} 个`, true);
    } else if (!done && automatic.length) {
      toast(automatic[0].message || "积分随账户自动发放，无需签到");
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
$("#theme-seg").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-theme-mode]");
  if (!button) return;
  const mode = button.dataset.themeMode;
  if (!THEME_MODES.includes(mode) || mode === themeMode) return;
  themeMode = mode;
  try { localStorage.setItem("lane.themeMode", mode); } catch {}
  applyTheme();
});
// While "system" is selected, the OS flipping between light and dark should
// move the page with it (the native window chrome follows through main).
systemTheme.addEventListener("change", () => {
  if (themeMode === "system") applyTheme({ notify: false });
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
    const failures = result.failures || [];
    const agents = failures.length
      ? `${failures.length} 个客户端配置未能更新（${failures.map((f) => `${AGENT_SHORT[f.agent] || f.agent}：${f.message}`).join("；")}），重启后它们仍会连旧端口`
      : result.rewritten?.length
        ? `已同步更新接入配置：${result.rewritten.join("、")}`
        : "当前没有已接入的 Agent，无需改写";
    const autostart = result.autostartError
      ? ` 登录时启动项也未能更新：${result.autostartError}。`
      : "";
    gatewayNote(`已保存。重启 Lane 后生效，新地址 127.0.0.1:${result.port}。${agents}。${autostart}`, failures.length > 0 || result.autostartError);
    toast(
      failures.length || result.autostartError
        ? `端口已保存为 ${result.port}，但有配置未同步，请查看下方说明`
        : `网关端口已保存为 ${result.port}`,
      failures.length > 0 || Boolean(result.autostartError)
    );
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
  if (error) toast(`登录失败：${error}`, true);
  else toast("登录成功");
  await refresh({ quiet: true });
});

// The startup cover holds for a minimum span even when the gateway answers
// instantly - the sequence is ~2.5s long, and fading it at the first
// snapshot cut it to a blink. A click still skips, and the 4s backstop
// stays for a gateway that never comes up.
var bootGone = false;
var bootShownAt = Date.now();
var BOOT_MIN_MS = 2800;
function bootOut() {
  if (bootGone) return;
  var wait = Math.max(0, BOOT_MIN_MS - (Date.now() - bootShownAt));
  if (wait > 0) { setTimeout(bootOut, wait + 30); return; }
  bootGone = true;
  var boot = document.getElementById("boot");
  if (!boot) return;
  boot.classList.add("gone");
  setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 600);
}
// A click during the minimum hold means "skip now", not "queue the fade".
$("#boot").addEventListener("click", function () { bootGone = true; var b = document.getElementById("boot"); if (b) { b.classList.add("gone"); setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 600); } });
setTimeout(bootOut, 4000 + BOOT_MIN_MS);

refresh();
setInterval(() => {
  // The usage page already has its own numbers and a range control; polling
  // status behind it would only redraw the request list under the user.
  if (activeView === "activity") return;
  refresh({ quiet: true });
}, 3000);

// ---- extensions: MCP + skills ---------------------------------------------

var extData = { servers: [], targets: [] };
// The DSH privacy switch: loaded once from settings.json, and held steady
// while a save is in flight so a poll cannot flip the box back under the
// user's finger.
var hideDshLoaded = false;
var hideDshPending = false;
var redactLoaded = false;
var redactPending = false;
// The short names the MCP lamps and skill pips draw. DeepSeek Harness is
// absent on purpose: it has no entry in either list, because it manages its
// own MCP servers and its own skills.
var AGENT_SHORT = { "claude-desktop": "Claude", codex: "Codex", zcode: "ZCode" };
var AGENT_INITIAL = { "claude-desktop": "C", codex: "X", zcode: "Z" };

function extError(id, message) {
  var node = document.getElementById(id);
  if (!node) return;
  node.hidden = !message;
  node.textContent = message || "";
}

let pluginState = { plugins: [], checks: new Map(), previews: new Map() };

function pluginBadge(plugin, check) {
  if (check?.updateAvailable) return '<span class="plugin-badge warn">可更新 v' + esc(check.latestVersion) + '</span>';
  if (plugin.installed) return '<span class="plugin-badge">已安装</span>';
  return '<span class="plugin-badge">内置</span>';
}

function renderPlugins() {
  const node = $("#plugin-list");
  if (!node) return;
  const plugins = pluginState.plugins || [];
  if (!plugins.length) {
    node.innerHTML = '<div class="empty">正在读取插件…</div>';
    return;
  }
  node.innerHTML = plugins.map((plugin) => {
    const check = pluginState.checks.get(plugin.key);
    const preview = pluginState.previews.get(plugin.key);
    const diff = preview && !preview.upToDate ? preview.diff : null;
    const diffText = diff
      ? renderPluginDiff(diff)
      : "";
    const canUpdate = Boolean(check?.updateAvailable) || Boolean(preview && !preview.upToDate);
    return `<div class="plugin-row" data-plugin="${esc(plugin.key)}">
      <div>
        <div class="plugin-name"><b>${esc(plugin.title)}</b>${pluginBadge(plugin, check)}</div>
        <p class="plugin-desc">${esc(plugin.description)}</p>
        <div class="plugin-meta">${esc(plugin.packageName)} · 当前 ${esc(plugin.version || "—")}${check?.latestVersion ? ` · 最新 ${esc(check.latestVersion)}` : ""}${plugin.sha ? ` · SHA ${esc(plugin.sha.slice(0, 10))}…` : ""}</div>
      </div>
      <div class="plugin-actions">
        <button class="mini" data-plugin-check="${esc(plugin.key)}">检查更新</button>
        <button class="mini" data-plugin-update="${esc(plugin.key)}"${canUpdate ? "" : " disabled"}>更新</button>
        <button class="mini" data-plugin-rollback="${esc(plugin.key)}"${plugin.canRollback ? "" : " disabled"}>回滚</button>
      </div>
      ${preview && !preview.upToDate ? `<div class="plugin-diff">
        <b>${esc(preview.fromVersion || plugin.version)} → ${esc(preview.toVersion || check?.latestVersion || "新版本")}</b>
        ${diffText || "<br>新版没有新增域名或路径。"}
        <div class="plugin-diff-actions">
          <button class="mini" data-plugin-apply="${esc(plugin.key)}">确认安装</button>
          <button class="mini" data-plugin-cancel="${esc(plugin.key)}">取消</button>
        </div>
      </div>` : ""}
    </div>`;
  }).join("");
}

function renderPluginDiff(diff) {
  const lines = [];
  const hosts = diff.hosts || { added: [], removed: [] };
  const paths = diff.paths || { added: [], removed: [] };
  if (hosts.added.length) lines.push(`<span class="bad">新增域名：${hosts.added.map(esc).join("、")}</span>`);
  if (hosts.removed.length) lines.push(`<span class="ok">移除域名：${hosts.removed.map(esc).join("、")}</span>`);
  if (paths.added.length) lines.push(`<span class="bad">新增路径：${paths.added.map(esc).join("、")}</span>`);
  if (paths.removed.length) lines.push(`<span class="ok">移除路径：${paths.removed.map(esc).join("、")}</span>`);
  return lines.length ? `<br>${lines.join("<br>")}` : "";
}

async function loadPlugins() {
  const status = $("#plugin-status");
  if (status) {
    status.hidden = true;
    status.textContent = "";
  }
  try {
    pluginState.plugins = await window.lane.plugins();
    renderPlugins();
  } catch (error) {
    $("#plugin-list").innerHTML = `<div class="empty">${esc(error.message || "读取插件失败")}</div>`;
  }
  // The toggle lives in settings.json, not in the plugin record.
  try {
    const settings = await window.lane.gatewaySettings();
    const box = $("#plugin-auto");
    if (box) box.checked = settings.pluginAutoUpdate === true;
  } catch {}
}

$("#plugin-list").addEventListener("click", async (event) => {
  const check = event.target.closest("[data-plugin-check]");
  const update = event.target.closest("[data-plugin-update]");
  const apply = event.target.closest("[data-plugin-apply]");
  const cancel = event.target.closest("[data-plugin-cancel]");
  const rollback = event.target.closest("[data-plugin-rollback]");
  if (check) {
    const key = check.dataset.pluginCheck;
    check.disabled = true;
    try {
      const rows = await window.lane.pluginCheck();
      for (const row of rows) pluginState.checks.set(row.key, row);
      renderPlugins();
    } catch (error) {
      toast(`检查更新失败：${error.message}`, true);
    } finally {
      check.disabled = false;
    }
    return;
  }
  if (update) {
    const key = update.dataset.pluginUpdate;
    update.disabled = true;
    try {
      const preview = await window.lane.pluginStage(key);
      if (preview.upToDate) {
        toast("已经是最新版本");
      } else {
        pluginState.previews.set(key, preview);
        renderPlugins();
      }
    } catch (error) {
      toast(`准备更新失败：${error.message}`, true);
    } finally {
      update.disabled = false;
    }
    return;
  }
  if (apply) {
    const key = apply.dataset.pluginApply;
    const preview = pluginState.previews.get(key);
    const additions = preview?.diff ? preview.diff.hosts.added.length + preview.diff.paths.added.length : 0;
    if (!confirm(additions
      ? `新版新增了 ${additions} 个域名/路径，确认安装并信任这些变化吗？`
      : "确认安装这个版本吗？旧版本会保留，可回滚。")) return;
    apply.disabled = true;
    try {
      const info = await window.lane.pluginApply(key);
      pluginState.previews.delete(key);
      pluginState.checks.delete(key);
      toast(`插件已更新到 ${info.version || "新版本"}`);
      await loadPlugins();
    } catch (error) {
      toast(`安装失败：${error.message}`, true);
    } finally {
      apply.disabled = false;
    }
    return;
  }
  if (cancel) {
    pluginState.previews.delete(cancel.dataset.pluginCancel);
    renderPlugins();
    return;
  }
  if (rollback) {
    const key = rollback.dataset.pluginRollback;
    if (!confirm("回滚到上一个版本？当前插件会被替换。")) return;
    rollback.disabled = true;
    try {
      const info = await window.lane.pluginRollback(key);
      toast(`已回滚到 ${info.version || "内置版本"}`);
      await loadPlugins();
      // A rollback changes the installed version, so the row's cached check is
      // now about the version that was just replaced: the badge would read
      // "已安装" while the release the user had already found stayed hidden,
      // and 更新 stayed disabled until 检查更新 was pressed again. Re-check the
      // plugin that changed, so the row reflects where it now stands.
      const rows = await window.lane.pluginCheck();
      for (const row of rows) pluginState.checks.set(row.key, row);
      renderPlugins();
    } catch (error) {
      toast(`回滚失败：${error.message}`, true);
    } finally {
      rollback.disabled = false;
    }
  }
});

$("#plugin-refresh").addEventListener("click", loadPlugins);
$("#plugin-auto").addEventListener("change", async (event) => {
  try {
    await window.lane.redactSettings({ pluginAutoUpdate: event.target.checked });
    toast(event.target.checked ? "已开启自动更新：只安装没有新增域名/路径的版本" : "已关闭自动更新");
  } catch (error) {
    event.target.checked = !event.target.checked;
    toast(`保存失败：${error.message}`, true);
  }
});

async function loadExtensions() {
  // Two panels, two reads: a failure in one must not blank the other, and
  // its error belongs in its own panel. The old single try put a skills
  // failure in the MCP card's error line and left this one silently empty.
  try {
    var mcp = await window.lane.mcpList();
    extData.servers = mcp.servers || [];
    extData.targets = mcp.targets || [];
    // Test results are tied to the registry row's content; a changed command
    // invalidates them, and a load re-render keeps whatever was already run.
    if (!extData.mcpTest) extData.mcpTest = {};
    renderMcp();
    extError("mcp-error", "");
  } catch (error) {
    extError("mcp-error", error.message || "读取失败");
  }
  try {
    var skills = await window.lane.skillsList();
    // The HTTP route wraps the list as { skills }, and so does the desktop
    // IPC handler now. Accept either shape so a bare array can never blank
    // the whole library again.
    var list = Array.isArray(skills) ? skills : skills.skills || [];
    renderSkills(list);
    extError("skill-error", "");
  } catch (error) {
    extError("skill-error", error.message || "读取失败");
  }
}

function transportLabel(server) {
  return server.transport === "http" ? "远程" : "stdio";
}

function commandLine(server) {
  if (server.transport === "http") return server.url || "";
  return [server.command].concat(server.args || []).join(" ");
}

function renderMcp() {
  var node = document.getElementById("mcp-list");
  var legend = document.getElementById("mcp-legend");
  if (!extData.servers.length) {
    node.innerHTML = '<div class="empty">还没有登记 MCP 服务。<br>点右上角「添加」开始。</div>';
    legend.hidden = true;
    return;
  }
  legend.hidden = false;
  node.innerHTML = extData.servers.map(function (server) {
    // One lamp per client in a fixed order: on = written, off = not, blocked
    // = this client cannot take the transport at all.
    var lamps = extData.targets.map(function (target) {
      var on = server.agents.indexOf(target.agent) >= 0;
      var blocked = target.stdioOnly && server.transport === "http";
      var cls = blocked ? "mcp-lamp blocked" : on ? "mcp-lamp on" : "mcp-lamp";
      var tip = blocked
        ? AGENT_SHORT[target.agent] + " 不支持远程 MCP"
        : (on ? "已写入 " : "未写入 ") + AGENT_SHORT[target.agent];
      return '<span class="' + cls + '" data-lamp="' + esc(server.name) + '" data-agent="' + target.agent +
        '" data-tip="' + esc(tip) + '"><i></i>' + AGENT_SHORT[target.agent] + "</span>";
    }).join("");

    var testState = extData.mcpTest && extData.mcpTest[server.name];
    var testLine = "";
    if (testState) {
      if (testState.running) testLine = '<div class="mcp-test running">测试中…</div>';
      else if (testState.ok) {
        var tools = (testState.tools || []).map(esc).join("、") || "（该服务未提供工具）";
        testLine = '<div class="mcp-test ok">✓ ' + esc(testState.phases && testState.phases[0] || "连接成功") +
          ' — ' + (testState.tools || []).length + ' 个工具：' + tools + "</div>";
      } else {
        testLine = '<div class="mcp-test bad">✗ ' + esc(testState.error || "连接失败") + "</div>";
      }
    }

    // The verdict goes after the row's own three columns, not inside
    // .mcp-item-main: a long tool list wraps to several lines, and an inline
    // verdict would make the flex row's centred lamps and buttons drop to the
    // middle of that taller block. As a wrapped 100%-wide row it sits below
    // the row it belongs to, leaving the first line exactly as it was.
    return '<div class="mcp-item' + (server.off ? " paused" : "") + '" data-name="' + esc(server.name) + '">' +
      '<div class="mcp-item-main">' +
        '<div class="mcp-item-name"><b>' + esc(server.name) + "</b><code>" + transportLabel(server) + "</code></div>" +
        '<div class="mcp-item-cmd">' + esc(commandLine(server)) + "</div>" +
      "</div>" +
      '<div class="mcp-lamps">' + lamps + "</div>" +
      '<div class="mcp-item-actions">' +
        '<button class="mini quiet" data-mcp-test="' + esc(server.name) + '"' + (server.off ? " disabled" : "") + '>测试</button>' +
        '<button class="mini' + (server.off ? "" : " quiet") + '" data-mcp-toggle="' + esc(server.name) + '">' +
          (server.off ? "启用" : "停用") + "</button>" +
        '<button class="icon-mini" data-mcp-remove="' + esc(server.name) + '" data-tip="删除" aria-label="删除 ' +
          esc(server.name) + '">✕</button>' +
      "</div>" +
      testLine +
    "</div>";
  }).join("");
}

function renderSkills(list) {
  var node = document.getElementById("skills-list");
  if (!list.length) {
    node.innerHTML = '<div class="empty">技能库是空的。<br>点「导入」收进一个含 SKILL.md 的文件夹。</div>';
    return;
  }
  node.innerHTML = list.map(function (skill) {
    var installed = {};
    var occupied = {};
    // A pip is Lane's own install or nothing: a same-named folder another tool
    // put there is reported separately, not drawn as an install a click cannot
    // remove. Folding both into `installed` is what made 卸载 look broken — the
    // junction went away and the pip stayed lit on the foreign one.
    (skill.installs || []).forEach(function (item) {
      if (item.linked) installed[item.agent] = true;
      else if (item.foreign) occupied[item.agent] = true;
    });
    // A pip per client; filled means installed, clicking toggles it.
    var pips = ["codex", "zcode", "claude-desktop"].map(function (agent) {
      var on = Boolean(installed[agent]);
      var taken = Boolean(occupied[agent]);
      var tip = on
        ? "从 " + AGENT_SHORT[agent] + " 卸载"
        : taken
          ? AGENT_SHORT[agent] + " 的目标位置已有同名目录，不是 Lane 装的，不会覆盖也不会删除"
          : "安装到 " + AGENT_SHORT[agent];
      return '<button class="skill-pip' + (on ? " on" : "") + (taken ? " taken" : "") +
        '" data-pip="' + esc(skill.name) + '" data-agent="' + agent +
        '" data-tip="' + esc(tip) + '">' +
        AGENT_INITIAL[agent] + "</button>";
    }).join("");
    return '<div class="skill-card' + (skill.builtin ? " builtin" : "") + '">' +
      '<div class="skill-title"><b>' + esc(skill.name) + "</b>" +
        (skill.builtin ? '<em class="skill-builtin">内置</em>' : "") +
      "</div>" +
      // The description is a short label, clamped to one line. A hover popup
          // over body text is noise rather than help, so this one has none.
          "<p>" + esc(skill.description || "无描述") + "</p>" +
      '<div class="skill-foot">' + pips +
        '<span class="grow"></span>' +
        (skill.builtin ? "" : '<button class="mini quiet" data-skill-remove="' + esc(skill.name) + '">删除</button>') +
      "</div>" +
    "</div>";
  }).join("");
}

// -- editor -----------------------------------------------------------------

function showEditor(visible) {
  document.getElementById("mcp-form").hidden = !visible;
  if (visible) return;
  document.getElementById("mcp-editor-title").textContent = "新的 MCP 服务";
  ["mcp-name", "mcp-command", "mcp-args", "mcp-env", "mcp-url", "mcp-headers"].forEach(function (id) {
    document.getElementById(id).value = "";
  });
  document.getElementById("mcp-json-text").value = "";
  document.getElementById("mcp-json-area").hidden = true;
}

function setTransport(kind) {
  [...document.querySelectorAll("#mcp-transport button")].forEach(function (b) {
    b.classList.toggle("active", b.getAttribute("data-t") === kind);
  });
  document.getElementById("mcp-stdio-fields").hidden = kind === "http";
  document.getElementById("mcp-http-fields").hidden = kind !== "http";
}

function currentTransport() {
  var active = document.querySelector("#mcp-transport button.active");
  return active ? active.getAttribute("data-t") : "stdio";
}

function parsePairs(text) {
  var out = {};
  String(text || "").split(",").forEach(function (pair) {
    var i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

// HTTP headers are written the way the placeholder and "paste JSON" show
// them: `Authorization: Bearer …`, not `KEY=value`. The shared parsePairs()
// only split on "=", so a header typed exactly as prompted was silently
// dropped — and a remote server that needs a token (GitHub's, for one) was
// deployed with no Authorization at all. A comma inside a value, as in
// `X-MCP-Toolsets: repos,issues`, belongs to that value, not a new header.
function parseHeaders(text) {
  var out = {};
  var last = null;
  String(text || "").split(/[\r\n,]+/).forEach(function (piece) {
    var part = piece.trim();
    if (!part) return;
    var match = /^([A-Za-z0-9_-]+)\s*[:=]\s*([\s\S]*)$/.exec(part);
    if (match) {
      last = match[1];
      out[last] = match[2].trim();
    } else if (last) {
      out[last] += "," + part;
    }
  });
  return out;
}

$("#ext-refresh").addEventListener("click", loadExtensions);

$("#mcp-add").addEventListener("click", function () {
  var form = document.getElementById("mcp-form");
  if (form.hidden) {
    showEditor(true);
    document.getElementById("mcp-name").focus();
  } else {
    showEditor(false);
  }
});
$("#mcp-cancel").addEventListener("click", function () { showEditor(false); });

// -- paste-JSON entry --------------------------------------------------------
document.getElementById("mcp-json-toggle").addEventListener("click", function () {
  var area = document.getElementById("mcp-json-area");
  area.hidden = !area.hidden;
  if (!area.hidden) document.getElementById("mcp-json-text").focus();
});

document.getElementById("mcp-json-parse").addEventListener("click", function () {
  var result = parseMcpJson(document.getElementById("mcp-json-text").value);
  if (!result.ok) {
    toast(result.error, true);
    return;
  }
  var server = result.server;
  if (server.name && !document.getElementById("mcp-name").value.trim()) {
    document.getElementById("mcp-name").value = server.name;
  }
  setTransport(server.transport);
  if (server.transport === "stdio") {
    document.getElementById("mcp-command").value = server.command || "";
    document.getElementById("mcp-args").value = (server.args || []).join(" ");
    document.getElementById("mcp-env").value = Object.entries(server.env || {})
      .map(function (pair) { return pair[0] + "=" + pair[1]; }).join(", ");
  } else {
    document.getElementById("mcp-url").value = server.url || "";
    document.getElementById("mcp-headers").value = Object.entries(server.headers || {})
      .map(function (pair) { return pair[0] + ": " + pair[1]; }).join(", ");
  }
  document.getElementById("mcp-json-area").hidden = true;
  toast("已从 JSON 填充，确认后保存");
});

document.getElementById("mcp-transport").addEventListener("click", function (e) {
  var button = e.target.closest("button[data-t]");
  if (button) setTransport(button.getAttribute("data-t"));
});

$("#mcp-save").addEventListener("click", async function () {
  var button = this;
  button.disabled = true;
  try {
    var transport = currentTransport();
    var agents = [...document.querySelectorAll(".mcp-agent:checked")].map((c) => c.value);
    var server = {
      name: document.getElementById("mcp-name").value.trim(),
      transport: transport,
      agents: agents,
      off: false
    };
    if (transport === "http") {
      server.url = document.getElementById("mcp-url").value.trim();
      server.headers = parseHeaders(document.getElementById("mcp-headers").value);
    } else {
      server.command = document.getElementById("mcp-command").value.trim();
      server.args = document.getElementById("mcp-args").value.trim().split(/\s+/).filter(Boolean);
      server.env = parsePairs(document.getElementById("mcp-env").value);
    }
    var result = await window.lane.mcpUpsert(server);
    var wrote = (result.report || []).filter((r) => r.written && r.written.length).length;
    var blocked = (result.report || []).reduce((n, r) => n + (r.unsupported ? r.unsupported.length : 0), 0);
    toast("已保存，写入 " + wrote + " 个客户端" + (blocked ? "；" + blocked + " 个不支持该类型" : ""));
    showEditor(false);
    await loadExtensions();
  } catch (error) {
    toast(error.message || "保存失败", true);
  } finally {
    button.disabled = false;
  }
});

// -- list interactions ------------------------------------------------------

$("#mcp-list").addEventListener("click", async function (event) {
  var lamp = event.target.closest("[data-lamp]");
  if (lamp && !lamp.classList.contains("blocked")) {
    var name = lamp.getAttribute("data-lamp");
    var agent = lamp.getAttribute("data-agent");
    var server = extData.servers.find((s) => s.name === name);
    if (!server) return;
    var next = server.agents.slice();
    var at = next.indexOf(agent);
    if (at >= 0) next.splice(at, 1);
    else next.push(agent);
    try {
      await window.lane.mcpSetAgents(name, next);
      await loadExtensions();
    } catch (error) { toast(error.message || "操作失败", true); }
    return;
  }

  var toggle = event.target.closest("[data-mcp-toggle]");
  if (toggle) {
    var row = extData.servers.find((s) => s.name === toggle.getAttribute("data-mcp-toggle"));
    if (!row) return;
    try {
      await window.lane.mcpToggle(row.name, !row.off);
      await loadExtensions();
    } catch (error) { toast(error.message || "操作失败", true); }
    return;
  }

  var test = event.target.closest("[data-mcp-test]");
  if (test) {
    var name = test.getAttribute("data-mcp-test");
    extData.mcpTest = extData.mcpTest || {};
    extData.mcpTest[name] = { running: true };
    renderMcp();
    try {
      var result = await window.lane.mcpTest(name);
      extData.mcpTest[name] = { running: false, ok: Boolean(result.ok), error: result.error, tools: result.tools, phases: result.phases };
    } catch (error) {
      extData.mcpTest[name] = { running: false, ok: false, error: error.message || "测试失败" };
    }
    renderMcp();
    return;
  }

  var remove = event.target.closest("[data-mcp-remove]");
  if (remove) {
    var doomed = remove.getAttribute("data-mcp-remove");
    if (!confirm("删除 MCP 服务「" + doomed + "」？会同时从各客户端配置里摘除。")) return;
    try {
      await window.lane.mcpRemove(doomed);
      toast("已删除");
      await loadExtensions();
    } catch (error) { toast(error.message || "删除失败", true); }
  }
});

$("#skill-import").addEventListener("click", async function () {
  var dir = await window.lane.skillsPickFolder();
  if (!dir) return;
  try {
    var result = await window.lane.skillsImport(dir);
    toast("已导入技能「" + result.name + "」");
    await loadExtensions();
  } catch (error) {
    toast(error.message || "导入失败", true);
  }
});

var skillsBusy = false;

$("#skills-list").addEventListener("click", async function (event) {
  var pip = event.target.closest("[data-pip]");
  if (pip) {
    // A dashed slot means the name belongs to something Lane did not create:
    // installing would refuse it and uninstalling would remove nothing, so the
    // click says why instead of appearing to do nothing.
    if (pip.classList.contains("taken") && !pip.classList.contains("on")) {
      toast(pip.getAttribute("data-tip") || "该位置已有同名目录，不是 Lane 装的", true);
      return;
    }
    // The list is re-rendered by loadExtensions(), so a pip left enabled can
    // be clicked twice against the same stale state before it is replaced.
    if (skillsBusy) return;
    skillsBusy = true;
    var name = pip.getAttribute("data-pip");
    var agent = pip.getAttribute("data-agent");
    var on = pip.classList.contains("on");
    try {
      if (on) {
        var result = await window.lane.skillsUninstall(name, agent);
        // The junction may have gone while a foreign folder of the same name
        // stayed: say what actually happened rather than "卸载" either way.
        toast(result && result.removed
          ? "已从 " + AGENT_SHORT[agent] + " 卸载"
          : AGENT_SHORT[agent] + " 没有 Lane 安装的链接可卸载");
      } else {
        var result = await window.lane.skillsInstall(name, agent);
        var occupied = (result && result.occupied) || [];
        if (result && result.linked === false) {
          toast("未安装：" + AGENT_SHORT[agent] + " 的目标位置已有同名目录，Lane 不会覆盖", true);
        } else if (occupied.length) {
          toast("已安装到 " + AGENT_SHORT[agent] + "；" + occupied.length + " 处已有同名目录，未覆盖");
        } else {
          toast("已安装到 " + AGENT_SHORT[agent]);
        }
      }
      await loadExtensions();
    } catch (error) { toast(error.message || "操作失败", true); }
    finally { skillsBusy = false; }
    return;
  }

  var remove = event.target.closest("[data-skill-remove]");
  if (remove) {
    var doomed = remove.getAttribute("data-skill-remove");
    if (!confirm("删除技能「" + doomed + "」？会同时从各客户端卸载。")) return;
    try {
      await window.lane.skillsRemove(doomed);
      toast("已删除");
      await loadExtensions();
    } catch (error) { toast(error.message || "删除失败", true); }
  }
});
