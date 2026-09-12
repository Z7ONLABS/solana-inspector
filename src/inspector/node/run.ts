import { randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isSolanaAddress } from "../../lib/wallet-address";
import {
  canonicalJson,
  hashBytes,
  InspectorInputError,
  INSPECTOR_VERSION,
  LIMITS,
} from "./input";
import { checkInspectorOutputFiles } from "./output-budget";

export type InspectorOptions = {
  input: string;
  wallet: string;
  out: string;
  feedback?: boolean;
  signal?: AbortSignal;
};
export class InspectorRunError extends Error {
  constructor(
    public readonly code: string,
    public readonly exitCode: number,
  ) {
    super(code);
  }
}
type WorkerResult =
  | {
      ok: true;
      input: Uint8Array;
      report: string;
      html: string;
      manifest: string;
      statistics: { transactions: number; summary: unknown };
    }
  | { ok: false; code: string; exitCode: number };

export async function executeInspector(options: InspectorOptions) {
  if (!isSolanaAddress(options.wallet))
    throw new InspectorRunError("wallet_address_invalid", 2);
  if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
  const out = path.resolve(options.out);
  const parent = await realpath(path.dirname(out));
  if (
    await lstat(out).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw new InspectorRunError("output_already_exists", 3);
  const result = await new Promise<Extract<WorkerResult, { ok: true }>>(
    (resolve, reject) => {
      const worker = new Worker(new URL("./worker.js", import.meta.url), {
        workerData: {
          input: path.resolve(options.input),
          wallet: options.wallet,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 64,
          stackSizeMb: 4,
        },
      });
      let settled = false;
      const stop = (
        error?: Error,
        result?: Extract<WorkerResult, { ok: true }>,
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
        void worker
          .terminate()
          .then(() => (error ? reject(error) : resolve(result!)), reject);
      };
      const cancel = () => stop(new InspectorRunError("cancelled", 130));
      const timer = setTimeout(
        () => stop(new InspectorRunError("execution_time_limit", 124)),
        LIMITS.executionMs,
      );
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      worker.once("error", () =>
        stop(new InspectorRunError("worker_failed", 3)),
      );
      worker.once("exit", () => {
        if (!settled)
          stop(new InspectorRunError("worker_exited_without_result", 3));
      });
      worker.once("message", (message: WorkerResult) => {
        if (!message.ok)
          stop(new InspectorRunError(message.code, message.exitCode));
        else stop(undefined, message);
      });
    },
  );
  if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
  const manifest = {
    ...JSON.parse(result.manifest),
    artifacts: {
      "report.json": hashBytes(result.report),
      "report.html": hashBytes(result.html),
    },
  };
  const files: Record<string, string | Uint8Array> = {
    "input.json": result.input,
    "report.json": result.report,
    "report.html": result.html,
    "manifest.json": `${canonicalJson(manifest)}\n`,
  };
  if (options.feedback)
    files["feedback.json"] = `${canonicalJson({
      version: "solana-inspector-feedback-v1",
      inspectorVersion: INSPECTOR_VERSION,
      runId: randomUUID(),
      generatedAt: new Date().toISOString(),
      transactionCount: result.statistics.transactions,
      execution: "completed",
      content:
        "No wallet addresses, signatures, input hashes or files included.",
      inputKind: "not-declared",
      sent: false,
    })}\n`;
  // The worker's earlier check does not include final hashes or optional feedback.
  // Reject the exact final envelope before creating any directory or file.
  try {
    checkInspectorOutputFiles(files);
  } catch (error) {
    if (error instanceof InspectorInputError)
      throw new InspectorRunError(error.code, 2);
    throw error;
  }
  if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
  // Reserve the destination with mkdir (exclusive); never replace an existing report.
  const staging = path.join(parent, `.z7on-inspection-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  const written: string[] = [];
  const published: string[] = [];
  let reserved = false;
  try {
    for (const [name, data] of Object.entries(files)) {
      if (options.signal?.aborted)
        throw new InspectorRunError("cancelled", 130);
      const file = path.join(staging, name);
      const handle = await open(file, "wx", 0o600);
      written.push(file);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
    await mkdir(out, { mode: 0o700 });
    reserved = true;
    // The manifest is the commit marker. A directory without it is incomplete.
    // Hard links are exclusive, unlike POSIX rename-overwrite; staging shares the volume.
    for (const name of Object.keys(files).filter(
      (name) => name !== "manifest.json",
    )) {
      if (options.signal?.aborted)
        throw new InspectorRunError("cancelled", 130);
      await link(path.join(staging, name), path.join(out, name));
      published.push(path.join(out, name));
      await unlink(path.join(staging, name));
    }
    if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
    await link(
      path.join(staging, "manifest.json"),
      path.join(out, "manifest.json"),
    );
    published.push(path.join(out, "manifest.json"));
    await unlink(path.join(staging, "manifest.json"));
    if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
    await rmdir(staging);
    if (options.signal?.aborted) throw new InspectorRunError("cancelled", 130);
    return {
      out,
      files: Object.keys(files),
      transactions: result.statistics.transactions,
    };
  } catch (error) {
    // Only our exact known files/directories are removed, never a recursive user path.
    if (reserved) {
      // Remove the commit marker first, before any other report artifact.
      for (const file of published.reverse())
        await unlink(file).catch(() => undefined);
      await rmdir(out).catch(() => undefined);
    }
    for (const file of written) await unlink(file).catch(() => undefined);
    await rmdir(staging).catch(() => undefined);
    throw error;
  }
}
