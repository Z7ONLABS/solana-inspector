import { parentPort, workerData } from "node:worker_threads";
import {
  inspectSolanaEvidence,
  SolanaInspectionInputError,
} from "../../analytics/solana/inspection";
import {
  canonicalJson,
  InspectorInputError,
  loadInspectorInput,
} from "./input";
import { renderInspectorHtml } from "./html";
import { checkInspectorOutputFiles } from "./output-budget";

if (parentPort) {
  try {
    const loaded = await loadInspectorInput(
      workerData.input,
      workerData.wallet,
    );
    const report = inspectSolanaEvidence(loaded.evidence);
    const serialized = `${canonicalJson(report)}\n`;
    const html = renderInspectorHtml(report);
    const manifest = `${canonicalJson(loaded.manifest)}\n`;
    // Early defense only. The publisher separately checks final hashes/feedback.
    checkInspectorOutputFiles({
      "input.json": loaded.bytes,
      "report.json": serialized,
      "report.html": html,
      "manifest.json": manifest,
    });
    parentPort.postMessage({
      ok: true,
      input: loaded.bytes,
      report: serialized,
      html,
      manifest,
      statistics: {
        transactions: report.transactions.length,
        summary: report.summary,
      },
    });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code:
        error instanceof InspectorInputError ||
        error instanceof SolanaInspectionInputError
          ? error.code
          : "analysis_failed",
      exitCode:
        error instanceof InspectorInputError ||
        error instanceof SolanaInspectionInputError
          ? 2
          : 3,
    });
  }
}
