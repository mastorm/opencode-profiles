import { Plugin } from "@opencode/plugin";
import { agentKey, metadataKey, parseModel, parseSettings, savedMode } from "./config.ts";
import { Modes, SelectInput, SessionInput } from "./rpc.ts";

export default Plugin.define({
  id: "opencode-session-profiles",
  async setup(ctx) {
    const settings = parseSettings(ctx.options);
    const locks = new Map<string, Promise<unknown>>();

    async function exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
      const previous = locks.get(id) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(run);
      locks.set(id, next);
      try {
        return await next;
      } finally {
        if (locks.get(id) === next) locks.delete(id);
      }
    }

    async function validate(value: string) {
      const ref = parseModel(value);
      const { data: models } = await ctx.model.list();
      const model = models.find((item) => item.providerID === ref.providerID && item.id === ref.id && item.enabled);
      if (!model) throw new Error(`Mode model is unavailable: ${value}. Connect its provider first.`);
      if (ref.variant && !model.variants.some((item) => item.id === ref.variant)) {
        throw new Error(`Mode variant is unavailable: ${value}`);
      }
      return ref;
    }

    async function reconcile(sessionID: string) {
      const session = await ctx.session.get({ sessionID });
      const mode = savedMode(session.metadata, settings);
      if (!mode) return;
      const agent = session.agent ?? "build";
      // Profiles are defaults, not locks. Reapply only on an agent transition.
      if (session.metadata?.[agentKey] === agent) return;
      const value = settings.modes[mode].models[agent];
      if (!value) {
        await ctx.session.update({ sessionID, metadata: { ...session.metadata, [agentKey]: agent } });
        return;
      }
      const model = parseModel(value);
      await validate(value);
      await ctx.session.switchModel({ sessionID, model });
      await ctx.session.update({ sessionID, metadata: { ...session.metadata, [agentKey]: agent } });
    }

    async function selectMode(sessionID: string, mode: string) {
      const profile = Object.hasOwn(settings.modes, mode) ? settings.modes[mode] : undefined;
      if (!profile) throw new Error(`Unknown mode: ${mode}`);
      const session = await ctx.session.get({ sessionID });
      const value = profile.models[session.agent ?? "build"];
      if (!value) throw new Error(`Mode ${mode} has no model for agent ${session.agent}`);
      // Validate both primary agents before committing any session changes.
      await Promise.all(Object.values(profile.models).map(validate));
      await ctx.session.switchModel({ sessionID, model: parseModel(value) });
      try {
        await ctx.session.update({ sessionID, metadata: { ...session.metadata, [metadataKey]: mode, [agentKey]: session.agent ?? "build" } });
      } catch (error) {
        if (session.model) await ctx.session.switchModel({ sessionID, model: session.model });
        throw error;
      }
      return { mode };
    }

    async function initialize(sessionID: string) {
      const session = await ctx.session.get({ sessionID });
      if (savedMode(session.metadata, settings)) {
        if (!session.metadata?.[agentKey]) {
          await ctx.session.update({ sessionID, metadata: { ...session.metadata, [agentKey]: session.agent ?? "build" } });
        }
        return;
      }
      const history = await ctx.session.context({ sessionID });
      if (history.length === 0) await selectMode(sessionID, settings.defaultMode);
    }

    await ctx.rpc.register(Modes, {
      settings: async () => settings,
      initialize: async (input, call) => {
        try {
          const { sessionID } = SessionInput.parse(input);
          await exclusive(sessionID, () => initialize(sessionID));
          return {};
        } catch (error) {
          throw call.error("profile_error", error instanceof Error ? error.message : String(error), {});
        }
      },
      select: async (input, call) => {
        try {
          const { sessionID, mode } = SelectInput.parse(input);
          return await exclusive(sessionID, () => selectMode(sessionID, mode));
        } catch (error) {
          throw call.error("profile_error", error instanceof Error ? error.message : String(error), {});
        }
      },
      reconcile: async (input, call) => {
        try {
          const { sessionID } = SessionInput.parse(input);
          await exclusive(sessionID, () => reconcile(sessionID));
          return {};
        } catch (error) {
          throw call.error("profile_error", error instanceof Error ? error.message : String(error), {});
        }
      },
    });

    // Initialize new sessions and handle an immediate agent transition, but
    // never reset an explicitly chosen model on subsequent prompts.
    await ctx.session.hook("prompt", async ({ sessionID }) => {
      await exclusive(sessionID, async () => {
        await initialize(sessionID);
        await reconcile(sessionID);
      });
    });
  },
});
