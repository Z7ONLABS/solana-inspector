import { FOMO_SOLANA_FEE_OWNER, SOLANA_USDC_MINT } from "./route-constants";
import type { SolanaRouteEvidence } from "./routes";
import type {
  SolanaEconomicTransaction,
  SolanaTokenAccountBalance,
  SolanaWalletContext,
} from "./types";

type FomoFeeEvidenceInput = {
  transactionId: string;
  context: Pick<
    SolanaWalletContext,
    "walletAddress" | "feeOwner" | "feeTokenAccounts"
  >;
  tokenByAddress: ReadonlyMap<string, SolanaTokenAccountBalance>;
  feeEvidence: SolanaRouteEvidence["feeEvidence"];
  result: Pick<
    SolanaEconomicTransaction,
    "rawMovements" | "fees" | "routingEvidence"
  >;
  blockers: ReadonlySet<string>;
  markUnsupported: (reason: string, mint?: string) => void;
  displayAmount: (raw: string, decimals: number) => string;
};

/**
 * Internal application attribution, not Solana protocol or swap recognition.
 * Uses the existing route proof and reconstructed accounts. Mutations, fee order
 * and blocker checks deliberately match the economic parser's former inline
 * application step. The caller retains final swap and routing availability gates.
 * No new context override is accepted by the public inspector/SDK.
 */
export function applyFomoFeeEvidence({
  transactionId,
  context,
  tokenByAddress,
  feeEvidence,
  result,
  blockers,
  markUnsupported,
  displayAmount,
}: FomoFeeEvidenceInput): {
  fomoFeeProven: boolean;
  hasAppFeeCandidates: boolean;
} {
  const wallet = context.walletAddress;
  const feeOwner = context.feeOwner ?? FOMO_SOLANA_FEE_OWNER;
  const discoveredFeeAccounts = [...tokenByAddress.values()]
    .filter(
      (token) =>
        token.mint === SOLANA_USDC_MINT &&
        token.preOwner === feeOwner &&
        token.postOwner === feeOwner &&
        token.preRaw !== null &&
        token.postRaw !== null &&
        BigInt(token.postRaw) > BigInt(token.preRaw),
    )
    .map((token) => token.accountAddress);
  const feeAccounts = new Set([
    ...(context.feeTokenAccounts ?? []),
    ...discoveredFeeAccounts,
  ]);
  const appFees = result.rawMovements.filter(
    (item) =>
      item.asset.assetId === SOLANA_USDC_MINT &&
      feeAccounts.has(item.toAccount) &&
      (item.fromWallet === wallet ||
        feeEvidence.movementIds.includes(item.id) ||
        result.rawMovements.some(
          (movement) =>
            movement.outerIndex === item.outerIndex &&
            movement.fromWallet === wallet,
        )) &&
      BigInt(item.rawAmount) > BigInt(0),
  );
  if (feeEvidence.state === "proven") {
    for (const item of result.rawMovements)
      if (feeEvidence.movementIds.includes(item.id))
        item.classification = "app_fee";
    result.fees.push({
      id: `${transactionId}:proven-app-fee`,
      kind: "app",
      asset: { chain: "solana", assetId: SOLANA_USDC_MINT },
      rawAmount: feeEvidence.rawAmount,
      amount: displayAmount(feeEvidence.rawAmount, 6),
      decimals: 6,
      payerWallet: wallet,
      chargedToAnalyzedWallet: true,
    });
  }
  for (const item of feeEvidence.state === "proven" ? [] : appFees) {
    if (item.toWallet !== feeOwner || item.fromWallet !== wallet) {
      markUnsupported("fomo_fee_payer_or_vault_unverified", SOLANA_USDC_MINT);
      continue;
    }
    item.classification = "app_fee";
    result.fees.push({
      id: `${item.id}:app-fee`,
      kind: "app",
      asset: item.asset,
      rawAmount: item.rawAmount,
      amount: item.amount,
      decimals: item.decimals,
      payerWallet: item.fromWallet,
      chargedToAnalyzedWallet: true,
    });
  }
  for (const feeAccount of feeEvidence.state === "proven"
    ? []
    : new Set(appFees.map((item) => item.toAccount))) {
    const balance = tokenByAddress.get(feeAccount);
    const paid = appFees
      .filter((item) => item.toAccount === feeAccount)
      .reduce((sum, item) => sum + BigInt(item.rawAmount), BigInt(0));
    if (
      !balance ||
      balance.preOwner !== feeOwner ||
      balance.postOwner !== feeOwner ||
      balance.preRaw === null ||
      balance.postRaw === null ||
      BigInt(balance.postRaw) - BigInt(balance.preRaw) !== paid
    ) {
      markUnsupported("fomo_fee_vault_delta_unreconciled", SOLANA_USDC_MINT);
    }
  }
  const fomoFeeProven =
    result.fees.some((fee) => fee.kind === "app") &&
    !blockers.has("fomo_fee_payer_or_vault_unverified") &&
    !blockers.has("fomo_fee_vault_delta_unreconciled");
  result.routingEvidence = {
    state: fomoFeeProven
      ? "fomo_routed"
      : appFees.length
        ? "unavailable"
        : "not_observed",
    method: fomoFeeProven ? "usdc-fee-owner-and-explicit-transfer" : null,
    feeTokenAccounts: fomoFeeProven
      ? [...new Set(appFees.map((item) => item.toAccount))].sort()
      : [],
  };
  return { fomoFeeProven, hasAppFeeCandidates: appFees.length > 0 };
}
