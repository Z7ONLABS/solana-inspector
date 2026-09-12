#!/usr/bin/env node
import { executeInspector, InspectorRunError } from "./run";
import { INSPECTOR_VERSION } from "./input";

const HELP = `Z7ON LABS — local Solana Inspector ${INSPECTOR_VERSION}

z7on-inspect --input FILE.json --wallet ADDRESS --out NEW_DIRECTORY [--feedback]

Accepts getTransaction jsonParsed result, JSON-RPC envelope, array, or a prior manifest.
The output parent must exist; existing reports are never overwritten.
Limits: 1 wallet, 1,000 transactions, 32 MiB input, 30 seconds of worker processing.
Final output total: 128 MiB, including input, reports, manifest and optional receipt.
Host preflight and file publication are outside the worker time limit.
Outputs: input.json, manifest.json, report.json, report.html.
--feedback adds a local, optional receipt. Nothing is sent automatically.
Analysis is offline. Imported data is not authenticated against the blockchain.
Exit 0 means report generated, not economically complete or financially verified.
Exit 2 input error; 3 processing/output error; 124 time limit; 130 cancelled.
No API keys, wallet connection, provider calls, PnL or complete-history claim.
`;

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(HELP);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${INSPECTOR_VERSION}\n`);
    return;
  }
  const values: Record<string, string> = {};
  let feedback = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--feedback" && !feedback) {
      feedback = true;
      continue;
    }
    if (
      !["--input", "--wallet", "--out"].includes(key) ||
      values[key] ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    ) {
      throw new InspectorRunError("invalid_or_repeated_arguments", 2);
    }
    values[key] = args[++i];
  }
  if (!values["--input"] || !values["--wallet"] || !values["--out"])
    throw new InspectorRunError("input_wallet_and_out_required", 2);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await executeInspector({
      input: values["--input"],
      wallet: values["--wallet"],
      out: values["--out"],
      feedback,
      signal: controller.signal,
    });
    process.stdout.write(
      `Report generated for ${result.transactions} supplied transactions.\n${result.out}\nEconomic limitations remain in report.json/report.html. Nothing was uploaded.\n`,
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

main().catch((error: unknown) => {
  const known = error instanceof InspectorRunError;
  process.stderr.write(
    `Inspector: ${known ? error.code : "local_io_or_processing_error"}. Use --help.\n`,
  );
  process.exitCode = known ? error.exitCode : 3;
});
