import fs from "node:fs/promises";
import path from "node:path";
import { claudePaths } from "./paths.js";
import { readJSON, writeJSON, readState, writeState } from "./store.js";
import { gatewayBase } from "../config.js";

const PROFILE_ID = "00000000-0000-4000-8000-6c616e650001";
const PROFILE_NAME = "lane";

function profile(gateway) {
  return {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: gateway,
    inferenceGatewayApiKey: "lane-claude-desktop",
    inferenceGatewayAuthScheme: "bearer",
    disableDeploymentModeChooser: true,
    coworkEgressAllowedHosts: ["*"]
  };
}

export async function connectClaudeDesktop({
  env = process.env,
  gateway = gatewayBase()
} = {}) {
  const paths = claudePaths(env);
  const state = await readState(env);
  const previous = state["claude-desktop"] || {};
  if (!previous.saved) {
    previous.saved = [];
    for (const set of paths.sets) {
      const mode = await readJSON(set.modeConfig);
      const threeP = await readJSON(set.threePConfig);
      const metaPath = path.join(set.library, "_meta.json");
      const profilePath = path.join(set.library, `${PROFILE_ID}.json`);
      previous.saved.push({
        root: set.local,
        modeDeploymentMode: mode.deploymentMode,
        threePDeploymentMode: threeP.deploymentMode,
        meta: await readJSON(metaPath),
        profileExists: await exists(profilePath)
      });
    }
  }

  for (const set of paths.sets) {
    const mode = await readJSON(set.modeConfig);
    const threeP = await readJSON(set.threePConfig);
    mode.deploymentMode = "3p";
    threeP.deploymentMode = "3p";
    await writeJSON(set.modeConfig, mode);
    await writeJSON(set.threePConfig, threeP);

    await writeJSON(path.join(set.library, `${PROFILE_ID}.json`), profile(gateway));
    const metaPath = path.join(set.library, "_meta.json");
    const meta = await readJSON(metaPath);
    meta.appliedId = PROFILE_ID;
    meta.entries = Array.isArray(meta.entries) ? meta.entries : [];
    meta.entries = meta.entries.filter((entry) => entry?.id !== PROFILE_ID);
    meta.entries.push({ id: PROFILE_ID, name: PROFILE_NAME });
    await writeJSON(metaPath, meta);
  }

  state["claude-desktop"] = { ...previous, connected: true, gateway, profileId: PROFILE_ID };
  await writeState(state, env);

  return {
    agent: "claude-desktop",
    connected: true,
    gateway,
    restartRequired: true,
    note: "Restart Claude Desktop so it reads the 3p profile."
  };
}

export async function disconnectClaudeDesktop({ env = process.env } = {}) {
  const paths = claudePaths(env);
  const state = await readState(env);
  const saved = state["claude-desktop"]?.saved;
  if (!saved) return { agent: "claude-desktop", connected: false, changed: false };

  const savedSets = Array.isArray(saved) ? saved : [];
  for (const item of savedSets) {
    const set = paths.sets.find((candidate) => candidate.local === item.root);
    if (!set) continue;
    const mode = await readJSON(set.modeConfig);
    const threeP = await readJSON(set.threePConfig);
    if (item.modeDeploymentMode === undefined) delete mode.deploymentMode;
    else mode.deploymentMode = item.modeDeploymentMode;
    if (item.threePDeploymentMode === undefined) delete threeP.deploymentMode;
    else threeP.deploymentMode = item.threePDeploymentMode;
    await writeJSON(set.modeConfig, mode);
    await writeJSON(set.threePConfig, threeP);
    await writeJSON(path.join(set.library, "_meta.json"), item.meta || {});
    if (!item.profileExists) {
      await fs.rm(path.join(set.library, `${PROFILE_ID}.json`), { force: true });
    }
  }
  delete state["claude-desktop"];
  await writeState(state, env);
  return { agent: "claude-desktop", connected: false, changed: true, restartRequired: true };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
