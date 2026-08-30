import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("the README documents every command the plugin ships", () => {
  for (const file of readdirSync(join(root, "commands"))) {
    const name = file.replace(/\.md$/, "");
    assert.ok(readme.includes(`/backlog-md:${name}`), `undocumented command: ${name}`);
  }
});

// The things a reader must not have to discover by surprise.
test("the README states the limitations that cannot be engineered away", () => {
  assert.match(readme, /--no-verify/);
  assert.match(readme, /own context window|Bash/); // agents could mutate; prompt-level only
  assert.match(readme, /concurrent sessions/i); // two sessions, one In Progress task
  assert.match(readme, /sed -i/); // the main agent's shell write is not guarded (BCC-24)
});

// The engines floor is a claim about a measured run (npm test passes on it),
// so the README must not drift away from package.json.
test("the README states the same minimum Node version as package.json engines", () => {
  const floor = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node.match(/\d+/)[0];
  assert.match(readme, new RegExp(`Node ${floor} or newer`));
});

test("the README documents OMP worker, mounted-tool, and command-shadow behavior", () => {
  assert.match(readme, /BACKLOG_MD_NODE/);
  assert.match(readme, /write xd:\/\/…/);
  assert.match(readme, /extension commands before file commands/);
  assert.match(readme, /unresolved\s+runtime failures/);
});

// The directories that dangled were the ones the README named as live. Any
// repository path it points at has to exist, whatever the path happens to be.
test("no repository path the README names dangles", () => {
  const dirs = "lib|hooks|commands|agents|skills|scripts|test|git|docs|\\.github|\\.claude-plugin";
  const paths = [...readme.matchAll(new RegExp(`\`((?:${dirs})/[\\w./-]+)\``, "g"))].map((m) => m[1]);
  for (const rel of paths) {
    assert.ok(existsSync(join(root, rel)), `README names a path that does not exist: ${rel}`);
  }
  // A regex that matches nothing would pass this test in silence.
  assert.ok(paths.length > 0, "the path scan found nothing to check");
});
