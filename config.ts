import { z } from "zod";

// Preserve metadata from the original local plugin when migrating.
export const metadataKey = "opencode.session-modes";
export const agentKey = `${metadataKey}.agent`;

const key = z.string().min(1).refine((value) => !["__proto__", "constructor", "prototype"].includes(value), "Reserved key");
export const ModelSchema = z.string().regex(/^[^\s/#]+\/[^\s#]+(?:#[^\s#]+)?$/, "Expected provider/model or provider/model#variant");
export const ModeSchema = z.strictObject({
  label: z.string().min(1).max(24).regex(/^[\w -]+$/, "Use a short printable label"),
  models: z.object({ plan: ModelSchema, build: ModelSchema }).catchall(ModelSchema),
});
export const SettingsSchema = z.strictObject({
  defaultMode: key.optional(),
  modes: z.record(key, ModeSchema).refine((modes) => Object.keys(modes).length > 0, "Configure at least one profile"),
}).transform((settings) => ({ ...settings, defaultMode: settings.defaultMode ?? Object.keys(settings.modes)[0] }))
  .refine((settings) => Object.hasOwn(settings.modes, settings.defaultMode), { path: ["defaultMode"], message: "defaultMode must name a configured profile" });

export type Mode = z.output<typeof ModeSchema>;
export type Settings = z.output<typeof SettingsSchema>;

export function parseModel(value: string) {
  ModelSchema.parse(value);
  const [reference, variant] = value.split("#");
  const slash = reference.indexOf("/");
  return { providerID: reference.slice(0, slash), id: reference.slice(slash + 1), ...(variant ? { variant } : {}) };
}

export function parseSettings(options: unknown): Settings {
  return SettingsSchema.parse(options);
}

export function savedMode(metadata: Record<string, unknown> | undefined, settings: Settings) {
  const value = metadata?.[metadataKey];
  return typeof value === "string" && Object.hasOwn(settings.modes, value) ? value : undefined;
}

export function nextMode(current: string | undefined, settings: Settings) {
  const ids = Object.keys(settings.modes);
  return current && ids.includes(current) ? ids[(ids.indexOf(current) + 1) % ids.length] : settings.defaultMode;
}
