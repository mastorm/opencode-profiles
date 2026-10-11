import { parseModel } from "./config.ts";

interface Catalog {
  providers?: readonly { id: string; name: string }[];
  models?: readonly { providerID: string; id: string; name: string }[];
}

export function formatModel(value: string, catalog: Catalog = {}) {
  const model = parseModel(value);
  const provider = catalog.providers?.find((item) => item.id === model.providerID)?.name
    ?? ({ openai: "OpenAI", "github-copilot": "GitHub Copilot" } as Record<string, string>)[model.providerID]
    ?? model.providerID;
  const name = catalog.models?.find((item) => item.providerID === model.providerID && item.id === model.id)?.name;
  const short = name?.replace(/^GPT-[\d.]+\s+/i, "")
    ?? model.id.replace(/^gpt-[\d.]+-/i, "").replace(/(^|[-_])([a-z])/g, (_, prefix: string, letter: string) => `${prefix ? " " : ""}${letter.toUpperCase()}`);
  const variant = model.variant ? ` ${model.variant[0].toUpperCase()}${model.variant.slice(1)}` : "";
  return `${provider} / ${short}${variant}`;
}
