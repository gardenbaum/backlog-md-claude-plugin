import { readFileSync } from "node:fs";
import { join } from "node:path";

export const COMMAND_NAMES = ["decompose", "doctor", "finish", "next", "plan", "setup", "start", "verify"];

function parseTemplate(source, name) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Invalid command frontmatter: ${name}`);

  const description = match[1]
    .split(/\r?\n/)
    .find((line) => line.startsWith("description:"))
    ?.slice("description:".length)
    .trim();

  return { name, description, body: match[2].trim() };
}

export function loadCommandTemplate(pluginRoot, name) {
  const source = readFileSync(join(pluginRoot, "commands", `${name}.md`), "utf8");
  return parseTemplate(source, name);
}

export function loadCommandTemplates(pluginRoot) {
  return COMMAND_NAMES.map((name) => loadCommandTemplate(pluginRoot, name));
}

export function renderCommandTemplate(template, pluginRoot, args = "") {
  return template.body
    .replaceAll("$" + "{CLAUDE_PLUGIN_ROOT}", pluginRoot)
    .replaceAll("$" + "{OMP_PLUGIN_ROOT}", pluginRoot)
    .replaceAll("$ARGUMENTS", args);
}
