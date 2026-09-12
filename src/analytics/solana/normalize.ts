import type {
  NormalizedSolanaTransaction,
  SolanaNormalizedInstruction,
  SolanaProvenance,
  SolanaTokenAccountBalance,
} from "./types";
import { SOLANA_WRAPPED_SOL_MINT } from "./types";
import { SOLANA_USDC_MINT } from "./route-constants";

export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export function solanaRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export function solanaText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
export function solanaInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
export function solanaRawAmount(value: unknown): string | null {
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) {
    const raw = BigInt(value);
    return raw <= BigInt("18446744073709551615") ? raw.toString() : null;
  }
  const integer = solanaInteger(value);
  return integer === null ? null : String(integer);
}

/** Pure envelope normalization. A provider-requested commitment remains provenance, not independent chain verification. */
export function normalizeSolanaTransaction(
  raw: unknown,
  provenance: SolanaProvenance,
): NormalizedSolanaTransaction {
  if (
    !provenance.source ||
    !/^[a-f0-9]{64}$/i.test(provenance.payloadSha256) ||
    (provenance.archivePayloadSha256 !== undefined &&
      !/^[a-f0-9]{64}$/i.test(provenance.archivePayloadSha256))
  ) {
    throw new Error("Invalid Solana provenance hash or source.");
  }
  const record = solanaRecord(raw);
  const transaction = solanaRecord(record?.transaction);
  const message = solanaRecord(transaction?.message);
  const meta = solanaRecord(record?.meta);
  const blockers = new Set<string>();
  const signature = Array.isArray(transaction?.signatures)
    ? solanaText(transaction.signatures[0])
    : null;
  const slot = solanaInteger(record?.slot);
  const seconds = solanaInteger(record?.blockTime);
  const blockTime =
    seconds !== null && seconds <= 8_640_000_000_000
      ? new Date(seconds * 1_000).toISOString()
      : null;
  const rawVersion = record?.version;
  const version =
    rawVersion === 0
      ? 0
      : rawVersion === undefined || rawVersion === "legacy"
        ? "legacy"
        : "unsupported";
  if (!signature || slot === null || !message || !meta)
    blockers.add("transaction_envelope_incomplete");
  if (version === "unsupported")
    blockers.add("transaction_version_unsupported");
  if (!blockTime) blockers.add("block_time_unavailable");
  const networkFeeRaw = solanaRawAmount(meta?.fee);
  if (networkFeeRaw === null) blockers.add("network_fee_unknown_or_unsafe");
  const succeeded =
    meta && Object.hasOwn(meta, "err") ? meta.err === null : null;
  if (succeeded === null) blockers.add("transaction_status_unknown");
  const keys = Array.isArray(message?.accountKeys)
    ? [...message.accountKeys]
    : [];
  const loaded = solanaRecord(meta?.loadedAddresses);
  const loadedKeys = [
    ...(Array.isArray(loaded?.writable) ? loaded.writable : []),
    ...(Array.isArray(loaded?.readonly) ? loaded.readonly : []),
  ];
  // jsonParsed includes loaded keys; compiled legacy/v0 messages contain only
  // static keys and require the loaded-address suffix in writable/read-only order.
  const alreadyExpanded = keys.some(
    (key) => solanaRecord(key)?.source === "lookupTable",
  );
  if (!alreadyExpanded) {
    for (const [loadedIndex, loadedKey] of loadedKeys.entries()) {
      const address = solanaText(loadedKey);
      // Account indices address this exact suffix. Never dedupe/reindex it.
      keys.push({
        pubkey: address ?? "",
        signer: false,
        writable:
          loadedIndex <
          (Array.isArray(loaded?.writable) ? loaded.writable.length : 0),
        source: "lookupTable",
      });
    }
  }
  const requiredSigners = solanaInteger(
    solanaRecord(message?.header)?.numRequiredSignatures,
  );
  const header = solanaRecord(message?.header);
  const readonlySigned = solanaInteger(header?.numReadonlySignedAccounts);
  const readonlyUnsigned = solanaInteger(header?.numReadonlyUnsignedAccounts);
  const staticCount = keys.length - (alreadyExpanded ? 0 : loadedKeys.length);
  const pre = Array.isArray(meta?.preBalances) ? meta.preBalances : [];
  const post = Array.isArray(meta?.postBalances) ? meta.postBalances : [];
  if (
    pre.length !== keys.length ||
    post.length !== keys.length ||
    keys.length === 0
  )
    blockers.add("native_balance_arrays_incomplete");
  const accounts = keys.map((key, index) => {
    const object = solanaRecord(key);
    const address = solanaText(key) ?? solanaText(object?.pubkey) ?? "";
    const preLamports = solanaRawAmount(pre[index]);
    const postLamports = solanaRawAmount(post[index]);
    if (!address) blockers.add("account_key_unresolved");
    if (preLamports === null || postLamports === null)
      blockers.add("native_balance_unknown_or_unsafe");
    return {
      address,
      signer:
        object?.signer === true ||
        (requiredSigners !== null && index < requiredSigners),
      writable:
        typeof object?.writable === "boolean"
          ? object.writable
          : requiredSigners !== null &&
              readonlySigned !== null &&
              readonlyUnsigned !== null &&
              index < staticCount
            ? index < requiredSigners
              ? index < requiredSigners - readonlySigned
              : index < staticCount - readonlyUnsigned
            : null,
      preLamports,
      postLamports,
    };
  });
  if (
    new Set(accounts.map((account) => account.address)).size !== accounts.length
  )
    blockers.add("account_keys_duplicate_or_conflicting");
  const tokenMap = new Map<string, SolanaTokenAccountBalance>();
  for (const side of ["pre", "post"] as const) {
    const list = meta?.[`${side}TokenBalances`];
    if (!Array.isArray(list)) {
      blockers.add("token_balance_arrays_incomplete");
      continue;
    }
    for (const item of list) {
      const point = solanaRecord(item);
      const index = solanaInteger(point?.accountIndex);
      const mint = solanaText(point?.mint);
      const amount = solanaRecord(point?.uiTokenAmount);
      const decimals = solanaInteger(amount?.decimals);
      const rawAmount = solanaRawAmount(amount?.amount);
      const address = index === null ? null : accounts[index]?.address;
      if (
        !address ||
        !mint ||
        decimals === null ||
        decimals > 255 ||
        rawAmount === null
      ) {
        blockers.add("token_balance_unknown_or_unsafe");
        continue;
      }
      const key = `${address}:${mint}`;
      if (
        (mint === SOLANA_USDC_MINT && decimals !== 6) ||
        (mint === SOLANA_WRAPPED_SOL_MINT && decimals !== 9)
      )
        blockers.add("known_mint_decimals_conflict");
      const current = tokenMap.get(key) ?? {
        accountAddress: address,
        mint,
        decimals,
        preOwner: null,
        postOwner: null,
        preRaw: null,
        postRaw: null,
        programId: solanaText(point?.programId),
        identityEvidence: "balance_metadata" as const,
      };
      if (current.decimals !== decimals || current[`${side}Raw`] !== null)
        blockers.add("token_balance_conflict");
      current[`${side}Raw`] = rawAmount;
      current[`${side}Owner`] = solanaText(point?.owner);
      const tokenProgramId = solanaText(point?.programId);
      if (
        current.programId &&
        tokenProgramId &&
        current.programId !== tokenProgramId
      )
        blockers.add("token_program_conflict");
      current.programId ??= tokenProgramId;
      if (!current[`${side}Owner`]) blockers.add("token_account_owner_unknown");
      tokenMap.set(key, current);
    }
  }
  for (const token of tokenMap.values()) {
    if (token.preOwner && token.postOwner && token.preOwner !== token.postOwner)
      blockers.add("token_account_owner_changed");
  }
  const accountMints = new Map<string, string>();
  for (const token of tokenMap.values()) {
    const prior = accountMints.get(token.accountAddress);
    if (prior && prior !== token.mint)
      blockers.add("token_account_mint_changed");
    accountMints.set(token.accountAddress, token.mint);
  }
  const instructions: SolanaNormalizedInstruction[] = [];
  const appendInstruction = (
    rawInstruction: unknown,
    outerIndex: number,
    innerIndex: number | null,
  ) => {
    const instruction = solanaRecord(rawInstruction);
    const programIndex = solanaInteger(instruction?.programIdIndex);
    const programId =
      solanaText(instruction?.programId) ??
      (programIndex === null
        ? null
        : (accounts[programIndex]?.address ?? null));
    const parsed = solanaRecord(instruction?.parsed);
    const accountAddresses = Array.isArray(instruction?.accounts)
      ? instruction.accounts.map((entry) => {
          const index = solanaInteger(entry);
          const address =
            solanaText(entry) ??
            (index === null ? null : accounts[index]?.address);
          if (
            !address ||
            !accounts.some((account) => account.address === address)
          )
            blockers.add("instruction_account_unresolved");
          return address ?? "";
        })
      : undefined;
    const data = solanaText(instruction?.data);
    if (!programId) blockers.add("instruction_program_unresolved");
    instructions.push({
      programId,
      program: solanaText(instruction?.program),
      type: solanaText(parsed?.type),
      info: solanaRecord(parsed?.info),
      outerIndex,
      innerIndex,
      stackHeight: solanaInteger(instruction?.stackHeight),
      path:
        innerIndex === null
          ? String(outerIndex)
          : `${outerIndex}.${innerIndex}`,
      accountAddresses,
      data,
      dataEncoding:
        data && /^[1-9A-HJ-NP-Za-km-z]+$/.test(data) ? "base58" : "unknown",
    });
  };
  const outer = Array.isArray(message?.instructions)
    ? message.instructions
    : [];
  if (!Array.isArray(message?.instructions))
    blockers.add("instructions_missing");
  const inner = Array.isArray(meta?.innerInstructions)
    ? meta.innerInstructions
    : [];
  outer.forEach((instruction, index) => {
    appendInstruction(instruction, index, null);
    for (const groupRaw of inner) {
      const group = solanaRecord(groupRaw);
      if (group?.index !== index) continue;
      if (!Array.isArray(group.instructions)) {
        blockers.add("inner_instructions_invalid");
        continue;
      }
      group.instructions.forEach((child, childIndex) =>
        appendInstruction(child, index, childIndex),
      );
    }
  });
  for (const groupRaw of inner) {
    const index = solanaInteger(solanaRecord(groupRaw)?.index);
    if (index === null || index >= outer.length)
      blockers.add("inner_instruction_parent_unresolved");
  }
  return {
    state: blockers.size > 0 ? "unsupported" : "normalized",
    signature,
    slot,
    transactionIndex: solanaInteger(record?.transactionIndex),
    blockTime,
    version,
    succeeded,
    feePayer: accounts[0]?.address ?? null,
    networkFeeRaw,
    accounts,
    tokenAccounts: [...tokenMap.values()],
    instructions,
    logMessages: Array.isArray(meta?.logMessages)
      ? meta.logMessages.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    provenance: { ...provenance },
    blockers: [...blockers].sort(),
  };
}
