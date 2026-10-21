import { textOf, dataURLOf, sseData, parseSSEData } from "./common.js";

export function responsesToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "")
        });
        continue;
      }
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: item.call_id || item.id,
            type: "function",
            function: { name: item.name, arguments: item.arguments || "{}" }
          }]
        });
        continue;
      }
      if (item.role) {
        const content = responseContent(item.content);
        messages.push({ role: item.role, content });
      }
    }
  }
  const out = { model: body.model, messages, stream: Boolean(body.stream) };
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((tool) => tool.type === "function" && tool.name)
      .map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || { type: "object", properties: {} }
        }
      }));
  }
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  return out;
}

function responseContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (!content.some((part) => part?.type === "input_image")) return textOf(content);
  return content.map((part) => {
    if (part.type === "input_image") {
      return { type: "image_url", image_url: { url: part.image_url || dataURLOf(part.source) } };
    }
    return { type: "text", text: part.text || "" };
  });
}

export function chatToResponses(payload, model, id) {
  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const output = [];
  if (message.content) {
    output.push({
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: message.content, annotations: [] }]
    });
  }
  for (const call of message.tool_calls || []) {
    output.push({
      id: `fc_${call.id || id}`,
      type: "function_call",
      status: "completed",
      call_id: call.id || id,
      name: call.function?.name || "tool",
      arguments: call.function?.arguments || "{}"
    });
  }
  return {
    id: id.startsWith("resp_") ? id : `resp_${id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: message.content || "",
    usage: {
      input_tokens: payload?.usage?.prompt_tokens || 0,
      output_tokens: payload?.usage?.completion_tokens || 0,
      total_tokens: payload?.usage?.total_tokens || 0
    },
    error: null,
    incomplete_details: null
  };
}

export function responsesStreamFromChat(chunkText, state, model) {
  const out = [];
  let responseId = `resp_${state.id}`;
  for (const payload of parseSSEData(chunkText)) {
    if (payload.error) {
      const message = typeof payload.error === "string"
        ? payload.error
        : payload.error.message || "upstream stream failed";
      throw Object.assign(new Error(message), { status: 502 });
    }
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (payload.id) responseId = payload.id.startsWith("resp_") ? payload.id : `resp_${payload.id}`;
    if (!state.started) {
      state.started = true;
      state.items = [];
      state.nextOutputIndex = 0;
      out.push(sseData({
        type: "response.created",
        response: {
          id: responseId,
          object: "response",
          status: "in_progress",
          model,
          output: []
        }
      }));
    }
    if (delta.content) {
      const message = ensureResponsesMessage(out, state);
      out.push(sseData({
        type: "response.output_text.delta",
        item_id: message.itemId,
        output_index: message.outputIndex,
        content_index: 0,
        delta: delta.content
      }));
      state.text = `${state.text || ""}${delta.content}`;
    }
    for (const call of delta.tool_calls || []) {
      emitResponsesTool(out, state, call);
    }
    if (choice.finish_reason && !state.finished) {
      state.finished = true;
      state.finishReason = choice.finish_reason;
      finishResponsesItems(out, state);
      out.push(sseData(responseCompleted(state, model, payload.usage, responseId)));
    }
  }
  return out.join("");
}

export function responsesStreamError(error) {
  const message = typeof error === "string" ? error : error?.message || "upstream stream failed";
  return sseData({
    type: "error",
    code: "server_error",
    message,
    param: null
  });
}

export function responsesObjectFromStream(chunkText, state, model) {
  const events = parseSSEData(chunkText);
  const whole = events.find((payload) => payload?.object === "response");
  if (whole) return whole;
  const output = [];
  let text = "";
  const calls = new Map();
  let usage = {};
  for (const payload of events) {
    if (payload.error) {
      const message = typeof payload.error === "string"
        ? payload.error
        : payload.error.message || "upstream stream failed";
      throw Object.assign(new Error(message), { status: 502 });
    }
    if (payload.usage) usage = payload.usage;
    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) text += delta.content;
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? 0;
      let call = calls.get(index);
      if (!call) {
        call = {
          id: part.id || `call_${state.id}_${index}`,
          name: part.function?.name || "tool",
          arguments: ""
        };
        calls.set(index, call);
      }
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name = part.function.name;
      call.arguments += part.function?.arguments || "";
    }
    if (choice.finish_reason) usage = payload.usage || usage;
  }
  if (text) {
    output.push({
      id: `msg_${state.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  for (const call of calls.values()) {
    output.push({
      id: `fc_${call.id}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments || "{}"
    });
  }
  return {
    id: `resp_${state.id}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output,
    output_text: text,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0
    },
    error: null,
    incomplete_details: null
  };
}

function emitResponsesTool(out, state, call) {
  const index = call.index ?? 0;
  state.calls ||= new Map();
  let item = state.calls.get(index);
  if (!item) {
    item = {
      itemId: `fc_${call.id || `${state.id}_${index}`}`,
      callId: call.id || `call_${state.id}_${index}`,
      name: call.function?.name || "tool",
      outputIndex: state.nextOutputIndex++,
      arguments: ""
    };
    state.calls.set(index, item);
    state.items.push({ type: "function_call", value: item });
    out.push(sseData({
      type: "response.output_item.added",
      output_index: item.outputIndex,
      item: {
        id: item.itemId,
        type: "function_call",
        status: "in_progress",
        call_id: item.callId,
        name: item.name,
        arguments: ""
      }
    }));
  }
  if (call.id) item.callId = call.id;
  if (call.function?.name) item.name = call.function.name;
  if (call.function?.arguments) {
    item.arguments += call.function.arguments;
    out.push(sseData({
      type: "response.function_call_arguments.delta",
      item_id: item.itemId,
      output_index: item.outputIndex,
      delta: call.function.arguments
    }));
  }
}

function ensureResponsesMessage(out, state) {
  if (state.message) return state.message;
  state.message = {
    itemId: `msg_${state.id}`,
    outputIndex: state.nextOutputIndex++
  };
  state.items.push({ type: "message", value: state.message });
  out.push(sseData({
    type: "response.output_item.added",
    output_index: state.message.outputIndex,
    item: {
      id: state.message.itemId,
      type: "message",
      role: "assistant",
      status: "in_progress",
      content: []
    }
  }));
  return state.message;
}

function finishResponsesItems(out, state) {
  for (const entry of state.items || []) {
    if (entry.type === "function_call") {
      const call = entry.value;
      out.push(sseData({
        type: "response.function_call_arguments.done",
        item_id: call.itemId,
        output_index: call.outputIndex,
        call_id: call.callId,
        arguments: call.arguments || "{}"
      }));
      out.push(sseData({
        type: "response.output_item.done",
        output_index: call.outputIndex,
        item: {
          id: call.itemId,
          type: "function_call",
          status: "completed",
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments || "{}"
        }
      }));
      continue;
    }
    const message = entry.value;
    out.push(sseData({
      type: "response.output_text.done",
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      text: state.text || ""
    }));
    out.push(sseData({
      type: "response.output_item.done",
      output_index: message.outputIndex,
      item: {
        id: message.itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: state.text || "", annotations: [] }]
      }
    }));
  }
}

function responseCompleted(state, model, usage, responseId = `resp_${state.id}`) {
  const incomplete = state.finishReason === "length";
  const output = [];
  for (const entry of state.items || []) {
    if (entry.type === "message") {
      const message = entry.value;
      output.push({
        id: message.itemId,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: state.text || "", annotations: [] }]
      });
      continue;
    }
    const item = entry.value;
    output.push({
      id: item.itemId,
      type: "function_call",
      status: "completed",
      call_id: item.callId,
      name: item.name,
      arguments: item.arguments || "{}"
    });
  }
  return {
    type: incomplete ? "response.incomplete" : "response.completed",
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: incomplete ? "incomplete" : "completed",
      model,
      output,
      output_text: state.text || "",
      error: null,
      incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
      usage: {
        input_tokens: usage?.prompt_tokens || 0,
        output_tokens: usage?.completion_tokens || 0,
        total_tokens: usage?.total_tokens || 0
      }
    }
  };
}
