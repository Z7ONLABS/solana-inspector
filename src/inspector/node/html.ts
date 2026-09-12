import { createHash } from "node:crypto";
import type { SolanaInspectionReport } from "../../analytics/solana/inspection";
import { mountInspectorReader } from "../browser/reader";

export function escapeHtml(value: unknown): string {
  return String(value ?? "Unavailable").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/** Escape HTML parser terminators without changing the parsed JSON values. */
function inertJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Local progressive reader; the sole active script is pinned by its exact hash. */
export function renderInspectorHtml(report: SolanaInspectionReport): string {
  const script = `(${mountInspectorReader.toString()})(document);`;
  const scriptHash = createHash("sha256").update(script).digest("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'; object-src 'none'"><title>Z7ON LABS — local Solana inspection</title><style>
:root{color-scheme:light}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#f2f1e9;color:#171916;font:16px/1.55 system-ui,sans-serif}main{max-width:1200px;padding:32px;margin:auto}header{border-top:6px solid #171916;padding-top:20px}h1{font-size:clamp(32px,5vw,56px);line-height:1.1;letter-spacing:-.04em}h2{font-size:26px;line-height:1.2}h3{font-size:18px}section{border-top:1px solid #777;margin-top:32px;padding-top:20px}.brand{font-size:22px;font-weight:900}.address,td,pre,.technical{font-family:ui-monospace,monospace;overflow-wrap:anywhere}pre{white-space:pre-wrap;font-size:14px}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:12px 8px;border-bottom:1px solid #999}th{font-family:system-ui,sans-serif}summary{min-height:44px;padding:12px 0;cursor:pointer;overflow-wrap:anywhere}details{border-bottom:1px solid #999}.detail-content{padding:0 0 16px}.detail-content details{padding-left:14px}button,input,select{font:inherit;min-height:44px;border:1px solid #686868;border-radius:0;color:inherit;background:#fafafa;padding:10px 12px}button{cursor:pointer}button:hover:not(:disabled){background:#e1e1e1}button:disabled{color:#666666;border-color:#a4a4a4;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible,[tabindex="-1"]:focus-visible{outline:3px solid #171916;outline-offset:3px}a{color:#171916;text-decoration:underline;text-underline-offset:3px}.notice{border-left:4px solid #666666;padding:12px 16px;background:#e8e8e8}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}.metrics dt{font-size:14px}.metrics dd{margin:0;font-size:32px;font-weight:650;font-variant-numeric:tabular-nums}.reader-filters{display:grid;grid-template-columns:2fr 1fr;gap:20px;margin:24px 0}.reader-filters label{display:block;font-size:14px;margin-bottom:8px}.reader-filters input,.reader-filters select{width:100%}.list-status{font-size:14px}.observation-rows{list-style:none;padding:0;margin:0}.observation-rows li{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:20px;border-top:1px solid #999;padding:16px 0}.observation-rows .address{font-size:14px;margin:8px 0 0}.observation-open{font-weight:650;background:#171916;color:#f2f1e9}.observation-open:hover:not(:disabled){background:#343434}.observation-state{font-size:14px;display:flex;flex-direction:column;align-items:flex-start;gap:4px}.observation-state span:first-child{font-weight:650;text-transform:capitalize}.pager{display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:12px;margin:20px 0;font-size:14px}.pager span{flex:1;text-align:center}.section-links{display:flex;flex-wrap:wrap;gap:8px 20px;margin:24px 0}.section-links a{display:inline-flex;align-items:center;min-height:44px}.exact-value{margin:6px 0 16px}.evidence-value{border-bottom:1px solid #b7b7b7;padding:8px 0;overflow-wrap:anywhere}.evidence-value>strong{font-size:14px}.table-section{min-width:0}.technical{font-size:14px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}footer{border-top:1px solid #777;margin-top:32px;padding-top:20px;font-size:14px}@media(max-width:700px){main{padding:20px}.metrics{grid-template-columns:1fr 1fr}.reader-filters,.observation-rows li{grid-template-columns:minmax(0,1fr)}.reader-filters{gap:16px}.observation-state{gap:4px}.pager button{flex:1}.pager span{order:-1;flex-basis:100%}table,tbody,tr,td{display:block}thead{display:none}tr{border-bottom:2px solid #777;margin:12px 0}td{padding:6px 0}td::before{content:attr(data-label);display:block;font:600 14px/1.5 system-ui,sans-serif}td:first-child{font-weight:700}.section-links{gap:4px 20px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}@media print{main{padding:0}body{background:white}.reader-filters,.pager,button{display:none}}
.instruction-reference{display:inline-flex;align-items:center;min-height:44px;min-width:44px}#selected-instruction{border-left:4px solid #666666;padding:16px;margin:20px 0}
</style></head><body><main><header><div class="brand">Z7ON LABS</div><h1>Solana evidence inspection.</h1><p class="address">${escapeHtml(report.walletAddress)}</p><p class="notice">User-supplied sample. Not authenticated against the blockchain. No complete-history, current-portfolio, PnL or tax guarantee. A successful execution does not mean every economic effect is understood.</p></header>
<section id="sample-summary"><h2>Sample, not complete history.</h2><dl class="metrics">${[
    ["Supplied observations", report.summary.suppliedTransactions],
    ["Distinct supplied signatures", report.summary.uniqueTransactions],
    ["Eligible observations", report.summary.eligibleTransactions],
    ["Swap candidates in eligible observations", report.summary.swapCandidates],
    [
      "Candidates without economic blockers",
      report.summary.locallyReconciledSwapCandidates,
    ],
    [
      "Eligible observations with economic blockers",
      report.summary.transactionsWithEconomicLimitations,
    ],
  ]
    .map(
      ([label, value]) =>
        `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
    )
    .join(
      "",
    )}</dl><p>Distinct raw revisions: ${escapeHtml(report.summary.distinctRevisions)} (including records without a signature). Exact duplicate observations: ${escapeHtml(report.summary.duplicateTransactions)}. Distinct supplied signatures are identities in the input, not validated or authenticated signatures.</p><p class="notice">Excluded observations: ${escapeHtml(report.summary.excludedObservations)}. Conflicting signatures: ${escapeHtml(report.summary.conflictingSignatures)}, affecting ${escapeHtml(report.summary.conflictedObservations)} observations. Observations without identity: ${escapeHtml(report.summary.unidentifiedObservations)}. These counts include exact repeats where applicable; exclusion reasons can overlap and must not be added together.</p><p>Movement, swap and limitation totals cover eligible observations only. Excluded records remain visible, and fewer counted limitations do not mean fewer unresolved records. Eligibility does not establish reconciled quantities or financial validity.</p><p>Candidate recognition is not on-chain verification. All supplied records remain unauthenticated, including those with locally consistent quantities. Financial results are unavailable.</p><details><summary>Exact summary and version information</summary><pre>${escapeHtml(JSON.stringify({ summary: report.summary, methodology: report.methodology }, null, 2))}</pre></details></section>
<p id="reader-fallback" class="notice">The interactive reader is unavailable or JavaScript is disabled. The summary remains visible. Open the accompanying <a href="report.json">report.json</a> for every exact observation and evidence field; keep that file alongside this HTML when using this fallback. The HTML itself contains the complete report for offline browsing when its reader is available.</p>
<div id="inspector-reader" hidden data-state="pending"></div>
<p>The complete versioned, machine-readable result is in the accompanying <a href="report.json">report.json</a>. Original supplied bytes and hashes are in input.json and manifest.json. Printing captures the current view, not every observation.</p>
<footer>Offline report · ${escapeHtml(report.version)} · Keep this report and its input private unless you choose to share them. Hashes establish byte identity, not on-chain authenticity.</footer></main><script type="application/json" id="inspection-data">${inertJson(report)}</script><script id="inspection-reader-script">${script}</script></body></html>\n`;
}
