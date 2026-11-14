import { execFile } from "node:child_process";

/**
 * Windows DPAPI at the auth-file boundary.
 *
 * The user's WorkBuddy access and refresh tokens are the most valuable thing
 * Lane stores. `accounts.json` and `workbuddy-auth.json` used to be plain
 * JSON, so any backup or file copy exposed them. These helpers encrypt the
 * whole file with the current Windows user's DPAPI key before it is written;
 * legacy plaintext files still read fine and are upgraded on the next save.
 *
 * Non-Windows is left as plaintext because DPAPI is a Windows API; the desktop
 * product is Windows-only. A DPAPI failure also falls back to plaintext
 * rather than making sign-in impossible — the file ACL still limits access.
 */

const PREFIX = "dpapi:";
// Status polling reads accounts.json repeatedly; DPAPI is deliberately slow.
// Keep the last few decrypted values in memory, keyed by the exact ciphertext,
// so only a changed file pays the PowerShell round trip.
const plainCache = new Map();
const CACHE_MAX = 32;

function remember(ciphertext, plaintext) {
  if (plainCache.size >= CACHE_MAX) plainCache.delete(plainCache.keys().next().value);
  plainCache.set(ciphertext, plaintext);
  return plaintext;
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, LANE_SECRET_INPUT: input },
        windowsHide: true,
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security;",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($env:LANE_SECRET_INPUT);",
  "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  "[Convert]::ToBase64String($protected)"
].join(" ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security;",
  "$bytes=[Convert]::FromBase64String($env:LANE_SECRET_INPUT);",
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
  // Emit base64, not the raw string: Windows PowerShell's stdout encoding is
  // a console code page, which would turn Chinese account names into mojibake
  // before Node's UTF-8 decoder ever sees them.
  "[Convert]::ToBase64String($plain)"
].join(" ");

export async function protectText(text) {
  if (process.platform !== "win32") return text;
  try {
    return `${PREFIX}${await runPowerShell(PROTECT_SCRIPT, text)}`;
  } catch (error) {
    // DPAPI is unavailable (unusual Windows build, policy or PowerShell
    // blocked): keep the app usable; restrictToOwner still limits the file.
    // The degradation is announced, not silent — a user auditing "is my
    // token encrypted?" has to be able to see the answer in the log.
    console.error("DPAPI 不可用，凭据将以明文保存（仍限制为当前用户可读）:", error?.message || error);
    return text;
  }
}

export async function unprotectText(value) {
  const text = String(value ?? "");
  if (!text.startsWith(PREFIX)) return text;
  if (plainCache.has(text)) return plainCache.get(text);
  if (process.platform !== "win32") return text.slice(PREFIX.length);
  const encoded = await runPowerShell(UNPROTECT_SCRIPT, text.slice(PREFIX.length));
  return remember(text, Buffer.from(encoded, "base64").toString("utf8"));
}
