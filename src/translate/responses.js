import { textOf, dataURLOf, sseData } from "./common.js";

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
  for (const raw of chunkText.split(/\r?\n/)) {
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
        type: "response.created",
        response: {
          id: `resp_${state.id}`,
          object: "response",
          status: "in_progress",
          model,
          output: []
        }
      }));
      out.push(sseData({
        type: "response.output_item.added",
        output_index: 0,
        item: { id: `msg_${state.id}`, type: "message", role: "assistant", status: "in_progress", content: [] }
      }));
    }
    if (delta.content) {
      out.push(sseData({
        type: "response.output_text.delta",
        item_id: `msg_${state.id}`,
        output_index: 0,
        content_index: 0,
        delta: delta.content
      }));
      state.text = `${state.text || ""}${delta.content}`;
    }
    if (choice.finish_reason && !state.finished) {
      state.finished = true;
      out.push(sseData({
        type: "response.completed",
        response: {
          id: `resp_${state.id}`,
          object: "response",
          status: "completed",
          model,
          output: [{
            id: `msg_${state.id}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: state.text || "", annotations: [] }]
          }],
          usage: {
            input_tokens: payload.usage?.prompt_tokens || 0,
            output_tokens: payload.usage?.completion_tokens || 0,
            total_tokens: payload.usage?.total_tokens || 0
          }
        }
      }));
    }
  }
  return out.join("");
}
