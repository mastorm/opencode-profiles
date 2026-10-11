import assert from "node:assert/strict";
import { test } from "node:test";
import { formatModel } from "./display.ts";

test("short profile model labels preserve providers and reasoning variants", () => {
  assert.equal(formatModel("openai/gpt-6.1-sol"), "OpenAI / Sol");
  assert.equal(formatModel("github-copilot/gpt-6.1-sol"), "GitHub Copilot / Sol");
  assert.equal(formatModel("openai/gpt-6-luna#max"), "OpenAI / Luna Max");
});

test("custom providers and models use catalog names", () => {
  assert.equal(formatModel("team/reasoner#high", {
    providers: [{ id: "team", name: "Team AI" }],
    models: [{ providerID: "team", id: "reasoner", name: "Custom Reasoner" }],
  }), "Team AI / Custom Reasoner High");
});
