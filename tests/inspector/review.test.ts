// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  canonicalJson,
  hashBytes,
  INSPECTOR_VERSION,
  LIMITS,
  loadInspectorInput,
} from "../../src/inspector/node/input";
import { renderInspectorHtml } from "../../src/inspector/node/html";
import { inspectSolanaEvidence } from "../../src/analytics/solana/inspection";
import { executeInspector } from "../../src/inspector/node/run";
import { mountInspectorReader } from "../../src/inspector/browser/reader";

const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => {
    window: {
      document: Document;
      HTMLElement: typeof HTMLElement;
      scrollTo: () => void;
      close: () => void;
    };
  };
};

const io = vi.hoisted(() => ({
  afterPublish: null as ((from: string, to: string) => Promise<void>) | null,
  afterWrite: null as ((file: string) => void) | null,
  workerMode: "respond" as "respond" | "silent",
  workerTerminations: 0,
  onWorkerCreated: null as (() => void) | null,
  finalOutputLimit: 128 * 1024 * 1024,
  mutations: [] as string[],
  links: [] as string[],
  failure: null as {
    operation: "write" | "link";
    name: string;
    code: string;
    fired: boolean;
  } | null,
}));

vi.mock("../../src/inspector/node/input", async (original) => {
  const actual =
    await original<typeof import("../../src/inspector/node/input")>();
  return {
    ...actual,
    LIMITS: {
      ...actual.LIMITS,
      get outputBytes() {
        return io.finalOutputLimit;
      },
    },
  };
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const fail = (operation: "write" | "link", file: string) => {
    const failure = io.failure;
    if (
      failure &&
      !failure.fired &&
      failure.operation === operation &&
      path.basename(file) === failure.name
    ) {
      failure.fired = true;
      return Object.assign(new Error(`Simulated ${failure.code}`), {
        code: failure.code,
      });
    }
    return null;
  };
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      io.mutations.push("mkdir");
      return actual.mkdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[1] !== "wx") return handle;
      io.mutations.push("open-write");
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile")
            return async (data: string | Uint8Array) => {
              io.mutations.push("write");
              const error = fail("write", String(args[0]));
              if (error) {
                // Exercise cleanup after a file has been created and partly written.
                await target.writeFile(Buffer.from(data).subarray(0, 1));
                throw error;
              }
              await target.writeFile(data);
              io.afterWrite?.(String(args[0]));
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    link: async (from: string, to: string) => {
      const error = fail("link", to);
      if (error) throw error;
      await actual.link(from, to);
      io.links.push(path.basename(to));
      await io.afterPublish?.(from, to);
    },
  };
});

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        io.onWorkerCreated?.();
        if (io.workerMode === "silent") return;
        queueMicrotask(() =>
          this.emit("message", {
            ok: true,
            input: Buffer.from("{}"),
            report: "{}\n",
            html: "<!doctype html><title>Test</title>",
            manifest: "{}\n",
            statistics: { transactions: 1, summary: {} },
          }),
        );
      }
      terminate() {
        io.workerTerminations++;
        return Promise.resolve(0);
      }
    },
  };
});

const WALLET = "11111111111111111111111111111112";
let temporary: string;
function raw() {
  return {
    version: "legacy",
    slot: 42,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: ["synthetic-review-only"],
      message: {
        accountKeys: [{ pubkey: WALLET, signer: true }],
        instructions: [{ programId: "unknown-fixture-program", data: "111" }],
      },
    },
    meta: {
      fee: 5,
      err: null,
      preBalances: [100],
      postBalances: [95],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
  };
}

beforeEach(async () => {
  io.workerMode = "respond";
  io.workerTerminations = 0;
  io.onWorkerCreated = null;
  io.afterWrite = null;
  io.finalOutputLimit = 128 * 1024 * 1024;
  io.mutations = [];
  io.links = [];
  io.failure = null;
  temporary = await mkdtemp(path.join(os.tmpdir(), "z7on-functional-review-"));
});
afterEach(async () => {
  vi.useRealTimers();
  io.afterPublish = null;
  io.afterWrite = null;
  io.onWorkerCreated = null;
  io.failure = null;
  if (
    path.dirname(temporary) === path.resolve(os.tmpdir()) &&
    path.basename(temporary).startsWith("z7on-functional-review-")
  )
    await rm(temporary, { recursive: true, force: true });
});

