import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TraeProvider } from "../src/trae.js";

async function tempEnv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lane-trae-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { LANE_DATA_DIR: root };
}

test("a Trae billing-page 'expired' does not paint the account as logged out", async (t) => {
  // Trae's usage endpoint can answer "sign-in expired" while the agent's
  // requests keep working (the chat loader renews on demand). The account
  // chip must not claim the whole account needs re-login over that.
  const env = await tempEnv(t);
  const hooks = {
    auth: {
      usage: async () => ({ error: "Trae CN credits: your sign-in has expired — sign in again", signIn: "expired" })
    }
  };
  const provider = new TraeProvider({ env, factory: async () => hooks });
  await provider.init();
  await provider.finishSignIn(null, "trae-cn", {
    type: "success", access: "a", refresh: "r", expires: Date.now() + 3600_000,
    uid: "trae-u1", accountId: "Tester"
  });
  const usage = await provider.usage("trae-u1");
  assert.equal(usage.signIn, "expired");
  const chip = await provider.accountUsage("trae-u1");
  assert.equal(chip.signIn, "kept", "the chip's flag is neutralised");
  assert.match(chip.error, /expired/, "the raw message survives for the tooltip");
});
