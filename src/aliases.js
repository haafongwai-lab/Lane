import { createHash } from "node:crypto";

// Claude Desktop only keeps gateway model ids that look Anthropic-ish.
// A stable numeric alias keeps its saved sessions valid while the display
// name still carries the real WorkBuddy model.
export function claudeAlias(id) {
  return `anthropic/lane-${digest(id)}`;
}

export function codexAlias(id) {
  return `lane/${id}`;
}

export function withAliases(models, agent) {
  return models.map((model) => ({
    ...model,
    alias: agent === "claude" ? claudeAlias(model.id) : model.id
  }));
}

export function resolveModel(requested, models, agent) {
  if (!requested) return requested;
  const direct = models.find((model) => model.id === requested);
  if (direct) return direct.id;
  const found = models.find((model) => model.alias === requested);
  if (found) return found.id;
  const bare = requested.replace(/^anthropic\/lane-/, "").replace(/^lane\//, "");
  const byId = models.find((model) => model.alias === requested || model.id === bare);
  if (byId) return byId.id;
  return models.find((model) => digest(model.id) === bare)?.id || requested;
}

function digest(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 10);
}
