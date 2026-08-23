import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Every Markdown prompt the plugin ships, as repo-relative paths. */
export function promptFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = join(dir, entry);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (entry.endsWith(".md")) out.push(rel);
    }
  };
  walk("skills");
  walk("agents");
  walk("commands");
  return out.sort();
}

/** Split YAML-ish frontmatter without a YAML parser: `key: value` lines only. */
export function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fields: null, body: text };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: match[2] };
}

export const readPrompt = (rel) => readFileSync(join(root, rel), "utf8");
