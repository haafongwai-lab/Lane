import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { dataDir } from "./config.js";

const TASK_NAME = "Lane Gateway";

export async function installWindowsTask({
  env = process.env,
  port = 3426,
  node = process.execPath,
  script = path.resolve("src/cli.js"),
  runTask = run
} = {}) {
  assertWindows();
  const root = dataDir(env);
  const runner = path.join(root, "lane-task.cmd");
  const log = path.join(root, "lane.log");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    runner,
    [
      "@echo off",
      `cd /d "${path.dirname(script)}"`,
      `"${node}" "${script}" serve --addr 127.0.0.1:${port} >> "${log}" 2>&1`,
      ""
    ].join("\r\n")
  );
  const xml = xmlPath(root);
  await fs.writeFile(xml, taskXML(runner), "utf16le");
  await runTask("schtasks.exe", ["/Create", "/TN", TASK_NAME, "/XML", xml, "/F"]);
  return { installed: true, task: TASK_NAME, runner, port };
}

export async function uninstallWindowsTask() {
  assertWindows();
  await run("schtasks.exe", ["/Delete", "/TN", TASK_NAME, "/F"]);
  return { installed: false, task: TASK_NAME };
}

function assertWindows() {
  if (process.platform !== "win32") {
    throw new Error("autostart is available on Windows only");
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });
  });
}

function xmlPath(root) {
  return path.join(root, "lane-task.xml");
}

function taskXML(runner) {
  const user = escapeXML(process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME || "");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the Lane gateway after this user signs in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXML(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"))}</Command>
      <Arguments>/d /s /c "${escapeXML(runner)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function escapeXML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
