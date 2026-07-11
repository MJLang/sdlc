import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const bumpType = process.argv[2];

if (bumpType !== "minor" && bumpType !== "patch") {
  throw new Error("Usage: node scripts/bump-version.mjs <minor|patch>");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageJson.version);

if (!versionMatch) {
  throw new Error(`package.json has an invalid version: ${packageJson.version}`);
}

const skillPaths = (await readdir(resolve(root, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(root, "skills", entry.name, "SKILL.md"));
const skills = await Promise.all(
  skillPaths.map(async (path) => ({ path, contents: await readFile(path, "utf8") })),
);
const frontmatterVersion = /^(---\n[\s\S]*?^version:\s*)([^\n]+)(\n)/m;

for (const skill of skills) {
  const match = skill.contents.match(frontmatterVersion);
  if (!match) {
    throw new Error(`Missing frontmatter version in ${skill.path}`);
  }
  if (match[2].trim() !== packageJson.version) {
    throw new Error(
      `Version mismatch in ${skill.path}: expected ${packageJson.version}, found ${match[2].trim()}`,
    );
  }
}

const [, major, minor, patch] = versionMatch;
const nextVersion =
  bumpType === "minor"
    ? `${major}.${Number(minor) + 1}.0`
    : `${major}.${minor}.${Number(patch) + 1}`;

packageJson.version = nextVersion;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
await Promise.all(
  skills.map(({ path, contents }) =>
    writeFile(path, contents.replace(frontmatterVersion, `$1${nextVersion}$3`)),
  ),
);

console.log(`Bumped ${bumpType} version to ${nextVersion}`);
