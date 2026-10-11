import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { SettingsSchema } from "./config.ts";

const empty = z.strictObject({});
export const SessionInput = z.strictObject({ sessionID: z.string().startsWith("ses") });
export const SelectInput = SessionInput.extend({ mode: z.string().min(1) });
export const StartInput = z.strictObject({ mode: z.string().min(1) });
const errors = { profile_error: empty };

export const Modes = Rpc.define({
  id: "opencode-session-profiles",
  events: {},
  methods: {
    settings: { input: empty, output: SettingsSchema },
    initialize: { input: SessionInput, output: empty, errors },
    select: { input: SelectInput, output: z.strictObject({ mode: z.string() }), errors },
    start: { input: StartInput, output: z.strictObject({ sessionID: z.string(), mode: z.string() }), errors },
    reconcile: { input: SessionInput, output: empty, errors },
  },
});
