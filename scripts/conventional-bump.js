#!/usr/bin/env node
"use strict";

// Walks commits since the latest `v*` tag and decides whether to bump the
// package.json version. We follow a minimal subset of Conventional Commits:
//
//   feat:         -> minor bump     (new user-visible feature)
//   fix: / perf:  -> patch bump     (bugfix / perf tune)
//   <type>!:      -> major bump     (trailing "!" marks a breaking change)
//   BREAKING CHANGE: ... in body -> major bump
//   chore / docs / refactor / test / ci / build / style / revert -> ignored
//
// A scope in parens ("feat(upload): ...") is allowed and ignored.
//
// If no bump-worthy commits are found (or HEAD is already at a release
// commit we made earlier) the script exits 0 without emitting any output,
// which lets the workflow no-op cleanly.
//
// Output is written to $GITHUB_OUTPUT so the calling workflow can decide
// whether to commit + tag:
//
//   bump=major|minor|patch
//   new_version=X.Y.Z
//   notes<<EOF
//   ... markdown release notes ...
//   EOF
//
// We intentionally avoid pulling in any npm deps (no conventional-changelog,
// no standard-version) so the script stays auditable and dependency-free.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function shSafe(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch (_err) {
    return "";
  }
}

function parseSemver(v) {
  const m = String(v || "").replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-[^+]*)?(?:\+.*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function bumpVersion(v, kind) {
  const out = { ...v };
  if (kind === "major") {
    out.major += 1;
    out.minor = 0;
    out.patch = 0;
  } else if (kind === "minor") {
    out.minor += 1;
    out.patch = 0;
  } else {
    out.patch += 1;
  }
  return out;
}

// Classify a single commit. Returns { bump, category } or null.
//   bump     = "major" | "minor" | "patch" | null
//   category = "feat" | "fix" | "perf" | "other"
const TYPE_RE = /^(feat|fix|perf|docs|style|refactor|test|chore|build|ci|revert)(\([^)]+\))?(!)?:\s*(.+)/i;
function classify(subject, body) {
  const m = TYPE_RE.exec(subject);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const bang = !!m[3];
  const hasBreakingFooter = /(^|\n)BREAKING[- ]CHANGE:/.test(body || "");
  if (bang || hasBreakingFooter) return { bump: "major", category: type };
  if (type === "feat") return { bump: "minor", category: "feat" };
  if (type === "fix") return { bump: "patch", category: "fix" };
  if (type === "perf") return { bump: "patch", category: "perf" };
  return { bump: null, category: "other" };
}

function rankBump(a, b) {
  const rank = { major: 3, minor: 2, patch: 1 };
  if (!a) return b;
  if (!b) return a;
  return rank[a] >= rank[b] ? a : b;
}

function getCommitsSince(ref) {
  // Use a unique record separator so we can safely parse multiline bodies.
  const SEP = "<<<DEVIN_COMMIT_SEP>>>";
  const FMT = `%H%n%s%n%b${SEP}`;
  const range = ref ? `${ref}..HEAD` : "HEAD";
  const raw = shSafe(`git log ${range} --pretty=format:"${FMT}"`);
  if (!raw) return [];
  return raw
    .split(SEP)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((entry) => {
      const lines = entry.split("\n");
      const hash = lines[0];
      const subject = lines[1] || "";
      const body = lines.slice(2).join("\n");
      return { hash, subject, body };
    });
}

function writeOutput(kv) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    // Local / dry-run mode: print to stdout in the same format so humans can inspect.
    for (const [k, v] of Object.entries(kv)) {
      if (v.includes("\n")) {
        process.stdout.write(`${k}<<EOF\n${v}\nEOF\n`);
      } else {
        process.stdout.write(`${k}=${v}\n`);
      }
    }
    return;
  }
  const chunks = [];
  for (const [k, v] of Object.entries(kv)) {
    if (v.includes("\n")) {
      chunks.push(`${k}<<EOF\n${v}\nEOF\n`);
    } else {
      chunks.push(`${k}=${v}\n`);
    }
  }
  fs.appendFileSync(out, chunks.join(""));
}

