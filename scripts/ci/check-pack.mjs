// Fails if the published tarball contains anything it shouldn't, or is missing what `exports` promises.
// Run after `npm run build`:  node scripts/ci/check-pack.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const MAX_TARBALL_BYTES = 1_500_000;
const MAX_UNPACKED_BYTES = 6_000_000;

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files = pack.files.map((f) => f.path);
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];

// Only built output and the three files every package ships. Never source, tests, CI config, env files or keys.
const allowed = (path) => path.startsWith("dist/") || ["LICENSE", "README.md", "package.json"].includes(path);
for (const path of files) {
  if (!allowed(path)) problems.push(`unexpected file in the tarball: ${path}`);
  if (/(^|\/)\.env|\.(pem|key|p12)$|(^|\/)id_rsa/.test(path)) problems.push(`looks like a secret: ${path}`);
}

// Every file `exports` points at must be in the tarball.
const targets = new Set();
const collect = (value) => {
  if (typeof value === "string") targets.add(value.replace(/^\.\//, ""));
  else if (value && typeof value === "object") Object.values(value).forEach(collect);
};
collect(manifest.exports);
for (const target of targets) if (!files.includes(target)) problems.push(`exports points at ${target}, which is not in the tarball`);

if (pack.size > MAX_TARBALL_BYTES) problems.push(`tarball is ${pack.size} bytes (limit ${MAX_TARBALL_BYTES})`);
if (pack.unpackedSize > MAX_UNPACKED_BYTES) problems.push(`unpacked size is ${pack.unpackedSize} bytes (limit ${MAX_UNPACKED_BYTES})`);

console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes packed, ${pack.unpackedSize} bytes unpacked`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log("tarball contents OK");
