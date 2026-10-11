import assert from "node:assert/strict";
import { test } from "node:test";
import plugin from "./index.ts";
import { agentKey, metadataKey } from "./config.ts";

const options = {
  defaultMode: "private",
  modes: {
    private: { label: "PRIVATE", models: { plan: "openai/plan-model", build: "openai/build-model" } },
    work: { label: "WORK", models: { plan: "github-copilot/plan-model", build: "github-copilot/build-model" } },
  },
};

async function harness() {
  const sessions: Record<string, any> = {
    ses_a: { agent: "plan", model: { providerID: "other", id: "original" }, metadata: { user: "preserved" } },
    ses_b: { agent: "build", model: { providerID: "other", id: "untouched" }, metadata: {} },
  };
  let handlers: Record<string, (input: any) => Promise<any>> = {};
  let promptHook: (event: any) => Promise<void> = async () => {};
  let unavailable = false;
  let failUpdate = false;
  let history: unknown[] = [];
  const context = {
    options,
    rpc: { register: async (_: unknown, implementation: Record<string, (input: any, call: any) => Promise<any>>) => {
      for (const [name, run] of Object.entries(implementation)) {
        handlers[name] = (input) => run(input, { error: (_: string, message: string) => new Error(message) });
      }
    } },
    model: { list: async () => ({ data: unavailable ? [] : ["openai", "github-copilot"].flatMap(providerID =>
      ["plan-model", "build-model"].map(id => ({ providerID, id, enabled: true, variants: [] }))) }) },
    session: {
      get: async ({ sessionID }: any) => structuredClone(sessions[sessionID]),
      switchModel: async ({ sessionID, model }: any) => { sessions[sessionID].model = model; },
      update: async ({ sessionID, metadata }: any) => {
        if (failUpdate) throw new Error("Persistence failed");
        sessions[sessionID].metadata = metadata;
      },
      context: async () => history,
      hook: async (_: string, hook: typeof promptHook) => { promptHook = hook; },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];
  await plugin.setup(context);
  return { sessions, handlers, prompt: (id: string) => promptHook({ sessionID: id }),
    unavailable: () => { unavailable = true; }, failUpdate: () => { failUpdate = true; },
    existing: () => { history = [{}]; } };
}

test("switches one session, preserves unrelated metadata and reconciles its agent", async () => {
  const h = await harness();
  await h.handlers.select({ sessionID: "ses_a", mode: "work" });
  assert.deepEqual(h.sessions.ses_a.model, { providerID: "github-copilot", id: "plan-model" });
  assert.deepEqual(h.sessions.ses_a.metadata, { user: "preserved", [metadataKey]: "work", [agentKey]: "plan" });
  assert.equal(h.sessions.ses_b.model.id, "untouched");
  h.sessions.ses_a.agent = "build";
  await h.handlers.reconcile({ sessionID: "ses_a" });
  assert.equal(h.sessions.ses_a.model.id, "build-model");
});

test("failed validation does not change model or mode", async () => {
  const h = await harness();
  h.unavailable();
  await assert.rejects(h.handlers.select({ sessionID: "ses_a", mode: "work" }), /unavailable/);
  assert.equal(h.sessions.ses_a.model.id, "original");
  assert.equal(h.sessions.ses_a.metadata[metadataKey], undefined);
});

test("failed persistence restores the old model", async () => {
  const h = await harness();
  h.failUpdate();
  await assert.rejects(h.handlers.select({ sessionID: "ses_a", mode: "work" }), /Persistence failed/);
  assert.equal(h.sessions.ses_a.model.id, "original");
});

test("prompt admission applies the saved agent model", async () => {
  const h = await harness();
  await h.handlers.select({ sessionID: "ses_a", mode: "work" });
  h.sessions.ses_a.agent = "build";
  await h.prompt("ses_a");
  assert.deepEqual(h.sessions.ses_a.model, { providerID: "github-copilot", id: "build-model" });
});

test("manual models survive prompts, reconcile, and session initialization", async () => {
  const h = await harness();
  await h.handlers.select({ sessionID: "ses_a", mode: "work" });
  const manual = { providerID: "other", id: "my-choice", variant: "high" };
  h.sessions.ses_a.model = manual;
  await h.prompt("ses_a");
  await h.handlers.reconcile({ sessionID: "ses_a" });
  await h.handlers.initialize({ sessionID: "ses_a" });
  assert.deepEqual(h.sessions.ses_a.model, manual);
  assert.equal(h.sessions.ses_a.metadata[metadataKey], "work");
  await h.handlers.select({ sessionID: "ses_a", mode: "work" });
  assert.equal(h.sessions.ses_a.model.id, "plan-model");
});

test("Zod validates RPC input before changing sessions", async () => {
  const h = await harness();
  await assert.rejects(h.handlers.select({ sessionID: "bad", mode: "work" }));
  await assert.rejects(h.handlers.select({ sessionID: "ses_a", mode: "work", unexpected: true }));
  assert.equal(h.sessions.ses_a.model.id, "original");
});

test("migrated profiles preserve their selected model", async () => {
  const h = await harness();
  h.sessions.ses_a.metadata[metadataKey] = "work";
  await h.prompt("ses_a");
  assert.equal(h.sessions.ses_a.model.id, "original");
  assert.equal(h.sessions.ses_a.metadata[agentKey], "plan");
});

test("unmapped agents retain their model; returning applies the mapped default", async () => {
  const h = await harness();
  await h.handlers.select({ sessionID: "ses_a", mode: "work" });
  h.sessions.ses_a.agent = "custom";
  h.sessions.ses_a.model = { providerID: "other", id: "custom" };
  await h.handlers.reconcile({ sessionID: "ses_a" });
  assert.equal(h.sessions.ses_a.model.id, "custom");
  h.sessions.ses_a.agent = "plan";
  await h.handlers.reconcile({ sessionID: "ses_a" });
  assert.equal(h.sessions.ses_a.model.id, "plan-model");
});

test("empty sessions default to private; unselected existing sessions stay untouched", async () => {
  const h = await harness();
  await h.prompt("ses_a");
  assert.equal(h.sessions.ses_a.metadata[metadataKey], "private");
  assert.equal(h.sessions.ses_a.model.providerID, "openai");
  h.existing();
  await h.prompt("ses_b");
  assert.equal(h.sessions.ses_b.model.id, "untouched");
  assert.equal(h.sessions.ses_b.metadata[metadataKey], undefined);
});
