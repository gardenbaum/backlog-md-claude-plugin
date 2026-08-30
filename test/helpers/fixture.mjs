import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../lib/proc.mjs";

export async function backlogAvailable() {
  const r = await run("backlog", ["--version"], { timeoutMs: 8000 });
  return r.ok;
}

export function parseCliJson(result, command) {
  if (!result.ok) {
    throw new Error(`backlog ${command} failed (${result.reason ?? "unknown"}): ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`backlog ${command} returned malformed JSON: ${result.stdout}`);
  }
}

/** Create a real Backlog.md project in a temp directory. */
export async function makeProject({ git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bcc-fixture-"));
  try {
    const cli = (args, timeoutMs = 20000) => run("backlog", args, { cwd: root, timeoutMs });

    if (git) {
      const gitInit = await run("git", ["init", "-q", "."], { cwd: root });
      if (!gitInit.ok) throw new Error(`git init failed: ${gitInit.stderr || gitInit.stdout}`);
      const gitEmail = await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
      if (!gitEmail.ok) {
        throw new Error(`git config user.email failed: ${gitEmail.stderr || gitEmail.stdout}`);
      }
      const gitName = await run("git", ["config", "user.name", "Test"], { cwd: root });
      if (!gitName.ok) throw new Error(`git config user.name failed: ${gitName.stderr || gitName.stdout}`);
    }
    const init = await cli(["init", "Fixture", "--defaults", ...(git ? [] : ["--no-git"])]);
    if (!init.ok) throw new Error(`backlog init failed: ${init.stderr || init.stdout}`);

    return {
      root,
      cli,
      async createTask(title, extra = []) {
        const created = await cli(["task", "create", title, ...extra]);
        if (!created.ok) throw new Error(`task create failed: ${created.stderr || created.stdout}`);
        const list = await cli(["task", "list", "--json"]);
        const tasks = parseCliJson(list, "task list --json").tasks;
        const matches = tasks.filter((t) => t.title === title);
        if (matches.length === 0) {
          throw new Error(
            `task create reported success but no task titled ${JSON.stringify(title)} was found in the list`,
          );
        }
        return matches[matches.length - 1].id;
      },
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
