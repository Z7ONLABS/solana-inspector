import { applyFomoFeeEvidence } from "./fomo-fee-evidence";
import type { CanonicalSpotFee, SpotAssetRef } from "../spot/types";
import {
  analyzeSolanaRouteEvidence,
  isolatedThirdPartyDflowGroups,
  provenPumpVolumeRefunds,
} from "./routes";
import { DFLOW_V4_PROGRAM, SOLANA_USDC_MINT } from "./route-constants";
import { token2022QuantityEvidence } from "./token-quantity-evidence";
import {
  SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  solanaInteger,
  solanaRawAmount,
  solanaRecord,
  solanaText,
} from "./normalize";
import {
  SOLANA_LOCAL_PARSER_VERSION,
  SOLANA_WRAPPED_SOL_MINT,
  type NormalizedSolanaTransaction,
  type SolanaEconomicTransaction,
  type SolanaRawMovement,
  type SolanaWalletBalanceEvidence,
  type SolanaWalletContext,
  type SolanaEconomicBlocker,
  type SolanaTokenAccountBalance,
} from "./types";

export function solanaDisplayAmount(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const negative = value < BigInt(0);
  const text = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, "0");
  const fraction = decimals ? text.slice(-decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${decimals ? text.slice(0, -decimals) : text}${fraction ? `.${fraction}` : ""}`;
}
const asset = (mint: string): SpotAssetRef => ({
  chain: "solana",
  assetId: mint,
});
const native = asset("native");
const NON_ECONOMIC_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);
function instructionOfLegacyTransfer(
  item: SolanaRawMovement,
  tx: NormalizedSolanaTransaction,
): boolean {
  return tx.instructions.some(
    (i) =>
      i.outerIndex === item.outerIndex &&
      i.innerIndex === item.innerIndex &&
      i.programId === SOLANA_TOKEN_PROGRAM &&
      ["transfer", "transferChecked"].includes(i.type ?? ""),
  );
}

/** Classifies observed local evidence only. Unsupported effects remain tainted, never fabricated into swaps. */
export function parseSolanaEconomicEvents(
  tx: NormalizedSolanaTransaction,
  context: SolanaWalletContext,
): SolanaEconomicTransaction {
  if (!context.walletAddress)
    throw new Error("Solana wallet context is required.");
  if (
    context.transactionOrder !== undefined &&
    solanaInteger(context.transactionOrder) === null
  )
    throw new Error(
      "Solana transaction order must be a proven non-negative integer.",
    );
  const wallet = context.walletAddress;
  const owned = new Set(context.ownedWallets ?? [wallet]);
  owned.add(wallet);
  const blockers = new Set(tx.blockers);
  const blockerEvidence: SolanaEconomicBlocker[] = tx.blockers.map((code) => {
    const assetIds =
      code === "token_account_owner_changed"
        ? [
            ...new Set(
              tx.tokenAccounts
                .filter(
                  (account) =>
                    account.preOwner &&
                    account.postOwner &&
                    account.preOwner !== account.postOwner,
                )
                .map((account) => account.mint),
            ),
          ]
        : [];
    return { code, scope: assetIds.length ? "asset" : "transaction", assetIds };
  });
  if (
    tx.provenance.commitment !== "finalized" ||
    tx.provenance.commitmentEvidence === "unknown"
  )
    blockers.add("finality_unavailable");
  if (context.transactionOrder === undefined)
    blockers.add("transaction_order_unproven");
  const result: SolanaEconomicTransaction = {
    parserVersion: SOLANA_LOCAL_PARSER_VERSION,
    state: "unsupported",
    signature: tx.signature,
    walletAddress: wallet,
    slot: tx.slot,
    transactionIndex: tx.transactionIndex,
    executedAt: tx.blockTime,
    succeeded: tx.succeeded,
    sourceScope: "wallet_all_activity",
    economicClassification: "unresolved",
    routingEvidence: {
      state: "not_observed",
      method: null,
      feeTokenAccounts: [],
    },
    orderProven: context.transactionOrder !== undefined,
    swaps: [],
    transfers: [],
    rawMovements: [],
    lifecycle: [],
    fees: [],
    feesComplete: false,
    balanceEvidence: [],
    taintedAssets: [],
    blockers: [],
    provenance: { ...tx.provenance },
  };
  const id = tx.signature ?? "unknown-signature";
  const accountByAddress = new Map(
    tx.accounts.map((account) => [account.address, account]),
  );
  const tokenByAddress = new Map(
    tx.tokenAccounts.map((account) => [account.accountAddress, { ...account }]),
  );
  const created = new Set<string>();
  const initialized = new Set<string>();
  const closed = new Set<string>();
  const syncNative = new Set<string>();
  const knownInstructionPaths = new Set<string>();
  const isolatedThirdParty = isolatedThirdPartyDflowGroups(tx, wallet);
  const pumpRefunds = provenPumpVolumeRefunds(tx, wallet);
  const tainted = new Set<string>();
  const markUnsupported = (reason: string, mint?: string) => {
    blockers.add(reason);
    if (mint) tainted.add(mint);
    if (
      !blockerEvidence.some(
        (entry) => entry.code === reason && entry.assetIds[0] === mint,
      )
    )
      blockerEvidence.push({
        code: reason,
        scope: mint ? "asset" : "transaction",
        assetIds: mint ? [mint] : [],
      });
  };
  const financialOnly = (reason: string, mint: string) => {
    blockers.add(reason);
    if (
      !blockerEvidence.some(
        (entry) => entry.code === reason && entry.assetIds.includes(mint),
      )
    )
      blockerEvidence.push({
        code: reason,
        scope: "evidence",
        assetIds: [mint],
      });
  };
  if (isolatedThirdParty.size) {
    blockers.add("third_party_effects_not_interpreted");
    blockerEvidence.push({
      code: "third_party_effects_not_interpreted",
      scope: "evidence",
      assetIds: [],
    });
  }
  const movement = (
    input: Omit<SolanaRawMovement, "id" | "amount">,
    suffix: string,
  ) => {
    result.rawMovements.push({
      ...input,
      id: `${id}:${suffix}`,
      amount: solanaDisplayAmount(input.rawAmount, input.decimals),
    });
  };
  if (tx.networkFeeRaw !== null) {
    result.fees.push({
      id: `${id}:network-fee`,
      kind: "network",
      asset: native,
      rawAmount: tx.networkFeeRaw,
      amount: solanaDisplayAmount(tx.networkFeeRaw, 9),
      decimals: 9,
      payerWallet: tx.feePayer,
      chargedToAnalyzedWallet: tx.feePayer === wallet,
    });
  }

  // Accounts created and closed within one transaction can be absent from BOTH
  // token-balance arrays. Recover identity, not balances, from successful
  // initialization plus independently agreeing mint/decimal evidence.
  if (tx.succeeded === true) {
    for (const instruction of tx.instructions) {
      if (
        ![SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM].includes(
          instruction.programId ?? "",
        ) ||
        ![
          "initializeAccount",
          "initializeAccount2",
          "initializeAccount3",
        ].includes(instruction.type ?? "")
      )
        continue;
      const address = solanaText(instruction.info?.account);
      const mint = solanaText(instruction.info?.mint);
      const owner = solanaText(instruction.info?.owner);
      if (!address || !mint || !owner || !accountByAddress.has(address))
        continue;
      const decimals = new Set<number>(
        tx.tokenAccounts
          .filter((account) => account.mint === mint)
          .map((account) => account.decimals),
      );
      for (const checked of tx.instructions) {
        if (
          checked.programId !== instruction.programId ||
          checked.type !== "transferChecked" ||
          checked.info?.mint !== mint
        )
          continue;
        const value = solanaInteger(
          solanaRecord(checked.info.tokenAmount)?.decimals,
        );
        if (value !== null && value <= 255) decimals.add(value);
      }
      if (mint === SOLANA_USDC_MINT) decimals.add(6);
      if (mint === SOLANA_WRAPPED_SOL_MINT) decimals.add(9);
      if (decimals.size !== 1) {
        markUnsupported("token_initialization_decimals_unproven", mint);
        continue;
      }
      const existing = tokenByAddress.get(address);
      if (existing) {
        if (
          existing.mint !== mint ||
          existing.decimals !== [...decimals][0] ||
          (existing.programId && existing.programId !== instruction.programId)
        )
          markUnsupported("token_initialization_identity_conflict", mint);
        continue;
      }
      const token: SolanaTokenAccountBalance = {
        accountAddress: address,
        mint,
        decimals: [...decimals][0],
        preOwner: owner,
        postOwner: owner,
        preRaw: null,
        postRaw: null,
        programId: instruction.programId,
        identityEvidence: "instruction_lifecycle",
      };
      tokenByAddress.set(address, token);
    }
  }

  // On failure, attempted instructions do not prove token effects. A durable
  // nonce MAY advance while fees persist; without nonce data we label the
  // attempted nonce explicitly instead of asserting its post-state.
  if (tx.succeeded === false) {
    const first = tx.instructions.find(
      (instruction) =>
        instruction.outerIndex === 0 && instruction.innerIndex === null,
    );
    if (
      first?.programId === SOLANA_SYSTEM_PROGRAM &&
      first.type === "advanceNonce"
    ) {
      const address = solanaText(first.info?.nonceAccount);
      if (address && accountByAddress.has(address))
        result.lifecycle.push({
          id: `${id}:lifecycle:0`,
          kind: "advance_nonce",
          accountAddress: address,
          wallet: null,
          nativeRawAmount: null,
          authority: solanaText(first.info?.nonceAuthority),
          outerIndex: 0,
          innerIndex: null,
          effectState: "attempted_unproven",
        });
    }
  }
  if (tx.succeeded === true) {
    for (const instruction of tx.instructions) {
      const {
        programId,
        type,
        info,
        path: location,
        outerIndex,
        innerIndex,
      } = instruction;
      if (isolatedThirdParty.has(outerIndex)) {
        knownInstructionPaths.add(location);
        continue;
      }
      const pumpRefund = pumpRefunds.find(
        (r) => r.instruction.path === location,
      );
      if (pumpRefund) {
        movement(
          {
            asset: native,
            rawAmount: pumpRefund.rawAmount,
            decimals: 9,
            fromAccount: pumpRefund.account,
            toAccount: wallet,
            fromWallet: pumpRefund.account,
            toWallet: wallet,
            outerIndex,
            innerIndex,
            classification: "lifecycle",
          },
          `${location}:volume-rent-refund`,
        );
        result.lifecycle.push({
          id: `${id}:lifecycle:${location}`,
          kind: "close_account",
          accountAddress: pumpRefund.account,
          wallet,
          destinationWallet: wallet,
          nativeRawAmount: pumpRefund.rawAmount,
          outerIndex,
          innerIndex,
        });
        knownInstructionPaths.add(location);
        knownInstructionPaths.add(pumpRefund.eventPath);
        continue;
      }
      if (NON_ECONOMIC_PROGRAMS.has(programId ?? "")) {
        knownInstructionPaths.add(location);
        continue;
      }
      if (
        instruction.program === "spl-token-2022" &&
        programId !== SOLANA_TOKEN_2022_PROGRAM
      ) {
        markUnsupported("token_2022_unsupported");
        continue;
      }
      if (
        programId === SOLANA_ASSOCIATED_TOKEN_PROGRAM &&
        ["create", "createIdempotent", "recoverNested"].includes(type ?? "")
      ) {
        if (type === "recoverNested")
          markUnsupported("nested_token_account_recovery_unsupported");
        else knownInstructionPaths.add(location);
        continue;
      }
      if (programId === SOLANA_SYSTEM_PROGRAM && info) {
        if (
          type === "transfer" ||
          type === "transferWithSeed" ||
          type === "createAccount" ||
          type === "createAccountWithSeed"
        ) {
          const from = solanaText(info.source);
          const to =
            solanaText(info.destination) ?? solanaText(info.newAccount);
          const amount = solanaRawAmount(info.lamports);
          if (!from || !to || amount === null) {
            markUnsupported("native_transfer_unknown_or_unsafe", "native");
            continue;
          }
          const lifecycle = type.startsWith("createAccount");
          if (lifecycle) {
            created.add(to);
            result.lifecycle.push({
              id: `${id}:lifecycle:${location}`,
              kind: "create_account",
              accountAddress: to,
              wallet: from,
              nativeRawAmount: amount,
            });
          }
          movement(
            {
              asset: native,
              rawAmount: amount,
              decimals: 9,
              fromAccount: from,
              toAccount: to,
              fromWallet: from,
              toWallet: to,
              outerIndex,
              innerIndex,
              classification: lifecycle ? "lifecycle" : "transfer",
            },
            location,
          );
          knownInstructionPaths.add(location);
          continue;
        }
        if (
          type === "allocate" ||
          type === "assign" ||
          type === "advanceNonce"
        ) {
          const address =
            solanaText(info.account) ?? solanaText(info.nonceAccount);
          const space =
            type === "allocate" ? solanaRawAmount(info.space) : null;
          const ownerProgram =
            type === "assign" ? solanaText(info.owner) : null;
          const authority =
            type === "advanceNonce" ? solanaText(info.nonceAuthority) : null;
          if (
            !address ||
            !accountByAddress.has(address) ||
            (type === "allocate" && space === null) ||
            (type === "assign" && !ownerProgram) ||
            (type === "advanceNonce" && !authority)
          ) {
            markUnsupported("system_lifecycle_evidence_incomplete", "native");
            continue;
          }
          result.lifecycle.push({
            id: `${id}:lifecycle:${location}`,
            kind: type === "advanceNonce" ? "advance_nonce" : type,
            accountAddress: address,
            wallet: null,
            nativeRawAmount: null,
            authority,
            programOwner: ownerProgram,
            outerIndex,
            innerIndex,
            effectState: "observed",
          });
          // System-program ownership is not wallet/person ownership. If the
          // analyzed native account is assigned, its future custody is unknown.
          if (
            type === "assign" &&
            address === wallet &&
            ownerProgram !== SOLANA_SYSTEM_PROGRAM
          )
            markUnsupported("native_program_custody_changed", "native");
          knownInstructionPaths.add(location);
          continue;
        }
        markUnsupported("system_instruction_unsupported", "native");
        continue;
      }
      if (
        (programId === SOLANA_TOKEN_PROGRAM ||
          programId === SOLANA_TOKEN_2022_PROGRAM) &&
        info
      ) {
        if (type === "getAccountDataSize") {
          knownInstructionPaths.add(location);
          continue;
        }
        if (type === "transfer" || type === "transferChecked") {
          const from = solanaText(info.source);
          const to = solanaText(info.destination);
          const amount = solanaRawAmount(
            info.amount ?? solanaRecord(info.tokenAmount)?.amount,
          );
          const source = from ? tokenByAddress.get(from) : null;
          const destination = to ? tokenByAddress.get(to) : null;
          if (
            !from ||
            !to ||
            amount === null ||
            !source ||
            !destination ||
            source.mint !== destination.mint ||
            source.decimals !== destination.decimals
          ) {
            markUnsupported(
              "token_transfer_accounts_unresolved",
              source?.mint ?? destination?.mint,
            );
            continue;
          }
          if (
            [source, destination].some(
              (account) =>
                account.identityEvidence === "instruction_lifecycle" &&
                !initialized.has(account.accountAddress),
            )
          ) {
            markUnsupported(
              "token_transfer_before_initialization",
              source.mint,
            );
            continue;
          }
          if (
            (source.programId && source.programId !== programId) ||
            (destination.programId && destination.programId !== programId) ||
            (type === "transferChecked" &&
              (solanaText(info.mint) !== source.mint ||
                solanaInteger(solanaRecord(info.tokenAmount)?.decimals) !==
                  source.decimals))
          ) {
            markUnsupported("token_transfer_identity_conflict", source.mint);
            continue;
          }
          const fromWallet =
            source.preOwner &&
            source.postOwner &&
            source.preOwner !== source.postOwner
              ? null
              : (source.preOwner ?? source.postOwner);
          const toWallet =
            destination.preOwner &&
            destination.postOwner &&
            destination.preOwner !== destination.postOwner
              ? null
              : (destination.postOwner ?? destination.preOwner);
          if (!fromWallet || !toWallet) {
            markUnsupported("token_transfer_owner_unknown", source.mint);
          }
          movement(
            {
              asset: asset(source.mint),
              rawAmount: amount,
              decimals: source.decimals,
              fromAccount: from,
              toAccount: to,
              fromWallet,
              toWallet,
              outerIndex,
              innerIndex,
              classification: "transfer",
              authority:
                solanaText(info.authority) ??
                solanaText(info.multisigAuthority),
            },
            location,
          );
          knownInstructionPaths.add(location);
          continue;
        }
        if (
          [
            "initializeAccount",
            "initializeAccount2",
            "initializeAccount3",
            "initializeImmutableOwner",
          ].includes(type ?? "")
        ) {
          if (type !== "initializeImmutableOwner") {
            const address = solanaText(info.account);
            const token = address ? tokenByAddress.get(address) : null;
            if (
              !address ||
              !token ||
              (solanaText(info.owner) && info.owner !== token.postOwner) ||
              (solanaText(info.mint) && info.mint !== token.mint)
            ) {
              markUnsupported("token_initialization_unproven", token?.mint);
              continue;
            }
            if (token.preRaw !== null && !created.has(address)) {
              markUnsupported("token_reinitialization_unproven", token.mint);
              continue;
            }
            initialized.add(address);
            // Successful initialization proves custody at account birth, not
            // ownership of any other historical account for this mint.
            if (
              created.has(address) &&
              accountByAddress.get(address)?.preLamports === "0"
            )
              token.preOwner ??= solanaText(info.owner);
            token.postOwner ??= solanaText(info.owner);
          }
          knownInstructionPaths.add(location);
          continue;
        }
        if (type === "syncNative") {
          const address = solanaText(info.account);
          if (
            !address ||
            tokenByAddress.get(address)?.mint !== SOLANA_WRAPPED_SOL_MINT
          )
            markUnsupported("sync_native_account_unresolved");
          else {
            syncNative.add(address);
            knownInstructionPaths.add(location);
          }
          continue;
        }
        if (type === "closeAccount") {
          const address = solanaText(info.account);
          const destination = solanaText(info.destination);
          const account = address ? accountByAddress.get(address) : null;
          const token = address ? tokenByAddress.get(address) : null;
          if (
            !address ||
            !destination ||
            account?.preLamports === null ||
            !account ||
            account.postLamports !== "0"
          ) {
            markUnsupported("close_account_refund_unproven", token?.mint);
            continue;
          }
          // Funding/transfers in this same transaction change the refund. Use
          // the observed pre balance plus preceding explicit native movements.
          let refund = BigInt(account.preLamports);
          for (const item of result.rawMovements.filter(
            (entry) => entry.asset.assetId === "native",
          )) {
            if (item.toAccount === address) refund += BigInt(item.rawAmount);
            if (item.fromAccount === address) refund -= BigInt(item.rawAmount);
          }
          // SPL transfers of wrapped SOL also move lamports between native
          // token accounts before closeAccount returns the remaining balance.
          for (const item of result.rawMovements.filter(
            (entry) => entry.asset.assetId === SOLANA_WRAPPED_SOL_MINT,
          )) {
            if (item.toAccount === address) refund += BigInt(item.rawAmount);
            if (item.fromAccount === address) refund -= BigInt(item.rawAmount);
          }
          if (refund < BigInt(0)) {
            markUnsupported("close_account_refund_unproven", token?.mint);
            continue;
          }
          closed.add(address);
          if (!token) markUnsupported("closed_token_account_identity_unknown");
          const owner = token?.preOwner ?? token?.postOwner ?? null;
          result.lifecycle.push({
            id: `${id}:lifecycle:${location}`,
            kind: "close_account",
            accountAddress: address,
            wallet: owner,
            destinationWallet: destination,
            nativeRawAmount: String(refund),
          });
          movement(
            {
              asset: native,
              rawAmount: String(refund),
              decimals: 9,
              fromAccount: address,
              toAccount: destination,
              fromWallet: address,
              toWallet: destination,
              outerIndex,
              innerIndex,
              classification: "lifecycle",
            },
            `${location}:refund`,
          );
          knownInstructionPaths.add(location);
          continue;
        }
        if (type === "setAuthority" && info.authorityType === "closeAccount") {
          // Closing authority is NOT token ownership. The later actual refund
          // remains subject to exact lifecycle reconciliation.
          knownInstructionPaths.add(location);
          continue;
        }
        if (
          [
            "mintTo",
            "mintToChecked",
            "burn",
            "burnChecked",
            "freezeAccount",
            "thawAccount",
          ].includes(type ?? "")
        ) {
          const address = solanaText(info.account);
          const token = address ? tokenByAddress.get(address) : undefined;
          const mint = solanaText(info.mint);
          const supply = type!.startsWith("mintTo") || type!.startsWith("burn");
          const amount = supply
            ? solanaRawAmount(
                info.amount ?? solanaRecord(info.tokenAmount)?.amount,
              )
            : null;
          const authority =
            solanaText(info.mintAuthority) ??
            solanaText(info.freezeAuthority) ??
            solanaText(info.authority) ??
            solanaText(info.multisigAuthority);
          if (
            !address ||
            !token ||
            mint !== token.mint ||
            (token.programId && token.programId !== programId) ||
            !authority ||
            (supply && amount === null) ||
            (type!.endsWith("Checked") &&
              solanaInteger(solanaRecord(info.tokenAmount)?.decimals) !==
                token.decimals)
          ) {
            markUnsupported(
              "token_authority_effect_unproven",
              mint ?? token?.mint,
            );
            continue;
          }
          const kind = type!.startsWith("mintTo")
            ? "mint"
            : type!.startsWith("burn")
              ? "burn"
              : type === "freezeAccount"
                ? "freeze"
                : "thaw";
          const owner = token.preOwner ?? token.postOwner;
          result.lifecycle.push({
            id: `${id}:lifecycle:${location}`,
            kind,
            accountAddress: address,
            wallet: owner,
            nativeRawAmount: null,
            asset: asset(token.mint),
            rawAmount: amount,
            decimals: token.decimals,
            authority,
            outerIndex,
            innerIndex,
            effectState: "observed",
          });
          if (supply && amount !== null) {
            movement(
              {
                asset: asset(token.mint),
                rawAmount: amount,
                decimals: token.decimals,
                fromAccount:
                  kind === "mint" ? `mint-supply:${token.mint}` : address,
                toAccount:
                  kind === "mint" ? address : `burn-supply:${token.mint}`,
                fromWallet: kind === "mint" ? null : owner,
                toWallet: kind === "mint" ? owner : null,
                outerIndex,
                innerIndex,
                classification: "lifecycle",
                tokenAction: kind as "mint" | "burn",
                authority,
              },
              `${location}:supply`,
            );
            financialOnly(
              "token_supply_change_cost_basis_unproven",
              token.mint,
            );
          }
          knownInstructionPaths.add(location);
          continue;
        }
        if (type === "withdrawWithheldTokensFromAccounts") {
          const destination =
            solanaText(info.feeRecipient) ?? solanaText(info.destination);
          const mint = solanaText(info.mint);
          const token = destination
            ? tokenByAddress.get(destination)
            : undefined;
          const sources = Array.isArray(info.sourceAccounts)
            ? info.sourceAccounts.map(solanaText)
            : [];
          const authority =
            solanaText(info.withdrawWithheldAuthority) ??
            solanaText(info.multisigWithdrawWithheldAuthority) ??
            solanaText(info.authority);
          if (
            destination &&
            mint &&
            token?.mint === mint &&
            authority &&
            sources.length > 0 &&
            sources.every((source) => source && accountByAddress.has(source)) &&
            programId === SOLANA_TOKEN_2022_PROGRAM
          ) {
            result.lifecycle.push({
              id: `${id}:lifecycle:${location}`,
              kind: "withdraw_withheld",
              accountAddress: destination,
              wallet: token.postOwner ?? token.preOwner,
              asset: asset(mint),
              rawAmount: null,
              decimals: token.decimals,
              nativeRawAmount: null,
              authority,
              relatedAccounts: sources as string[],
              outerIndex,
              innerIndex,
              effectState: "observed",
            });
            // Aggregate withheld amounts do not identify per-source costs.
            markUnsupported("withheld_fee_allocation_unproven", mint);
            knownInstructionPaths.add(location);
            continue;
          }
        }
        markUnsupported(
          type === "setAuthority" && info.authorityType === "accountOwner"
            ? "token_account_owner_changed"
            : "token_instruction_unsupported",
          solanaText(info.mint) ??
            tokenByAddress.get(solanaText(info.account) ?? "")?.mint,
        );
        // A decoded token instruction with a proven affected mint is a scoped
        // unsupported effect, not an additional opaque whole-wallet effect.
        if (
          solanaText(info.mint) ||
          tokenByAddress.has(solanaText(info.account) ?? "")
        )
          knownInstructionPaths.add(location);
      }
    }
  }

  // A sponsor's explicitly returned, same-route SOL advance is not funding
  // income or a trade leg. Require the complete pair, signer roles and native
  // endpoint balances; neither leg alone earns this classification.
  for (const parent of tx.instructions.filter(
    (i) =>
      i.innerIndex === null &&
      i.programId === DFLOW_V4_PROGRAM &&
      i.accountAddresses?.[3] === wallet,
  )) {
    const sponsor = tx.feePayer;
    if (
      !sponsor ||
      sponsor === wallet ||
      !tx.accounts.some((a) => a.address === sponsor && a.signer) ||
      !tx.accounts.some(
        (a) =>
          a.address === wallet &&
          a.signer &&
          a.preLamports !== null &&
          a.preLamports === a.postLamports,
      )
    )
      continue;
    const pair = result.rawMovements.filter(
      (m) =>
        m.outerIndex === parent.outerIndex &&
        m.asset.assetId === "native" &&
        ((m.fromAccount === sponsor && m.toAccount === wallet) ||
          (m.fromAccount === wallet && m.toAccount === sponsor)),
    );
    if (pair.length !== 2) continue;
    const [fund, returned] = pair;
    const indexes = pair.map((m) =>
      tx.instructions.find(
        (i) => i.outerIndex === m.outerIndex && i.innerIndex === m.innerIndex,
      ),
    );
    if (
      fund.fromAccount === sponsor &&
      returned.toAccount === sponsor &&
      fund.rawAmount === returned.rawAmount &&
      fund.innerIndex !== null &&
      returned.innerIndex !== null &&
      fund.innerIndex < returned.innerIndex &&
      indexes.every(
        (i) =>
          i?.programId === SOLANA_SYSTEM_PROGRAM &&
          i.type === "transfer" &&
          i.stackHeight === 2,
      ) &&
      pumpRefunds.some(
        (r) =>
          r.instruction.outerIndex === parent.outerIndex &&
          r.instruction.innerIndex! > fund.innerIndex! &&
          r.instruction.innerIndex! < returned.innerIndex!,
      )
    ) {
      fund.classification = "lifecycle";
      returned.classification = "lifecycle";
    }
  }

  // Recover zeros only from account lifecycle evidence, not from an absent
  // token balance entry alone. Owner reassignment is never an ordinary transfer.
  const walletBalances = new Map<string, SolanaWalletBalanceEvidence>();
  const nativeAccount = accountByAddress.get(wallet);
  if (nativeAccount) {
    const { preLamports: preRaw, postLamports: postRaw } = nativeAccount;
    walletBalances.set("native", {
      asset: native,
      decimals: 9,
      preRaw,
      postRaw,
      deltaRaw:
        preRaw !== null && postRaw !== null
          ? String(BigInt(postRaw) - BigInt(preRaw))
          : null,
      accountAddresses: [wallet],
      complete: preRaw !== null && postRaw !== null,
    });
  } else if (
    tx.feePayer === wallet ||
    result.rawMovements.some(
      (item) =>
        item.asset.assetId === "native" &&
        (item.fromWallet === wallet || item.toWallet === wallet),
    )
  )
    markUnsupported("wallet_native_balance_missing", "native");
  // If this public key is absent from the complete account-key list it cannot
  // have had its lamports mutated. Do not fabricate its unobserved SOL balance.
  for (const token of tokenByAddress.values()) {
    if (token.preOwner !== wallet && token.postOwner !== wallet) continue;
    const account = accountByAddress.get(token.accountAddress);
    let preRaw = token.preRaw;
    let postRaw = token.postRaw;
    if (
      preRaw === null &&
      created.has(token.accountAddress) &&
      initialized.has(token.accountAddress) &&
      account?.preLamports === "0"
    )
      preRaw = "0";
    if (
      postRaw === null &&
      closed.has(token.accountAddress) &&
      account?.postLamports === "0"
    )
      postRaw = "0";
    const observationPreRaw = preRaw;
    const observationPostRaw = postRaw;
    if (
      token.preOwner &&
      token.postOwner &&
      token.preOwner !== token.postOwner
    ) {
      markUnsupported("token_account_owner_changed", token.mint);
      preRaw = null;
      postRaw = null;
    }
    const current = walletBalances.get(token.mint);
    // These derived endpoint zeros are backed by the lifecycle checks above.
    // The route adapter may use them, but never invents them from missing arrays.
    token.preRaw = preRaw;
    token.postRaw = postRaw;
    if (current && current.decimals !== token.decimals)
      markUnsupported("token_decimals_conflict", token.mint);
    const combinedPre =
      preRaw === null || (current && current.preRaw === null)
        ? null
        : String(BigInt(preRaw) + BigInt(current?.preRaw ?? "0"));
    const combinedPost =
      postRaw === null || (current && current.postRaw === null)
        ? null
        : String(BigInt(postRaw) + BigInt(current?.postRaw ?? "0"));
    walletBalances.set(token.mint, {
      asset: asset(token.mint),
      decimals: token.decimals,
      preRaw: combinedPre,
      postRaw: combinedPost,
      deltaRaw:
        combinedPre !== null && combinedPost !== null
          ? String(BigInt(combinedPost) - BigInt(combinedPre))
          : null,
      accountAddresses: [
        ...(current?.accountAddresses ?? []),
        token.accountAddress,
      ],
      complete: combinedPre !== null && combinedPost !== null,
      accountObservations: [
        ...(current?.accountObservations ?? []),
        {
          address: token.accountAddress,
          preRaw: observationPreRaw,
          postRaw: observationPostRaw,
          created:
            created.has(token.accountAddress) &&
            initialized.has(token.accountAddress),
          closed: closed.has(token.accountAddress),
          mint: token.mint,
          programId: token.programId,
          preOwner: token.preOwner,
          postOwner: token.postOwner,
          identityEvidence: token.identityEvidence,
        },
      ],
    });
  }
  for (const item of result.rawMovements) {
    const instruction = tx.instructions.find(
      (i) =>
        i.outerIndex === item.outerIndex && i.innerIndex === item.innerIndex,
    );
    if (
      instruction?.programId !== SOLANA_TOKEN_2022_PROGRAM ||
      !["transfer", "transferChecked"].includes(instruction.type ?? "")
    )
      continue;
    item.quantityEvidence = token2022QuantityEvidence(
      tx,
      item,
      result.rawMovements,
      tokenByAddress,
    );
    financialOnly("token_2022_extension_state_unproven", item.asset.assetId);
    if (item.quantityEvidence.state !== "exact")
      markUnsupported(
        item.quantityEvidence.state === "delta_only" &&
          (item.quantityEvidence.debitRaw !== item.rawAmount ||
            item.quantityEvidence.creditRaw !== item.rawAmount)
          ? "token_2022_transfer_difference_unexplained"
          : "token_2022_transfer_effect_unproven",
        item.asset.assetId,
      );
  }
  const movementDelta = (mint: string) =>
    result.rawMovements
      .filter((item) => item.asset.assetId === mint)
      .reduce(
        (sum, item) =>
          sum +
          (item.toWallet === wallet
            ? BigInt(item.quantityEvidence?.creditRaw ?? item.rawAmount)
            : BigInt(0)) -
          (item.fromWallet === wallet
            ? BigInt(item.quantityEvidence?.debitRaw ?? item.rawAmount)
            : BigInt(0)),
        BigInt(0),
      );
  const wsol = walletBalances.get(SOLANA_WRAPPED_SOL_MINT);
  if (tx.succeeded && wsol?.deltaRaw !== null && wsol?.deltaRaw !== undefined) {
    const residual =
      BigInt(wsol.deltaRaw) - movementDelta(SOLANA_WRAPPED_SOL_MINT);
    const matching = [...tokenByAddress.values()].filter(
      (token) =>
        token.mint === SOLANA_WRAPPED_SOL_MINT &&
        (token.preOwner === wallet || token.postOwner === wallet),
    );
    const wrapAccounts = matching.filter(
      (token) =>
        syncNative.has(token.accountAddress) ||
        (created.has(token.accountAddress) &&
          initialized.has(token.accountAddress)),
    );
    const unwrapAccounts = matching.filter((token) =>
      closed.has(token.accountAddress),
    );
    const target =
      residual > BigInt(0) && wrapAccounts.length === 1
        ? wrapAccounts[0]
        : residual < BigInt(0) && unwrapAccounts.length === 1
          ? unwrapAccounts[0]
          : null;
    if (target && residual !== BigInt(0)) {
      const wrap = residual > BigInt(0);
      const rawAmount = String(wrap ? residual : -residual);
      result.lifecycle.push({
        id: `${id}:wsol:${target.accountAddress}`,
        kind: wrap ? "wrap" : "unwrap",
        accountAddress: target.accountAddress,
        wallet,
        nativeRawAmount: rawAmount,
      });
      movement(
        {
          asset: asset(SOLANA_WRAPPED_SOL_MINT),
          rawAmount,
          decimals: 9,
          fromAccount: wrap ? "native-wrap" : target.accountAddress,
          toAccount: wrap ? target.accountAddress : "native-unwrap",
          fromWallet: wrap ? null : wallet,
          toWallet: wrap ? wallet : null,
          outerIndex: -1,
          innerIndex: null,
          classification: "lifecycle",
        },
        `wsol:${target.accountAddress}`,
      );
      for (const item of result.rawMovements) {
        if (
          item.asset.assetId === "native" &&
          (item.toAccount === target.accountAddress ||
            item.fromAccount === target.accountAddress)
        )
          item.classification = "lifecycle";
      }
    }
  }
  result.balanceEvidence = [...walletBalances.values()];
  for (const balance of result.balanceEvidence) {
    if (!balance.complete || balance.deltaRaw === null) {
      markUnsupported("wallet_balance_incomplete", balance.asset.assetId);
      continue;
    }
    const recognized = movementDelta(balance.asset.assetId);
    const paidNetworkFee =
      balance.asset.assetId === "native" &&
      tx.feePayer === wallet &&
      tx.networkFeeRaw !== null
        ? BigInt(tx.networkFeeRaw)
        : BigInt(0);
    const expected = recognized - paidNetworkFee;
    balance.movementCheck = {
      basis: "recognized-movements",
      recognizedDeltaRaw: String(recognized),
      paidNetworkFeeRaw: String(paidNetworkFee),
      expectedDeltaRaw: String(expected),
      observedDeltaRaw: balance.deltaRaw,
      unexplainedDifferenceRaw: String(BigInt(balance.deltaRaw) - expected),
    };
    if (BigInt(balance.deltaRaw) !== expected)
      markUnsupported("unexplained_balance_change", balance.asset.assetId);
  }

  const routeEvidence = analyzeSolanaRouteEvidence(
    tx,
    result.rawMovements,
    context,
    [...tokenByAddress.values()],
  );
  for (const location of routeEvidence.recognizedInstructionPaths)
    knownInstructionPaths.add(location);
  for (const reason of routeEvidence.blockers) markUnsupported(reason);
  for (const deposit of routeEvidence.deposits) {
    const item = result.rawMovements.find(
      (movement) => movement.id === deposit.movementId,
    );
    if (item) item.executionProtocol = "relay-depository";
  }
  if (routeEvidence.swaps.length) result.executionProtocol = "dflow-v4";
  else if (routeEvidence.deposits.length)
    result.executionProtocol = "relay-depository";
  const { fomoFeeProven, hasAppFeeCandidates } = applyFomoFeeEvidence({
    transactionId: id,
    context,
    tokenByAddress,
    feeEvidence: routeEvidence.feeEvidence,
    result,
    blockers,
    markUnsupported,
    displayAmount: solanaDisplayAmount,
  });
  for (const route of routeEvidence.swaps) {
    if (!tx.signature || !tx.blockTime) continue;
    for (const item of result.rawMovements)
      if (route.movementIds.includes(item.id)) {
        item.classification = "swap_leg";
        item.executionProtocol = "dflow-v4";
      }
    result.swaps.push({
      kind: "swap",
      id: `${id}:swap:${route.outerIndex}`,
      executedAt: tx.blockTime,
      eventOrder: context.transactionOrder,
      wallet,
      input: {
        asset: asset(route.input.mint),
        amount: solanaDisplayAmount(
          route.input.rawAmount,
          route.input.decimals,
        ),
      },
      output: {
        asset: asset(route.output.mint),
        amount: solanaDisplayAmount(
          route.output.rawAmount,
          route.output.decimals,
        ),
      },
      fees: result.fees
        .filter(
          (fee) =>
            fee.chargedToAnalyzedWallet && BigInt(fee.rawAmount) > BigInt(0),
        )
        .map((fee) => ({ asset: fee.asset, amount: fee.amount })),
    });
    result.sourceScope = fomoFeeProven ? "fomo_routed" : "wallet_all_activity";
  }
  const tradeLegs = result.rawMovements.filter(
    (item) =>
      item.classification === "transfer" &&
      (item.fromWallet === wallet || item.toWallet === wallet) &&
      item.fromWallet !== item.toWallet,
  );
  const groups = new Set(tradeLegs.map((item) => item.outerIndex));
  const groupIndex = groups.size === 1 ? [...groups][0] : null;
  const parent =
    groupIndex === null
      ? null
      : tx.instructions.find(
          (instruction) =>
            instruction.outerIndex === groupIndex &&
            instruction.innerIndex === null,
        );
  const groupedExecution =
    parent &&
    parent.programId &&
    ![
      SOLANA_SYSTEM_PROGRAM,
      SOLANA_TOKEN_PROGRAM,
      SOLANA_ASSOCIATED_TOKEN_PROGRAM,
    ].includes(parent.programId) &&
    tradeLegs.length >= 2 &&
    tradeLegs.every((item) => item.innerIndex !== null);
  const legDeltas = new Map<string, bigint>();
  for (const item of tradeLegs)
    legDeltas.set(
      item.asset.assetId,
      (legDeltas.get(item.asset.assetId) ?? BigInt(0)) +
        (item.toWallet === wallet ? BigInt(item.rawAmount) : BigInt(0)) -
        (item.fromWallet === wallet ? BigInt(item.rawAmount) : BigInt(0)),
    );
  const negatives = [...legDeltas].filter(([, delta]) => delta < BigInt(0));
  const positives = [...legDeltas].filter(([, delta]) => delta > BigInt(0));
  const supportedSwap = Boolean(
    result.swaps.length === 0 &&
    parent?.programId !== DFLOW_V4_PROGRAM &&
    groupedExecution &&
    (fomoFeeProven ||
      (parent?.programId &&
        context.supportedSwapPrograms?.has(parent.programId))) &&
    negatives.length === 1 &&
    positives.length === 1 &&
    negatives[0][0] !== positives[0][0],
  );
  if (supportedSwap && tx.signature && tx.blockTime) {
    const relevantGroup = parent!.outerIndex;
    // Grouped CPI execution supplies economic grouping; fee-vault evidence,
    // not a generic router ID, supplies the Fomo attribution.
    for (const instruction of tx.instructions.filter(
      (instruction) => instruction.outerIndex === relevantGroup,
    )) {
      if (instruction.innerIndex === null)
        knownInstructionPaths.add(instruction.path);
    }
    for (const item of tradeLegs) item.classification = "swap_leg";
    const input = walletBalances.get(negatives[0][0]);
    const output = walletBalances.get(positives[0][0]);
    if (!input || !output) markUnsupported("swap_asset_balance_missing");
    else {
      const fees: CanonicalSpotFee[] = result.fees
        .filter(
          (fee) =>
            fee.chargedToAnalyzedWallet && BigInt(fee.rawAmount) > BigInt(0),
        )
        .map((fee) => ({ asset: fee.asset, amount: fee.amount }));
      result.swaps.push({
        kind: "swap",
        id: `${id}:swap:${relevantGroup}`,
        executedAt: tx.blockTime,
        eventOrder: context.transactionOrder,
        wallet,
        input: {
          asset: input.asset,
          amount: solanaDisplayAmount(String(-negatives[0][1]), input.decimals),
        },
        output: {
          asset: output.asset,
          amount: solanaDisplayAmount(String(positives[0][1]), output.decimals),
        },
        fees,
      });
      result.sourceScope = fomoFeeProven
        ? "fomo_routed"
        : "wallet_all_activity";
    }
  } else if (result.swaps.length === 0 && hasAppFeeCandidates)
    markUnsupported("fomo_grouped_swap_not_proven");
  else if (result.swaps.length === 0 && groupedExecution)
    markUnsupported("swap_program_unverified");

  if (tx.succeeded) {
    for (const instruction of tx.instructions) {
      if (!knownInstructionPaths.has(instruction.path))
        markUnsupported("instruction_effect_unsupported");
    }
  }
  for (const item of result.rawMovements) {
    if (
      item.classification !== "transfer" ||
      item.fromWallet === item.toWallet ||
      !tx.blockTime
    )
      continue;
    if (item.fromWallet !== wallet && item.toWallet !== wallet) continue;
    const from =
      item.fromWallet && owned.has(item.fromWallet) ? item.fromWallet : null;
    const to = item.toWallet && owned.has(item.toWallet) ? item.toWallet : null;
    result.transfers.push({
      kind: "transfer",
      id: `${item.id}:transfer`,
      executedAt: tx.blockTime,
      eventOrder: context.transactionOrder,
      asset: item.asset,
      amount: item.amount,
      fromWallet: from,
      toWallet: to,
      costBasisStatus:
        from && to ? "preserved" : to ? "unknown" : "not_applicable",
    });
  }
  if (result.swaps.length && result.transfers.length)
    result.sourceScope = "mixed";
  const orderedEvents: NonNullable<SolanaEconomicTransaction["economicOrder"]> =
    [];
  const ranges = new Map<string, { start: number; end: number }>();
  const instructionPosition = (
    item: Pick<SolanaRawMovement, "outerIndex" | "innerIndex">,
  ) =>
    tx.instructions.findIndex(
      (instruction) =>
        instruction.outerIndex === item.outerIndex &&
        instruction.innerIndex === item.innerIndex,
    );
  for (const swap of result.swaps) {
    const match = /:swap:(\d+)$/.exec(swap.id);
    const legs = match
      ? result.rawMovements.filter(
          (item) =>
            (item.classification === "swap_leg" &&
              item.outerIndex === Number(match[1])) ||
            (result.swaps.length === 1 &&
              item.classification === "app_fee" &&
              item.fromWallet === wallet),
        )
      : [];
    const positions = legs.map(instructionPosition);
    if (
      match &&
      positions.length >= 2 &&
      positions.every((position) => position >= 0)
    ) {
      const range = {
        start: Math.min(...positions),
        end: Math.max(...positions),
      };
      ranges.set(swap.id, range);
      const last = tx.instructions[range.end];
      orderedEvents.push({
        eventId: swap.id,
        outerIndex: last.outerIndex,
        innerIndex: last.innerIndex,
        ordinal: 0,
        atomic: true,
      });
    }
  }
  for (const transfer of result.transfers) {
    const item = result.rawMovements.find(
      (movement) => `${movement.id}:transfer` === transfer.id,
    );
    const position = item ? instructionPosition(item) : -1;
    if (item && position >= 0) {
      ranges.set(transfer.id, { start: position, end: position });
      orderedEvents.push({
        eventId: transfer.id,
        outerIndex: item.outerIndex,
        innerIndex: item.innerIndex,
        ordinal: 0,
        atomic: false,
      });
    }
  }
  orderedEvents.sort(
    (a, b) =>
      a.outerIndex - b.outerIndex ||
      (a.innerIndex ?? -1) - (b.innerIndex ?? -1),
  );
  orderedEvents.forEach((event, ordinal) => {
    event.ordinal = ordinal;
  });
  result.economicOrder = orderedEvents;
  result.economicOrderProven =
    result.orderProven &&
    orderedEvents.length === result.swaps.length + result.transfers.length &&
    orderedEvents.every(
      (event, index) =>
        event.outerIndex >= 0 &&
        !orderedEvents.some(
          (other, otherIndex) =>
            index !== otherIndex &&
            ranges.get(event.eventId)!.start <=
              ranges.get(other.eventId)!.end &&
            ranges.get(other.eventId)!.start <= ranges.get(event.eventId)!.end,
        ),
    );
  if (!result.economicOrderProven && orderedEvents.length > 1)
    markUnsupported("economic_instruction_order_unproven");
  if (
    result.swaps.length > 1 &&
    result.fees.some(
      (fee) => fee.chargedToAnalyzedWallet && BigInt(fee.rawAmount) > BigInt(0),
    )
  )
    markUnsupported("multi_swap_fee_allocation_unproven");
  if (
    result.swaps.length === 0 &&
    result.routingEvidence.state === "fomo_routed"
  )
    result.routingEvidence = {
      ...result.routingEvidence,
      state: "unavailable",
      method: null,
    };
  result.economicClassification = result.swaps.length
    ? "swap"
    : result.transfers.length
      ? "transfer"
      : result.lifecycle.length
        ? "lifecycle"
        : result.fees.length
          ? "fee_only"
          : "unresolved";
  result.feesComplete =
    tx.networkFeeRaw !== null &&
    ![...blockers].some(
      (reason) =>
        ![
          "transaction_order_unproven",
          "finality_unavailable",
          "block_time_unavailable",
        ].includes(reason),
    );
  for (const code of blockers)
    if (!blockerEvidence.some((entry) => entry.code === code))
      blockerEvidence.push({ code, scope: "evidence", assetIds: [] });
  if (blockerEvidence.some((entry) => entry.scope === "transaction"))
    for (const balance of result.balanceEvidence)
      tainted.add(balance.asset.assetId);
  result.blockerEvidence = blockerEvidence;
  result.taintedAssets = [...tainted].sort();
  result.blockers = [...blockers].sort();
  result.state =
    blockers.size === 0
      ? "parsed"
      : result.rawMovements.length || result.fees.length
        ? "partial"
        : "unsupported";
  for (const item of result.rawMovements) {
    // Exact endpoint quantities remain inspectable even when financial history
    // is incomplete. An unresolved router still blocks economic classification.
    const quantityOnlyLimit =
      (item.quantityEvidence?.state === "exact" ||
        (isolatedThirdParty.size > 0 &&
          item.classification === "transfer" &&
          (item.fromWallet === wallet || item.toWallet === wallet) &&
          instructionOfLegacyTransfer(item, tx))) &&
      !blockerEvidence.some(
        (entry) =>
          entry.scope === "transaction" ||
          (entry.scope === "asset" &&
            entry.assetIds.includes(item.asset.assetId)),
      );
    item.economicState =
      result.state === "parsed" || quantityOnlyLimit
        ? "confirmed"
        : "unclassified";
  }
  return result;
}
