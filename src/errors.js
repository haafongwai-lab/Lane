export function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

export function errorJSON(res, status, message, type = "invalid_request_error") {
  json(res, status, { error: { message, type } });
}

// 64 MB: ZCode's Anthropic protocol resends the whole conversation every
// turn, so a long session's body grows past the old 8 MB floor and came
// back as 413 "Payload Too Large". Loopback-only, single user - a body this
// size in memory for the length of one request costs nothing.
export function readJSONBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (size > limit) {
        reject(Object.assign(new Error("request body is too large"), { status: 413 }));
        return;
      }
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    // A client that hangs up mid-body ends the stream without "end"; the
    // read would otherwise wait forever on a socket nobody is filling.
    req.on("close", () => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error("client hung up mid-body"), { status: 400 }));
    });
  });
}
