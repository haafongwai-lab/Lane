/**
 * Which usage window answers "how many credits does this account have left".
 *
 * The plugin's `auth.usage` hook shapes its `windows` by version:
 *
 *   0.1.30      one "Credits" window, plan and extra packages summed.
 *   0.2.11+     "Credits" (the plan's) and "Extra credits" as two windows,
 *               one of them `aside` — the one whose running out does not
 *               stop the account.
 *   0.2.24+     both of those plus a "Total credits" window that is their
 *               sum, with the two originals set aside.
 *   0.2.0+      also "Prepaid credits" (a balance with no cycle limit) and
 *               "Free model tokens" (a token count, not credits at all).
 *
 * The card must show the total credits, so a "Total credits" window wins; a
 * build without one has its two credit windows summed exactly the way
 * 0.2.24's `totalOf` does. A token window is never a credit window: shown as
 * credits it read "176,000,000 / 200,000,000" with "积分" beside it.
 *
 * Pure and dependency-free, so the renderer and the gateway read one rule.
 */

export function creditWindowOf(usage) {
  const windows = Array.isArray(usage?.windows) ? usage.windows : [];
  const byName = (name) => windows.find((item) => item.name === name);
  const total = byName("Total credits");
  if (total) return total;
  const plan = byName("Credits");
  const extra = byName("Extra credits");
  if (plan && extra && Number(extra.limit) > 0) {
    const used = (Number(plan.amount) || 0) + (Number(extra.amount) || 0);
    const limit = (Number(plan.limit) || 0) + (Number(extra.limit) || 0);
    if (limit > 0) {
      // The same merge as 0.2.24's totalOf: the plan's reset date, and the
      // earlier of the two "runs out" dates (both of them when they agree).
      const at = (item) => (item.runsOutAt ? Date.parse(item.runsOutAt) : 0);
      const a = at(plan);
      const b = at(extra);
      const soon = a > 0 && (!(b > 0) || a <= b) ? plan : b > 0 ? extra : null;
      return {
        name: "Total credits",
        used: (100 * used) / limit,
        amount: used,
        limit,
        unit: "credits",
        ...(plan.resetsAt ? { resetsAt: plan.resetsAt } : {}),
        ...(plan.span ? { span: plan.span } : {}),
        ...(soon ? {
          runsOutAt: soon.runsOutAt,
          runsOut: (Number(soon.runsOut) || 0) + (a > 0 && a === b ? Number(extra.runsOut) || 0 : 0)
        } : {})
      };
    }
  }
  if (plan) return plan;
  // A balance with no cycle limit: real credits, just not a meter.
  const prepaid = byName("Prepaid credits");
  if (prepaid && Number(prepaid.balance) > 0) return prepaid;
  return null;
}
