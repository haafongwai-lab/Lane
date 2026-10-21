import { createHash } from "node:crypto";

// Claude Desktop only keeps gateway model ids that look Anthropic-ish.
// A stable numeric alias keeps its saved sessions valid while the display
// name still carries the real WorkBuddy model.
export function claudeAlias(id) {
  return `anthropic/lane-${digest(id)}`;
}

// Claude Desktop only offers its thinking-effort picker for ids its own
// catalog knows; "mythos-" is the word it matches. The digest ties the
// picker id back to the WorkBuddy model.
export function claudeEffortAlias(id) {
  return `mythos-lane-${digest(id)}`;
}

export function withAliases(models, agent) {
  return models.map((model) => ({
    ...model,
    alias: agent === "claude"
      ? model.efforts?.length
        ? claudeEffortAlias(model.id)
        : claudeAlias(model.id)
      : model.id
  }));
}

export function resolveModel(requested, models, agent) {
  if (!requested) return requested;
  const direct = models.find((model) => model.id === requested);
  if (direct) return direct.id;
  const found = models.find((model) => model.alias === requested);
  if (found) return found.id;
  const bare = requested
    .replace(/^anthropic\/lane-/, "")
    .replace(/^mythos-lane-/, "")
    .replace(/^lane\//, "");
  const byId = models.find((model) => model.alias === requested || model.id === bare);
  if (byId) return byId.id;
  return models.find((model) => digest(model.id) === bare)?.id || requested;
}

// NearestEffort: the level of levels nearest the one asked for, a tie
// going up, want itself when the model's levels aren't known.
export function nearestEffort(want, levels) {
  const rank = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  if (want === "ultra") {
    want = "max";
    levels = levels.filter((level) => level !== "ultra");
  }
  const at = rank.indexOf(want);
  if (!levels?.length || at < 0 || levels.includes(want)) return want;
  let best = want;
  let dist = rank.length;
  for (const level of levels) {
    const i = rank.indexOf(level);
    if (i < 0 || level === "none") continue;
    const d = Math.abs(i - at);
    if (d < dist || (d === dist && i > at)) {
      best = level;
      dist = d;
    }
  }
  return best;
}

function digest(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 10);
}
