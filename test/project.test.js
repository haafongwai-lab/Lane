import test from "node:test";
import assert from "node:assert/strict";
import { projectOf, projectFromRoot } from "../src/project.js";

test("Codex's turn metadata names the workspace", () => {
  const headers = {
    "x-codex-turn-metadata": JSON.stringify({
      session_id: "abc",
      workspaces: { "C:\\Users\\me\\Desktop\\harness workplace\\lane": { has_changes: true } }
    })
  };
  const project = projectOf({ input: "hi" }, headers);
  // The identifier is case-folded so one directory spelled two ways is one
  // bucket; the display name keeps what was sent.
  assert.equal(project.id, "C:\\users\\me\\desktop\\harness workplace\\lane");
  assert.equal(project.name, "lane");
});

test("Codex's environment item is read when the header is missing", () => {
  const body = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>C:\\work\\my-app</cwd>\n</environment_context>" }] }
    ]
  };
  const project = projectOf(body, {});
  assert.equal(project.id, "C:\\work\\my-app");
  assert.equal(project.name, "my-app");
});

test("Claude Code's Environment block names the working directory", () => {
  const body = {
    system: [{ type: "text", text: "# Environment\nYou have been invoked in the following environment: \n - Primary working directory: C:\\repo\\lane\n - Is a git repository: true" }],
    messages: [{ role: "user", content: "hi" }]
  };
  const project = projectOf(body, {});
  assert.equal(project.id, "C:\\repo\\lane");
  assert.equal(project.name, "lane");
});

test("the same directory in different spellings is one project", () => {
  const forward = projectFromRoot("C:/repo/Lane/");
  const back = projectFromRoot("C:\\REPO\\lane");
  assert.equal(forward.id, back.id);
  // The drive letter is normalised, the rest of the case is kept: two
  // directories that differ only past the drive are still two projects.
  const lower = projectFromRoot("c:\\repo\\lane");
  assert.equal(lower.id, "C:\\repo\\lane");
});

test("a request with no readable project stays unattributed", () => {
  assert.equal(projectOf({ messages: [{ role: "user", content: "no paths here" }] }, {}), null);
  assert.equal(projectOf({}, {}), null);
  assert.equal(projectOf(null, {}), null);
});

test("a huge conversation is only searched at its head", () => {
  // A cwd mentioned deep in a long tool result is not the request's project:
  // only the system block and the first messages are read.
  const filler = "x".repeat(300_000);
  const body = {
    messages: [
      { role: "user", content: filler },
      { role: "user", content: "<cwd>C:\\deep\\inside\\history</cwd>" }
    ]
  };
  assert.equal(projectOf(body, {}), null);
});
