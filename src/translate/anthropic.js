import { dataURLOf, contentParts, textOf, sseData } from "./common.js";

export function anthropicToChat(body) {
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of body.messages || []) {
    if (message.role === "assistant") {
      const text = textOf(message.content);
      const toolCalls = [];
      for (const part of contentParts(message.content)) {
        if (part.type === "tool_use") {
          toolCalls.push({
            id: part.id,
            type: "function",
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input || {})
            }
          });
        }
      }
      const out = { role: "assistant", content: text || null };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    const parts = contentParts(message.content);
    const toolResults = parts.filter((part) => part.type === "tool_result");
    for (const result of toolResults) {
      messages.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: textOf(result.content) || (typeof result.content === "string" ? result.content : "")
      });
    }
    const visible = parts.filter((part) => part.type !== "tool_result");
    if (visible.length) {
      if (visible.some((part) => part.type === "image")) {
        const content = visible.map((part) => {
          if (part.type === "image") {
            return { type: "image_url", image_url: { url: dataURLOf(part.source) } };
          }
          return { type: "text", text: part.text || "" };
        });
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: "user", content: textOf(visible) });
      }
    }
  }

  const out = {
    model: body.model,
    messages,
    stream: Boolean(body.stream)
  };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((tool) => tool.name)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema || { type: "object", properties: {} }
        }
      }));
  }
  if (body.tool_choice) out.tool_choice = toolChoice(body.tool_choice);
  const effort = body.output_config?.effort || body.thinking?.effort;
  if (effort && effort !== "none") out.reasoning_effort = effort;
  return out;
}

function toolChoice(choice) {
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) {
    return { type: "function", function: { name: choice.name } };
  }
  return "auto";
}

export function chatToAnthropic(payload, model, id) {
  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {}
    content.push({
      type: "tool_use",
      id: call.id || `toolu_${id}`,
      name: call.function?.name || "tool",
      input
    });
  }
  if (!content.length) content.push({ type: "text", text: "" });
  return {
    id: id.startsWith("msg_") ? id : `msg_${id}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: anthropicStop(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload?.usage?.prompt_tokens || 0,
      output_tokens: payload?.usage?.completion_tokens || 0
    }
  };
}

function anthropicStop(reason) {
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "refusal";
  return "end_turn";
}

export function anthropicStreamFromChat(chunkText, state, model) {
  const out = [];
  const lines = chunkText.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw.startsWith("data:")) continue;
    const data = raw.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (!state.started) {
      state.started = true;
      out.push(sseData({
        type: "message_start",
        message: {
          id: `msg_${state.id}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: payload.usage?.prompt_tokens || 0, output_tokens: 0 }
        }
      }));
      out.push(sseData({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    }
    if (delta.content) {
      out.push(sseData({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: delta.content }
      }));
    }
    if (choice.finish_reason && !state.finished) {
      state.finished = true;
      out.push(sseData({ type: "content_block_stop", index: 0 }));
      out.push(sseData({
        type: "message_delta",
        delta: { stop_reason: anthropicStop(choice.finish_reason), stop_sequence: null },
        usage: { output_tokens: payload.usage?.completion_tokens || 0 }
      }));
      out.push(sseData({ type: "message_stop" }));
    }
  }
  return out.join("");
}
