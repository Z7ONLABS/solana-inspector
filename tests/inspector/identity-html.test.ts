// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { inspectSolanaEvidence } from "../../src/analytics/solana/inspection";
import { renderInspectorHtml } from "../../src/inspector/node/html";
import { mountInspectorReader } from "../../src/inspector/browser/reader";

const WALLET = "11111111111111111111111111111112";
// Synthetic observations only; never customer or public evidence.
function raw(signature: string | null, fee = 5, slot = 42) {
  return {
    version: "legacy",
    slot,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: signature === null ? [] : [signature],
      message: {
        accountKeys: [
          { pubkey: WALLET, signer: true },
          { pubkey: "fixture-recipient", signer: false },
        ],
        instructions: [
          {
            program: "system",
            programId: "11111111111111111111111111111111",
            parsed: {
              type: "transfer",
              info: {
                source: WALLET,
                destination: "fixture-recipient",
                lamports: 100,
              },
            },
          },
        ],
      },
    },
    meta: {
      err: null,
      fee,
      preBalances: [1000, 0],
      postBalances: [900 - fee, 100],
      preTokenBalances: [],
      postTokenBalances: [],
      innerInstructions: [],
    },
  };
}

function documentFor(...records: ReturnType<typeof raw>[]) {
  const report = inspectSolanaEvidence({
    walletAddress: WALLET,
    inputSha256: "a".repeat(64),
    transactions: records.map((record) => ({
      raw: record,
      payloadSha256: "b".repeat(64),
    })),
  });
  const html = renderInspectorHtml(report);
  document.documentElement.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).documentElement.innerHTML;
  mountInspectorReader(document);
  return { html, document, report };
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

function open(index: number) {
  document
    .querySelector<HTMLButtonElement>(`[data-open-observation="${index}"]`)!
    .click();
  return document.getElementById("observation-detail")!;
}

function back() {
  [
    ...document.querySelectorAll<HTMLButtonElement>(
      "#observation-detail button",
    ),
  ]
    .find((b) => b.textContent === "Back to observations")!
    .click();
}

describe("inspector v2 identity and revision presentation", () => {
  it("shows exclusions alongside eligible-only totals instead of presenting conflicts as fewer limitations", () => {
    const { document } = documentFor(raw("conflict", 5), raw("conflict", 6));
    const metrics = [...document.querySelectorAll(".metrics > div")].map(
      (row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector("dd")?.textContent,
      ],
    );
    expect(metrics).toContainEqual(["Supplied observations", "2"]);
    expect(metrics).toContainEqual(["Distinct supplied signatures", "1"]);
    expect(metrics).toContainEqual(["Eligible observations", "0"]);
    expect(metrics).toContainEqual([
      "Eligible observations with economic blockers",
      "0",
    ]);
    const summary = document.querySelector("main > section")!;
    expect(summary.querySelector(".notice")?.textContent).toContain(
      "Excluded observations: 2",
    );
    expect(summary.querySelector(".notice")?.textContent).toContain(
      "Conflicting signatures: 1, affecting 2 observations",
    );
    expect(summary.textContent).toContain(
      "fewer counted limitations do not mean fewer unresolved records",
    );
    expect(summary.textContent).toContain(
      "not validated or authenticated signatures",
    );
    expect(summary.textContent).toContain("Financial results are unavailable");
  });

  it("keeps A, B, B visible and points the repeated revision to B", () => {
    const b = raw("conflict", 6);
    const { document } = documentFor(raw("conflict", 5), b, b);
    expect(document.querySelectorAll("[data-open-observation]")).toHaveLength(
      3,
    );
    for (let index = 0; index < 3; index++) {
      const section = open(index);
      expect(section.textContent).toContain("Excluded from economic totals");
      const notices = [...section.querySelectorAll("p.notice")]
        .map((p) => p.textContent)
        .join(" ");
      expect(notices).toContain(
        "Conflicting revisions of the supplied signature",
      );
      expect(section.querySelector("h3")?.textContent).toBe(
        "Observed movements",
      );
      if (index === 2) {
        expect(notices).toContain("Exact duplicate observation");
        expect(notices).toContain("Duplicate of observation 2");
      }
      expect(section.textContent).toContain(
        index === 0
          ? "Counted once among distinct supplied signatures"
          : "Already represented by observation 1",
      );
      expect(section.textContent).toContain(
        "Sample quantity reconciliation is not attributed to this excluded revision",
      );
      back();
    }
  });

  it("keeps missing identity explicit and documents overlapping exclusion counts", () => {
    const missing = raw(null);
    const { document } = documentFor(missing, missing);
    const summary = document.querySelector("main > section")!;
    expect(summary.textContent).toContain(
      "Distinct raw revisions: 1 (including records without a signature)",
    );
    expect(summary.textContent).toContain("Exact duplicate observations: 1");
    expect(summary.textContent).toContain("Observations without identity: 2");
    expect(summary.textContent).toContain(
      "exclusion reasons can overlap and must not be added together",
    );
    const detail = open(0);
    expect(detail.textContent).toContain(
      "Unavailable — not counted as an identified transaction",
    );
    expect(detail.textContent).toContain(
      "Supplied transaction identity unavailable",
    );
  });

  it("does not equate eligibility with reconciliation or execute supplied markup", () => {
    const signature =
      '<img src="https://example.invalid/leak"><script>alert(1)</script>';
    const { html, document } = documentFor(raw(signature));
    const detail = open(0);
    expect(detail.textContent).toContain(signature);
    expect(detail.textContent).toContain(
      "Eligible for economic totals — not a confirmation",
    );
    expect(
      document.querySelectorAll("img, iframe, object, embed, form"),
    ).toHaveLength(0);
    expect(document.querySelectorAll("script")).toHaveLength(2);
    expect(
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
    ).toContain("default-src 'none'");
    expect(html).not.toMatch(/(?:src|href)=["']https?:/);
  });

  it("embeds the exact complete report once, with CSP pinning only the trusted script", () => {
    const { document, report } = documentFor(
      raw("</ScRiPt><script>throw 1</script>&\u2028\u2029"),
    );
    const data = document.getElementById("inspection-data")!;
    expect(data.getAttribute("type")).toBe("application/json");
    expect(data.textContent).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(data.textContent!)).toEqual(report);
    expect(
      document.querySelectorAll('script[type="application/json"]'),
    ).toHaveLength(1);
    const script = document.getElementById(
      "inspection-reader-script",
    )!.textContent!;
    const csp = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')!
      .getAttribute("content")!;
    expect(csp).toContain(
      `script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    );
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(script).not.toMatch(
      /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|innerHTML|outerHTML|insertAdjacentHTML)\b/,
    );
  });
});
