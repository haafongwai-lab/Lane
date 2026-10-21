import { fallbackModels } from "./models.js";

/**
 * The provider boundary deliberately mirrors the small part of the
 * WorkBuddy plugin API Lane needs. Keeping it as an interface lets the
 * gateway be tested without a network or an account.
 */
export class ProviderUnavailable extends Error {
  constructor(message = "WorkBuddy is not configured") {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

export class FallbackProvider {
  constructor(models = fallbackModels()) {
    this.models = models;
  }

  async listModels() {
    return this.models;
  }

  async chat() {
    throw new ProviderUnavailable(
      "WorkBuddy is not ready. Run `lane doctor` and sign in through the plugin first."
    );
  }
}
