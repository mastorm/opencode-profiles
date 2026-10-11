/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { nextMode, parseSettings, savedMode } from "./config.ts";
import { Modes } from "./rpc.ts";
import { formatModel } from "./display.ts";

export default Plugin.define({
  id: "opencode-session-profiles.tui",
  async setup(context) {
    const rpc = context.client.rpc(Modes);
    // V2.0.26's automatic TUI discovery does not forward the server plugin's
    // options. Read the effective config from its location-scoped server RPC.
    const settings = parseSettings(await rpc.settings({}, { location: context.location ?? context.data.location.default() }));
    const [busy, setBusy] = createSignal(false);
    const [profiles, setProfiles] = createSignal<Record<string, string | undefined>>({});
    const [launchMode, setLaunchMode] = createSignal(settings.defaultMode);
    const home = () => context.ui.router.current().type === "home";
    const sessionID = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const session = () => {
      const id = sessionID();
      return id ? context.data.session.get(id) : undefined;
    };
    const mode = createMemo(() => {
      const id = sessionID();
      if (home()) return launchMode();
      return (id ? profiles()[id] : undefined) ?? savedMode(session()?.metadata, settings);
    });
    async function refreshProfile(id: string) {
      const current = await context.client.session.get({ sessionID: id });
      setProfiles((state) => ({ ...state, [id]: savedMode(current.metadata, settings) }));
    }
    const modelLabel = (value: string) => formatModel(value, {
      providers: context.data.location.provider.list(session()?.location ?? context.location),
      models: context.data.location.model.list(session()?.location ?? context.location),
    });

    function failure(error: unknown) {
      context.ui.toast.show({ title: "Mode switch failed", message: error instanceof Error ? error.message : String(error), variant: "error" });
    }

    async function start() {
      if (!home() || busy()) return;
      setBusy(true);
      try {
        const created = await rpc.start({ mode: launchMode() }, { location: context.location ?? context.data.location.default() });
        setProfiles((state) => ({ ...state, [created.sessionID]: created.mode }));
        await context.data.session.sync(created.sessionID);
        context.ui.router.navigate({ type: "session", sessionID: created.sessionID });
        await refreshProfile(created.sessionID);
      } catch (error) {
        failure(error);
      } finally {
        setBusy(false);
      }
    }

    async function select(target: string) {
      const id = sessionID();
      if (busy()) return;
      if (!id) {
        if (!home()) return;
        setLaunchMode(target);
        return;
      }
      const queuedGeneration = context.data.session.pending.list(id).some((item) => item.type === "user" || item.type === "compaction");
      if (context.data.session.status(id) !== "idle" || queuedGeneration) {
        context.ui.toast.show({ message: "Wait for this session to finish before switching modes.", variant: "warning" });
        return;
      }
      setBusy(true);
      try {
        await rpc.select({ sessionID: id, mode: target }, { location: session()?.location ?? context.location });
        setProfiles((state) => ({ ...state, [id]: target }));
        await context.data.session.sync(id);
        await refreshProfile(id);
      } catch (error) {
        failure(error);
      } finally {
        setBusy(false);
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [
        {
          id: "session-modes.cycle",
          title: "Cycle profile",
          group: "Profiles",
          bind: "ctrl+shift+m",
          palette: true,
          enabled: () => (home() || !!sessionID()) && !busy(),
          run: () => select(nextMode(mode(), settings)),
        },
        {
          id: "session-modes.select",
          title: "Select profile",
          group: "Profiles",
          palette: true,
          slash: { name: "mode", arguments: true },
          enabled: () => (home() || !!sessionID()) && !busy(),
          async run(input) {
            const target = input?.trim() || await context.ui.dialog.select({
              title: "Profile",
              current: mode(),
              options: Object.entries(settings.modes).map(([value, profile]) => ({
                title: profile.label,
                value,
                description: `Build: ${modelLabel(profile.models.build)} · Plan: ${modelLabel(profile.models.plan)}`,
              })),
            });
            if (!target) return;
            if (!settings.modes[target]) {
              context.ui.toast.show({ message: `Unknown mode: ${target}`, variant: "error" });
              return;
            }
            await select(target);
          },
        },
        {
          id: "session-modes.start",
          title: "Start session with selected profile",
          group: "Profiles",
          palette: true,
          slash: { name: "start-profile" },
          enabled: () => home() && !busy(),
          run: start,
        },
      ],
    }));

    // Reopening a session does not reset its manually selected model.
    let previous = "";
    createEffect(() => {
      const current = session();
      const selected = (current ? profiles()[current.id] : undefined) ?? savedMode(current?.metadata, settings);
      const key = current ? `${current.id}:${selected ?? "unselected"}` : "";
      if (key === previous) return;
      previous = key;
      if (!current) return;
      const operation = rpc.initialize;
      void operation({ sessionID: current.id }, { location: current.location }).then(() => refreshProfile(current.id)).catch(failure);
    });

    // Let OpenCode finish its agent/model selection sequence before applying
    // that agent's profile default. Ordinary model selections never reapply it.
    let agentTimer: ReturnType<typeof setTimeout> | undefined;
    const applyAgentDefault = (event: { data: { sessionID: string } }) => {
      if (event.data.sessionID !== sessionID()) return;
      clearTimeout(agentTimer);
      agentTimer = setTimeout(() => {
        agentTimer = undefined;
        if (event.data.sessionID !== sessionID()) return;
        void rpc.reconcile({ sessionID: event.data.sessionID }, { location: session()?.location ?? context.location })
          .then(() => refreshProfile(event.data.sessionID)).catch(failure);
      }, 75);
    };
    const stopAgent = context.data.on("session.agent.selected", applyAgentDefault);
    const stopModel = context.data.on("session.model.selected", (event) => {
      if (event.data.sessionID !== sessionID()) return;
      if (agentTimer) applyAgentDefault(event);
    });
    const stopMetadata = context.data.on("session.metadata.updated", (event) => {
      setProfiles((state) => ({ ...state, [event.data.sessionID]: savedMode(event.data.metadata, settings) }));
    });

    const removeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: () => (
          <box flexDirection="column" gap={1} marginTop={1} flexShrink={0}>
            <text fg={context.theme.text.base}><b>Profiles</b></text>
            <For each={Object.entries(settings.modes)}>
              {([id, profile]) => (
                <box flexDirection="column" onMouseDown={() => void select(id)}>
                  <text fg={id === mode() ? context.theme.text.feedback.success.base : context.theme.text.base}>
                    <b>{profile.label}{id === mode() ? " (Current)" : ""}</b>
                  </text>
                  <box paddingLeft={2} flexDirection="column">
                    <text fg={context.theme.text.muted}>Build: {modelLabel(profile.models.build)}</text>
                    <text fg={context.theme.text.muted}>Plan: {modelLabel(profile.models.plan)}</text>
                  </box>
                </box>
              )}
            </For>
            <Show when={!mode()}><text fg={context.theme.text.muted}>No profile selected</text></Show>
          </box>
      ),
    });
    const removeHome = context.ui.slot({
      prepend: "home.footer",
      render: () => (
        <box flexDirection="column" gap={1} marginTop={1} marginBottom={1} flexShrink={0}>
          <text fg={context.theme.text.base}><b>Profiles</b></text>
          <box flexDirection="row" flexWrap="wrap" gap={2}>
            <For each={Object.entries(settings.modes)}>
              {([id, profile]) => (
                <text onMouseDown={() => void select(id)} fg={id === launchMode() ? context.theme.text.feedback.success.base : context.theme.text.base}>
                  <b>{profile.label}{id === launchMode() ? " (Current)" : ""}</b>
                </text>
              )}
            </For>
          </box>
          <box flexDirection="column">
            <text fg={context.theme.text.muted}>Build: {modelLabel(settings.modes[launchMode()].models.build)}</text>
            <text fg={context.theme.text.muted}>Plan: {modelLabel(settings.modes[launchMode()].models.plan)}</text>
          </box>
          <text fg={context.theme.text.feedback.success.base} onMouseDown={() => void start()}>
            <b>Start session with {settings.modes[launchMode()].label}</b> · /start-profile
          </text>
        </box>
      ),
    });
    return () => {
      stopAgent();
      clearTimeout(agentTimer);
      stopModel();
      stopMetadata();
      removeSidebar();
      removeHome();
    };
  },
});
