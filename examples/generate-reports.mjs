import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wallet = "11111111111111111111111111111112";
const slugs = ["sponsored-fee", "swap-extra-transfer", "unexplained-difference"];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--out-root")) {
  throw new Error("Usage: node examples/generate-reports.mjs [--out-root NEW_DIRECTORY]");
}
const outRoot = args.length ? path.resolve(args[1]) : path.join(root, "examples");
const cli = path.join(root, "dist/src/inspector/node/cli.js");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
for (const slug of slugs) {
  const parent = path.join(outRoot, slug);
  await mkdir(parent, { recursive: true });
  const out = path.join(parent, "report");
  const child = spawnSync(process.execPath, [cli,
    "--input", path.join(root, "examples", slug, "input.json"),
    "--wallet", wallet, "--out", out,
  ], { cwd: root, encoding: "utf8", timeout: 45_000, windowsHide: true });
  if (child.error || child.status !== 0) {
    throw new Error(`${slug}: ${child.error?.message ?? child.stderr ?? "CLI failed"}`);
  }
  console.log(`${slug}: ${out} (inspector ${packageJson.version}, synthetic only)`);
}

// No custom HTML renderer: every page above comes from the shipped CLI/reader.
// Existing output directories are deliberately not deleted or overwritten.
