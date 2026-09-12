import { constants } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const slugs = ["sponsored-fee", "swap-extra-transfer", "unexplained-difference"];
const originals = ["input.json", "report.json", "report.html", "manifest.json"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escape = (text) => String(text).replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

// Explanatory copy only. Quantities are checked independently against the
// synthetic input instructions and balances in examples.test.mjs. This file
// does not calculate, alter, or interpret the engine's economic results.
export const teachingNotes = {
  "sponsored-fee": {
    question: "Did the wallet also pay the network fee?",
    evidence: "The first account is a separate sponsor. meta.fee is 5,000 lamports. The sponsor loses 5,000 lamports; the wallet loses 100,000,000 lamports, matching its explicit 0.1 SOL transfer.",
    answer: "The supplied record charges the sponsor, not the analyzed wallet. Subtracting the fee from that wallet again would add an unsupported debit. Its native movement residual is zero.",
    limitation: "This invented file does not prove execution, finality, complete history, ownership or any later reimbursement to the sponsor. Zero residual is only local consistency.",
    nextCheck: "Compare your application's fee attribution with accountKeys[0], meta.fee and the original balance changes. Keep any separate reimbursement separate unless evidence supports it.",
  },
  "swap-extra-transfer": {
    question: "Is the wallet's 2 TOKEN net increase the swap output?",
    evidence: "The synthetic DFlow-v4 CPI legs send 5 USDC and receive 2.5 TOKEN. A subsequent outer instruction separately transfers 0.5 TOKEN away. The supplied TOKEN balance therefore increases by 2 TOKEN.",
    answer: "The existing rule recognizes one locally reconciled candidate: 5 USDC for 2.5 TOKEN, plus a separate 0.5 TOKEN transfer. Net balance change and gross swap output answer different questions.",
    limitation: "TOKEN is invented. This exact supported instruction pattern is not proof of every DFlow route, deployed execution, Fomo attribution, a token price or PnL.",
    nextCheck: "Compare gross swap legs with later transfers before comparing an indexer's trade row to the final balance. Keep unknown CPI patterns explicit instead of guessing a swap.",
  },
  "unexplained-difference": {
    question: "Why does a 0.1 SOL transfer leave only a 0.09 SOL debit?",
    evidence: "The explicit transfer is 100,000,000 lamports. The wallet's supplied balances change from 1,000,000,000 to 910,000,000. A separate sponsor pays 5,000 lamports. Observed minus explained wallet change is +10,000,000 lamports (0.01 SOL).",
    answer: "The deliberately inconsistent file leaves 0.01 SOL unexplained. The report preserves the explicit transfer and flags the difference; it does not manufacture an incoming transfer or profit.",
    limitation: "This teaching contradiction is not a real blockchain incident. A residual alone cannot identify its cause. CLI exit 0 means a report was generated, not that the evidence reconciles.",
    nextCheck: "Check the original source response, inner instructions and pre/post balances for missing or inconsistent evidence. Preserve the original; the inspector does not fetch or authenticate a replacement.",
  },
};

export function renderTeachingAnnotation(notes) {
  const sections = [["Question", notes.question], ["Evidence", notes.evidence],
    ["Answer", notes.answer], ["Limitation", notes.limitation], ["Next check", notes.nextCheck]];
  return `<aside id="synthetic-teaching-notes" aria-labelledby="synthetic-teaching-title"><p class="notice"><strong id="synthetic-teaching-title">SYNTHETIC TEACHING EXAMPLE — not blockchain data.</strong> Annotated view; original replay bundle below.</p><details><summary>Read the question, evidence and limits</summary>${sections.map(([label, text]) => `<h3>${label}</h3><p>${escape(text)}</p>`).join("")}</details><p>This page adds teaching notes to the unchanged CLI reader. Do not use this annotated HTML as a replay bundle: its bytes intentionally differ from the original manifest. Download all four originals into one folder to reproduce the original report.</p><nav class="section-links" aria-label="Original replay bundle"><a href="original/input.json" download>Original input.json</a><a href="original/report.json" download>Original report.json</a><a href="original/report.html" download>Original report.html</a><a href="original/manifest.json" download>Original manifest.json</a></nav><p class="technical"><a href="LICENSE">Apache-2.0 license</a> · <a href="NOTICE">Notice</a> · <a href="THIRD-PARTY-NOTICES.md">Third-party notices</a></p></aside>`;
}

export function annotateOriginalHtml(originalHtml, notes) {
  const anchor = "<body><main>";
  if (originalHtml.split(anchor).length !== 2 || originalHtml.includes("id=\"synthetic-teaching-notes\"")) {
    throw new Error("Unexpected original HTML shape; refusing to annotate");
  }
  return originalHtml.replace(anchor, anchor + renderTeachingAnnotation(notes));
}

export async function generatePublicViews({
  sourceRoot = path.join(root, "examples"),
  outputRoot = path.join(root, ".local/public-examples/0.4.0"),
} = {}) {
  // Fail before creating a public view if the supposed original bundle changed.
  const verified = [];
  for (const slug of slugs) {
    const source = path.join(sourceRoot, slug, "report");
    const bytes = Object.fromEntries(await Promise.all(originals.map(async (name) =>
      [name, await readFile(path.join(source, name))])));
    const manifest = JSON.parse(bytes["manifest.json"]);
    if (manifest.inspectorVersion !== "0.4.0"
      || manifest.input.file !== "input.json"
      || manifest.input.sha256 !== sha256(bytes["input.json"])
      || manifest.input.bytes !== bytes["input.json"].length
      || manifest.artifacts["report.html"] !== sha256(bytes["report.html"])
      || manifest.artifacts["report.json"] !== sha256(bytes["report.json"])) {
      throw new Error(`${slug}: original bundle integrity or version mismatch`);
    }
    const input = JSON.parse(bytes["input.json"]);
    const teachingInput = await readFile(path.join(root, "examples", slug, "input.json"));
    if (!/^SYNTHETIC/.test(input._z7onExample ?? "") || !bytes["input.json"].equals(teachingInput)) {
      throw new Error(`${slug}: original input is not the reviewed synthetic teaching file`);
    }
    verified.push({ slug, source, bytes,
      annotated: annotateOriginalHtml(bytes["report.html"].toString("utf8"), teachingNotes[slug]) });
  }
  await mkdir(path.dirname(outputRoot), { recursive: true });
  await mkdir(outputRoot); // Preserve previous generated trees; no overwrites.
  for (const { slug, source, bytes, annotated } of verified) {
    const destination = path.join(outputRoot, slug);
    await mkdir(path.join(destination, "original"), { recursive: true });
    for (const name of originals) {
      await copyFile(path.join(source, name), path.join(destination, "original", name), constants.COPYFILE_EXCL);
    }
    await writeFile(path.join(destination, "report.html"), annotated, { flag: "wx" });
    await writeFile(path.join(destination, "report.json"), bytes["report.json"], { flag: "wx" });
    for (const name of ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"]) {
      await copyFile(path.join(root, name), path.join(destination, name), constants.COPYFILE_EXCL);
    }
    await mkdir(path.join(destination, "docs"));
    await copyFile(path.join(root, "docs/protocol-provenance.md"),
      path.join(destination, "docs/protocol-provenance.md"), constants.COPYFILE_EXCL);
  }
  return outputRoot;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!value || !["--source-root", "--out-root"].includes(key)) {
      throw new Error("Usage: node examples/generate-public-views.mjs [--source-root DIRECTORY] [--out-root NEW_DIRECTORY]");
    }
    options[key === "--source-root" ? "sourceRoot" : "outputRoot"] = path.resolve(value);
  }
  console.log(await generatePublicViews(options));
}
