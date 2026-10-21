const DEFAULT_MODELS = [
  { id: "auto", name: "Auto", context: 168000 },
  { id: "hy3", name: "Hy3", context: 192000 },
  { id: "hy3-x", name: "Hy3-X", context: 192000 }
];

export function fallbackModels() {
  return DEFAULT_MODELS.map((model) => ({
    ...model,
    object: "model",
    owned_by: "workbuddy"
  }));
}

export function modelList(models = fallbackModels()) {
  return {
    object: "list",
    data: models.map((model) => ({
      ...model,
      id: model.id,
      object: "model",
      owned_by: model.owned_by || "workbuddy",
      display_name: model.name || model.id
    }))
  };
}