describe("inspector functional review regressions", () => {
  const finalFixtureBytes = (feedback: boolean) => {
    const report = "{}\n";
    const html = "<!doctype html><title>Test</title>";
    const manifest = `${canonicalJson({ artifacts: { "report.json": hashBytes(report), "report.html": hashBytes(html) } })}\n`;
    const feedbackText = feedback
      ? `${canonicalJson({
          version: "solana-inspector-feedback-v1",
          inspectorVersion: INSPECTOR_VERSION,
          runId: "00000000-0000-0000-0000-000000000000",
          generatedAt: "2026-09-10T00:00:00.000Z",
          transactionCount: 1,
          execution: "completed",
          content:
            "No wallet addresses, signatures, input hashes or files included.",
          inputKind: "not-declared",
          sent: false,
        })}\n`
      : "";
    return ["{}", report, html, manifest, feedbackText].reduce(
      (total, value) => total + Buffer.byteLength(value),
      0,
    );
  };

  for (const feedback of [false, true]) {
    it.each([-1, 0, 1])(
      `enforces the serialized final envelope before mkdir/write, feedback=${feedback}, headroom=%i`,
      async (headroom) => {
        const expectedBytes = finalFixtureBytes(feedback);
        io.finalOutputLimit = expectedBytes + headroom;
        const out = path.join(temporary, "budget-result");
        const execution = executeInspector({
          input: "ignored-by-test-worker.json",
          wallet: WALLET,
          out,
          feedback,
        });
        if (headroom < 0) {
          await expect(execution).rejects.toMatchObject({
            code: "output_byte_limit",
            exitCode: 2,
          });
          expect(io.mutations).toEqual([]);
          expect(io.links).toEqual([]);
          expect(await readdir(temporary)).toEqual([]);
        } else {
          await execution;
          const files = await readdir(out);
          const actualBytes = (
            await Promise.all(
              files.map(
                async (name) => (await readFile(path.join(out, name))).length,
              ),
            )
          ).reduce((a, b) => a + b, 0);
          expect(actualBytes).toBe(expectedBytes);
          expect(files.includes("feedback.json")).toBe(feedback);
          expect(io.links.at(-1)).toBe("manifest.json");
        }
      },
    );
  }

  it.each([
    ["write", "report.html", "ENOSPC"],
    ["write", "report.html", "EACCES"],
    ["link", "report.html", "ENOSPC"],
    ["link", "report.html", "EACCES"],
    ["link", "report.html", "ENOTSUP"],
    ["link", "manifest.json", "EACCES"],
  ] as const)(
    "rolls back %s failure on %s (%s) without publishing a complete marker",
    async (operation, name, code) => {
      const old = path.join(temporary, "previous-report");
      await mkdir(old);
      await writeFile(path.join(old, "report.json"), "existing report");
      await writeFile(path.join(old, "manifest.json"), "existing marker");
      const unrelated = path.join(temporary, "unrelated.txt");
      await writeFile(unrelated, "user-owned file");
      io.failure = { operation, name, code, fired: false };
      const out = path.join(temporary, "failed-result");
      await expect(
        executeInspector({
          input: "ignored-by-test-worker.json",
          wallet: WALLET,
          out,
          feedback: true,
        }),
      ).rejects.toMatchObject({ code });
      expect(io.failure.fired).toBe(true);
      expect(io.links).not.toContain("manifest.json");
      expect(await lstat(out).catch(() => null)).toBeNull();
      expect(await readFile(path.join(old, "report.json"), "utf8")).toBe(
        "existing report",
      );
      expect(await readFile(path.join(old, "manifest.json"), "utf8")).toBe(
        "existing marker",
      );
      expect(await readFile(unrelated, "utf8")).toBe("user-owned file");
      expect((await readdir(temporary)).sort()).toEqual([
        "previous-report",
        "unrelated.txt",
      ]);
    },
  );

  it.each([undefined, "999.0.0", 1])(
    "rejects incompatible manifest inspector version %s",
    async (version) => {
      const file = path.join(temporary, "input.json");
      await writeFile(file, JSON.stringify(raw()));
      const loaded = await loadInspectorInput(file, WALLET);
      const prior = { ...loaded.manifest, inspectorVersion: version };
      const manifest = path.join(temporary, "manifest.json");
      await writeFile(manifest, canonicalJson(prior));
      await expect(loadInspectorInput(manifest, WALLET)).rejects.toThrow(
        "manifest_incompatible",
      );
    },
  );

  it("puts actual economic blockers in the visible limitations section", () => {
    const report = inspectSolanaEvidence({
      walletAddress: WALLET,
      inputSha256: "b".repeat(64),
      transactions: [{ raw: raw(), payloadSha256: "a".repeat(64) }],
    });
    expect(report.transactions[0].economic.blockers).toContain(
      "instruction_effect_unsupported",
    );
    const dom = new JSDOM(renderInspectorHtml(report));
    try {
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
      mountInspectorReader(dom.window.document);
      dom.window.document
        .querySelector<HTMLButtonElement>('[data-open-observation="0"]')!
        .click();
      const required = [...dom.window.document.querySelectorAll("table")].find(
        (table) =>
          table.querySelector("caption")?.textContent === "Required evidence",
      )!;
      expect(required.textContent).toContain("instruction_effect_unsupported");
      expect(required.textContent).toContain("Official instruction semantics");
      expect(
        dom.window.document.getElementById("observation-detail")!.hidden,
      ).toBe(false);
    } finally {
      dom.window.close();
    }
  });

  it("identifies repeated transaction evidence as a duplicate excluded from totals", () => {
    const tx = { raw: raw(), payloadSha256: "a".repeat(64) };
    const report = inspectSolanaEvidence({
      walletAddress: WALLET,
      inputSha256: "b".repeat(64),
      transactions: [tx, tx],
    });
    expect(report.summary.duplicateTransactions).toBe(1);
    const dom = new JSDOM(renderInspectorHtml(report));
    try {
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
      mountInspectorReader(dom.window.document);
      dom.window.document
        .querySelector<HTMLButtonElement>('[data-open-observation="1"]')!
        .click();
      const section = dom.window.document.getElementById("observation-detail")!;
      expect(section.hidden).toBe(false);
      expect(section.textContent).toMatch(/duplicate of observation 1/i);
      expect(section.textContent).toMatch(
        /excluded from summary economic totals/i,
      );
      expect(section.textContent).toContain("Exact duplicate observation");
    } finally {
      dom.window.close();
    }
  });

  it.each([
    "opaque-transaction",
    ["base64", "base64"],
    { message: "not-a-message" },
  ])(
    "rejects an incompatible transaction body instead of making an empty report",
    async (transaction) => {
      const file = path.join(temporary, "bad-body.json");
      await writeFile(file, JSON.stringify({ ...raw(), transaction }));
      await expect(loadInspectorInput(file, WALLET)).rejects.toThrow(
        "transaction_envelope_invalid",
      );
    },
  );

  it("commits its manifest only after all report artefacts are present", async () => {
    const out = path.join(temporary, "result");
    const published: string[][] = [];
    io.afterPublish = async (_from, to) => {
      if (path.dirname(to) === out || to === out)
        published.push((await readdir(out)).sort());
    };
    await executeInspector({
      input: path.join(temporary, "ignored-by-test-worker.json"),
      wallet: WALLET,
      out,
    });
    expect(published.length).toBeGreaterThan(0);
    expect(published.at(-1)).toEqual([
      "input.json",
      "manifest.json",
      "report.html",
      "report.json",
    ]);
    for (const files of published.slice(0, -1))
      expect(files).not.toContain("manifest.json");
  });

  it("cancels during publication instead of returning a successful report", async () => {
    const out = path.join(temporary, "cancelled-result");
    const controller = new AbortController();
    io.afterPublish = async (_from, to) => {
      if (path.dirname(to) === out) controller.abort();
    };
    await expect(
      executeInspector({
        input: path.join(temporary, "ignored-by-test-worker.json"),
        wallet: WALLET,
        out,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled", exitCode: 130 });
    await expect(readFile(path.join(out, "report.json"))).rejects.toThrow();
  });

  it("cancels between staging writes and removes its partial files before any publication", async () => {
    const controller = new AbortController();
    io.afterWrite = () => controller.abort();
    const out = path.join(temporary, "cancelled-staging");
    await expect(
      executeInspector({
        input: "ignored-by-test-worker.json",
        wallet: WALLET,
        out,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "cancelled", exitCode: 130 });
    expect(
      io.mutations.filter((operation) => operation === "write"),
    ).toHaveLength(1);
    expect(io.links).toEqual([]);
    expect(await readdir(temporary)).toEqual([]);
  });

  it("limits only the worker to 30 seconds, not a later successful publication", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let publishing!: () => void;
    const started = new Promise<void>((resolve) => {
      publishing = resolve;
    });
    io.afterPublish = async (_from, to) => {
      if (path.basename(to) === "input.json") {
        publishing();
        await new Promise<void>((resolve) =>
          setTimeout(resolve, LIMITS.executionMs + 1),
        );
      }
    };
    const out = path.join(temporary, "slow-publication");
    const execution = executeInspector({
      input: "ignored-by-test-worker.json",
      wallet: WALLET,
      out,
    });
    await started;
    expect(io.workerTerminations).toBe(1);
    await vi.advanceTimersByTimeAsync(LIMITS.executionMs + 1);
    await expect(execution).resolves.toMatchObject({ out, transactions: 1 });
    expect(io.links.at(-1)).toBe("manifest.json");
    expect(await lstat(path.join(out, "manifest.json"))).toBeDefined();
  });

  it("terminates an unresponsive worker at the 30-second limit without publishing files", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    io.workerMode = "silent";
    const created = new Promise<void>((resolve) => {
      io.onWorkerCreated = resolve;
    });
    const out = path.join(temporary, "timeout-result");
    const outcome = executeInspector({
      input: "ignored-by-test-worker.json",
      wallet: WALLET,
      out,
    }).then(
      () => ({ unexpectedSuccess: true }),
      (error: unknown) => error,
    );
    await created;
    expect(LIMITS.executionMs).toBe(30_000);
    await vi.advanceTimersByTimeAsync(LIMITS.executionMs - 1);
    expect(io.workerTerminations).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      code: "execution_time_limit",
      exitCode: 124,
    });
    expect(io.workerTerminations).toBe(1);
    expect(await lstat(out).catch(() => null)).toBeNull();
    expect(
      (await readdir(temporary)).filter((name) =>
        name.startsWith(".z7on-inspection-"),
      ),
    ).toEqual([]);
  });

  it("rolls back only its own links when publication collides with a newly present user file", async () => {
    const old = path.join(temporary, "previous-report");
    await mkdir(old);
    const oldReport = path.join(old, "report.json");
    await writeFile(oldReport, "previous report must remain intact");
    const out = path.join(temporary, "colliding-result");
    const userFile = path.join(out, "report.html");
    io.afterPublish = async (_from, to) => {
      if (to === path.join(out, "input.json"))
        await writeFile(userFile, "user file created before our link", {
          flag: "wx",
        });
    };
    await expect(
      executeInspector({
        input: "ignored-by-test-worker.json",
        wallet: WALLET,
        out,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(oldReport, "utf8")).toBe(
      "previous report must remain intact",
    );
    expect(await readFile(userFile, "utf8")).toBe(
      "user file created before our link",
    );
    expect(await readdir(out)).toEqual(["report.html"]);
    expect(
      (await readdir(temporary)).filter((name) =>
        name.startsWith(".z7on-inspection-"),
      ),
    ).toEqual([]);
  });
});
