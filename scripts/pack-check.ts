import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type PackageJson = {
  name?: unknown;
  devDependencies?: Record<string, unknown>;
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts = join(root, ".artifacts");
const archive = join(artifacts, "package.tgz");

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`package.json is missing ${name}`);
  }
  return value;
}

async function run(
  command: [string, ...string[]],
  cwd = root,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${stderr || stdout}`);
  }
  return stdout;
}

await rm(artifacts, { force: true, recursive: true });
await mkdir(artifacts, { recursive: true });
await run([
  process.execPath,
  "pm",
  "pack",
  "--ignore-scripts",
  "--filename",
  archive,
]);

const entries = new Set(
  (await run(["tar", "-tzf", archive]))
    .split("\n")
    .filter((entry) => entry.length > 0),
);
const requiredEntries = [
  "package/LICENSE",
  "package/README.md",
  "package/dist/session-tps-state.d.ts",
  "package/dist/session-tps-state.js",
  "package/dist/tui.d.ts",
  "package/dist/tui.js",
  "package/package.json",
];
for (const entry of requiredEntries) {
  if (!entries.has(entry)) throw new Error(`Package is missing ${entry}`);
}
for (const entry of entries) {
  if (/^package\/(?:node_modules|scripts|src|tests)\//.test(entry)) {
    throw new Error(`Package contains development file ${entry}`);
  }
  if (entry === "package/TODO.md") {
    throw new Error("Package contains local TODO.md");
  }
}

const packageJson = (await Bun.file(
  join(root, "package.json"),
).json()) as PackageJson;
const packageName = requiredString(packageJson.name, "name");
const pluginVersion = requiredString(
  packageJson.devDependencies?.["@opencode-ai/plugin"],
  "devDependencies.@opencode-ai/plugin",
);
const opentuiVersion = requiredString(
  packageJson.devDependencies?.["@opentui/core"],
  "devDependencies.@opentui/core",
);
const smokeDirectory = await mkdtemp(join(tmpdir(), "opencode-tps-pack-"));

try {
  await writeFile(
    join(smokeDirectory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        [packageName]: pathToFileURL(archive).href,
        "@opencode-ai/plugin": pluginVersion,
        "@opentui/core": opentuiVersion,
      },
    }),
  );
  await run(
    ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"],
    smokeDirectory,
  );
  await run(
    [
      process.execPath,
      "-e",
      `const plugin = (await import(${JSON.stringify(`${packageName}/tui`)})).default;
if (plugin?.id !== "opencode-tps" || typeof plugin.tui !== "function") {
  throw new Error("Invalid TUI plugin export");
}`,
    ],
    smokeDirectory,
  );
} finally {
  await rm(smokeDirectory, { force: true, recursive: true });
}

console.log(`Verified ${archive}`);
