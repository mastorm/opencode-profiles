import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataKey, nextMode, parseModel, parseSettings, savedMode } from "./config.ts";

export const options = {
  defaultMode: "private",
  modes: {
    private: { label: "PRIVATE", models: { plan: "openai/gpt-6.1-sol", build: "openai/gpt-6.1-sol" } },
    work: { label: "WORK", models: { plan: "github-copilot/gpt-6.1-sol", build: "github-copilot/gpt-6.1-sol" } },
  },
};

test("model references support variants", () => {
  assert.deepEqual(parseModel("openai/gpt-6.1-sol#high"), { providerID: "openai", id: "gpt-6.1-sol", variant: "high" });
  assert.throws(() => parseModel("sol"));
});

test("cycles in configured order and validates defaults", () => {
  const settings = parseSettings(options);
  assert.equal(nextMode("private", settings), "work");
  assert.equal(nextMode("work", settings), "private");
  assert.equal(nextMode(undefined, settings), "private");
  assert.throws(() => parseSettings({ ...options, defaultMode: "missing" }));
  assert.throws(() => parseSettings({ modes: { x: { label: "X", models: { build: "openai/sol" } } } }));
});

test("saved mode is session-local and unknown providers are custom", () => {
  const settings = parseSettings(options);
  assert.equal(savedMode({ [metadataKey]: "work" }, settings), "work");
  assert.equal(savedMode({ [metadataKey]: "removed" }, settings), undefined);
});

test("extra profiles cycle and distinguish models sharing the same provider", () => {
  const settings = parseSettings({ ...options, modes: {
    ...options.modes,
    "dumb-task": { label: "DUMB TASK", models: { plan: "openai/gpt-6.1-sol", build: "openai/gpt-6-luna#max" } },
  } });
  assert.deepEqual(Object.keys(settings.modes), ["private", "work", "dumb-task"]);
  assert.equal(nextMode("work", settings), "dumb-task");
  assert.equal(nextMode("dumb-task", settings), "private");
});

test("Zod rejects malformed settings, unknown options, and model references", () => {
  assert.throws(() => parseSettings({ modes: {} }));
  assert.throws(() => parseSettings({ ...options, typo: true }));
  assert.throws(() => parseModel("openai/sol#"));
  assert.throws(() => parseModel("openai/sol high"));
  assert.equal(parseSettings({ modes: options.modes }).defaultMode, "private");
});