function main() {
  const root = path.resolve(__dirname, "..");
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const pkgVersion = pkg.version;

  // Find the highest v* tag by semver, not the most-recent-by-commit.
  // `git describe --abbrev=0` breaks when two tags point to the same
  // commit (e.g. v0.3.0 and v0.4.0 both on the same merge commit): it
  // returns the lexicographically-smaller one and the bump then tries to
  // recreate an already-existing tag.
  //
  // `for-each-ref --sort=-version:refname` uses git's built-in version
  // sorter, so "v0.10.0" > "v0.9.0" > "v0.4.0" > "v0.3.0" as expected.
  // Falls back to empty (full history scan) if no v* tags exist yet.
  const lastTag = shSafe(
    "git for-each-ref --sort=-version:refname --count=1 --format=\"%(refname:short)\" \"refs/tags/v*\""
  );

  // Bump off the latest tag, not package.json. Previously we bumped
  // package.json's recorded version, which could collide with an already-
  // published tag if package.json lagged behind (e.g. the bot's earlier
  // `chore(release)` commits never landed on main but tags did). Using the
  // tag as the baseline guarantees the computed next version is unique
  // against the tag namespace. Falls back to package.json if no v* tag
  // exists yet (first release).
  const parsedTag = parseSemver(lastTag);
  const parsedPkg = parseSemver(pkgVersion);
  const parsedCurrent = parsedTag || parsedPkg;
  const currentVersion = parsedTag ? formatSemver(parsedTag) : pkgVersion;

  if (!parsedCurrent) {
    process.stderr.write(`[conventional-bump] neither tag ("${lastTag}") nor package.json ("${pkgVersion}") is a clean semver; bailing.\n`);
    process.exit(0);
  }

  const commits = getCommitsSince(lastTag);

  if (commits.length === 0) {
    process.stderr.write(`[conventional-bump] no new commits since ${lastTag || "repo root"}; nothing to do.\n`);
    return;
  }

  const features = [];
  const fixes = [];
  const perf = [];
  const breaking = [];
  let chosen = null;

  for (const c of commits) {
    const result = classify(c.subject, c.body);
    if (!result) continue;
    if (result.bump === "major") breaking.push(c);
    else if (result.category === "feat") features.push(c);
    else if (result.category === "fix") fixes.push(c);
    else if (result.category === "perf") perf.push(c);
    chosen = rankBump(chosen, result.bump);
  }

  if (!chosen) {
    process.stderr.write(`[conventional-bump] ${commits.length} commit(s) since ${lastTag || "repo root"} but none are feat/fix/perf; no bump.\n`);
    return;
  }

  const next = bumpVersion(parsedCurrent, chosen);
  const nextVersion = formatSemver(next);

  const short = (h) => h.slice(0, 7);
  const renderSection = (title, items) => {
    if (items.length === 0) return "";
    const lines = items.map((c) => {
      const m = TYPE_RE.exec(c.subject);
      const scope = m && m[2] ? m[2] : "";
      const desc = m ? m[4] : c.subject;
      return `- ${scope ? `**${scope.replace(/[()]/g, "")}**: ` : ""}${desc} (${short(c.hash)})`;
    });
    return `### ${title}\n${lines.join("\n")}\n`;
  };

  const notes = [
    renderSection("BREAKING CHANGES", breaking),
    renderSection("Features", features),
    renderSection("Bug Fixes", fixes),
    renderSection("Performance", perf),
  ].filter(Boolean).join("\n").trim();

  writeOutput({
    bump: chosen,
    current_version: currentVersion,
    new_version: nextVersion,
    notes: notes || "(no user-visible changes summarized)",
  });

  process.stderr.write(
    `[conventional-bump] ${commits.length} commit(s) since ${lastTag || "repo root"}: ${breaking.length} breaking, ${features.length} feat, ${fixes.length} fix, ${perf.length} perf -> bump ${chosen} -> v${nextVersion}\n`
  );
}

main();
