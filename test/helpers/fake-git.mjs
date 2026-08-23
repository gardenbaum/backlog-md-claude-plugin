#!/usr/bin/env node
// Stand-in for the `git` binary, used only by unit tests exercising
// resolveIdentities' `git config` reads without a live repository.
const mode = process.env.FAKE_GIT_MODE || "identity";
const [, , command, key] = process.argv;

if (command !== "config") {
  process.stderr.write(`fake-git: unsupported command ${command}\n`);
  process.exit(2);
}

if (mode === "unset") {
  // Real `git config` exits non-zero for a key that is not set.
  process.exit(1);
}

if (mode === "identity") {
  if (key === "user.email") process.stdout.write("  friend@example.com  \n");
  else if (key === "user.name") process.stdout.write("Friend Name\n");
  else process.exit(1);
  process.exit(0);
}

process.stderr.write(`fake-git: unknown mode ${mode}\n`);
process.exit(2);
