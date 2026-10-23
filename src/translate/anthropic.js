import { dataURLOf, contentParts, textOf, sseData, parseSSEData } from "./common.js";

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
        content: toolResultContent(result.content)
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
  const effort = body.laneEffort || body.output_config?.effort || body.thinking?.effort;
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

// A tool result can carry the screenshot a tool took, not only text; the
// parts the chat shape can carry are forwarded so an image coming back from
// a coding agent is not dropped on the way upstream.
function toolResultContent(content) {
  if (typeof content === "string") return content;
  const parts = contentParts(content);
  if (!parts.some((part) => part?.type === "image")) {
    return textOf(parts);
  }
  return parts.map((part) => {
    if (part.type === "image") {
      return { type: "image_url", image_url: { url: dataURLOf(part.source) } };
    }
    return { type: "text", text: part.text || "" };
  });
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
  for (const payload of parseSSEData(chunkText)) {
    if (payload.error) {
      throw upstreamStreamError(payload.error);
    }
    if (payload.usage) state.usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (!state.started) {
      startAnthropic(out, state, model, payload.usage);
    }
    // A payload after message_stop would open a new block the protocol has
    // no place for; the stream has said everything it is going to.
    if (state.finished) continue;
    if (delta.content) {
      openAnthropicText(out, state);
      out.push(sseData({
        type: "content_block_delta",
        index: state.block,
        delta: { type: "text_delta", text: delta.content }
      }));
    }
    for (const call of delta.tool_calls || []) {
      openAnthropicTool(out, state, call);
    }
    if (choice.finish_reason && !state.finished) {
      state.finished = true;
      finishAnthropicBlocks(out, state);
      out.push(sseData({
        type: "message_delta",
        delta: { stop_reason: anthropicStop(choice.finish_reason), stop_sequence: null },
        usage: {
          output_tokens: payload.usage?.completion_tokens || state.usage?.completion_tokens || 0
        }
      }));
      out.push(sseData({ type: "message_stop" }));
    }
  }
  return out.join("");
}

export function anthropicStreamError(error) {
  const message = typeof error === "string" ? error : error?.message || "upstream stream failed";
  return `event: error\ndata: ${JSON.stringify({
    type: "error",
    error: { type: "api_error", message }
  })}\n\n`;
}

export function anthropicMessageFromStream(chunkText, state, model) {
  const events = parseSSEData(chunkText);
  if (events.some((payload) => !payload.choices && payload?.type === "message")) {
    return events.find((payload) => payload?.type === "message");
  }
  const message = {
    id: `msg_${state.id}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 }
  };
  let block = null;
  let blockArgs = "";
  const flush = () => {
    if (!block) return;
    if (block.type === "tool_use") {
      try {
        block.input = JSON.parse(blockArgs || "{}");
      } catch {
        block.input = {};
      }
    }
    message.content.push(block);
    block = null;
    blockArgs = "";
  };
  for (const payload of events) {
    if (payload.error) {
      throw upstreamStreamError(payload.error);
    }
    const choice = payload.choices?.[0];
    if (!choice) continue;
    if (payload.usage) {
      message.usage.input_tokens = payload.usage.prompt_tokens || message.usage.input_tokens;
      message.usage.output_tokens = payload.usage.completion_tokens || message.usage.output_tokens;
    }
    const delta = choice.delta || {};
    if (delta.content) {
      if (!block || block.type !== "text") {
        flush();
        block = { type: "text", text: "" };
      }
      block.text += delta.content;
    }
    for (const call of delta.tool_calls || []) {
      if (!block || block.type !== "tool_use" || (call.index ?? 0) !== block._index) {
        flush();
        block = {
          type: "tool_use",
          id: call.id || `toolu_${state.id}_${call.index || 0}`,
          name: call.function?.name || "tool",
          input: {}
        };
        block._index = call.index ?? 0;
      }
      if (call.id) block.id = call.id;
      if (call.function?.name) block.name = call.function.name;
      blockArgs += call.function?.arguments || "";
    }
    if (choice.finish_reason) {
      message.stop_reason = anthropicStop(choice.finish_reason);
    }
  }
  flush();
  for (const item of message.content) delete item._index;
  if (!message.content.length) message.content.push({ type: "text", text: "" });
  return message;
}

function startAnthropic(out, state, model, usage) {
  state.started = true;
  state.block = -1;
  state.openType = "";
  state.toolBlocks = new Map();
  state.textBlocks = [];
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
      usage: { input_tokens: usage?.prompt_tokens || 0, output_tokens: 0 }
    }
  }));
}

function openAnthropicText(out, state) {
  if (state.openType === "text") return;
  state.block += 1;
  state.textBlocks.push(state.block);
  state.openType = "text";
  out.push(sseData({
    type: "content_block_start",
    index: state.block,
    content_block: { type: "text", text: "" }
  }));
}

// An OpenAI-shaped upstream may interleave the deltas of parallel tool
// calls, while the Anthropic stream addresses deltas by block index. Blocks
// therefore stay open for the whole stream — a delta arriving for a block
// that already closed could not be said again — and every block closes in
// the order it opened once the message finishes.
function openAnthropicTool(out, state, call) {
  const index = call.index ?? 0;
  let block = state.toolBlocks.get(index);
  if (!block) {
    state.block += 1;
    block = {
      index: state.block,
      id: call.id || `toolu_${state.id}_${index}`,
      name: call.function?.name || "tool",
      args: false
    };
    state.toolBlocks.set(index, block);
    state.openType = "tool";
    out.push(sseData({
      type: "content_block_start",
      index: block.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} }
    }));
  }
  if (call.function?.arguments) {
    block.args = true;
    out.push(sseData({
      type: "content_block_delta",
      index: block.index,
      delta: { type: "input_json_delta", partial_json: call.function.arguments }
    }));
  }
}

function finishAnthropicBlocks(out, state) {
  const blocks = [
    ...state.toolBlocks.values(),
    ...state.textBlocks.map((index) => ({ index, text: true }))
  ].sort((a, b) => a.index - b.index);
  for (const block of blocks) {
    // A tool the upstream named but never argued gets an empty object, the
    // same shape a completed call leaves behind.
    if (!block.text && !block.args) {
      out.push(sseData({
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: "{}" }
      }));
    }
    out.push(sseData({ type: "content_block_stop", index: block.index }));
  }
  state.toolBlocks.clear();
  state.textBlocks = [];
  state.openType = "";
}

function upstreamStreamError(error) {
  const message = typeof error === "string" ? error : error?.message || "upstream stream failed";
  return Object.assign(new Error(message), { status: 502 });
}
