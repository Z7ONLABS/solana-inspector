import Decimal from "decimal.js";
import { SOLANA_TOKEN_2022_PROGRAM } from "./normalize";
import {
  DFLOW_V4_PROGRAM,
  FOMO_SOLANA_FEE_OWNER,
  RELAY_SOLANA_DEPOSITORY,
  ROUTE_ASSOCIATED_PROGRAM,
  ROUTE_TOKEN_PROGRAM,
  SOLANA_NATIVE_MINT,
  SOLANA_USDC_MINT,
} from "./route-constants";
import type {
  NormalizedSolanaTransaction,
  SolanaNormalizedInstruction,
  SolanaRawMovement,
  SolanaTokenAccountBalance,
  SolanaWalletContext,
} from "./types";

// Minimal public wire facts. Pinned sources and notices: docs/research/solana-parser-sources.md.
// No general IDL execution, program-wide allowlist, provider or financial engine here.
const RELAY_DEPOSIT = "0b9c60da27a3b413";
const DFLOW_SWAP = "f8c69e91e17587c8";
const EVENT_CPI = "e445a52e51cb9a1d";
const SWAP_EVENT = "40c6cde8260871e2";
const FEE_EVENT = "494f4e7fb8d50ddc";
const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_FEES = "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ";
const PUMP_EVENT_AUTHORITY = "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR";
const PUMP_CLOSE_VOLUME = "f945a4da9667548a";
// Official pump-public-docs 9c82f61cb711b044a17f770ab8ce9f9bdf78f333.
// Only the observed close lifecycle and non-mutating event/fee query contracts.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ZERO = BigInt(0);

export type RouteAmount = { mint: string; decimals: number; rawAmount: string };
export type SolanaRouteEvidence = {
  recognizedInstructionPaths: string[];
  swaps: Array<{
    outerIndex: number;
    protocol: "dflow_v4";
    walletAddress: string;
    movementIds: string[];
    feeMovementIds: string[];
    input: RouteAmount;
    output: RouteAmount;
  }>;
  deposits: Array<{
    outerIndex: number;
    protocol: "relay";
    movementId: string;
  }>;
  feeEvidence: {
    state: "proven" | "not_observed" | "ambiguous";
    walletAddress: string | null;
    rawAmount: string;
    movementIds: string[];
    vaultAccounts: string[];
  };
  blockers: string[];
};

/** The CPI privilege boundary proves this other user's call cannot touch a
 * wallet account. Its economics remain unknown, rather than becoming our swap. */
export function isolatedThirdPartyDflowGroups(
  tx: NormalizedSolanaTransaction,
  wallet: string,
): Set<number> {
  const result = new Set<number>();
  if (
    tx.succeeded !== true ||
    tx.accounts.some((a) => a.address === wallet && a.signer)
  )
    return result;
  const own = new Set([
    wallet,
    ...tx.tokenAccounts
      .filter((a) => a.preOwner === wallet || a.postOwner === wallet)
      .map((a) => a.accountAddress),
  ]);
  for (const instruction of tx.instructions) {
    const roles = instruction.accountAddresses;
    const data =
      instruction.dataEncoding === "base58"
        ? decodeRouteData(instruction.data)
        : null;
    if (
      instruction.innerIndex !== null ||
      instruction.programId !== DFLOW_V4_PROGRAM ||
      !data ||
      data.length < 24 ||
      hex(data) !== DFLOW_SWAP ||
      !roles ||
      roles.length < 6 ||
      roles[3] === wallet ||
      roles.some((a) => own.has(a)) ||
      !tx.accounts.some((a) => a.address === roles[3] && a.signer)
    )
      continue;
    if (
      tx.instructions.some(
        (i) =>
          i.outerIndex === instruction.outerIndex &&
          (i.accountAddresses?.some((a) => own.has(a)) ||
            Object.values(i.info ?? {}).some(
              (v) => typeof v === "string" && own.has(v),
            )),
      )
    )
      continue;
    result.add(instruction.outerIndex);
  }
  return result;
}

/** Bounded base58 decode: invalid text is never coerced to zero. */
export function decodeRouteData(
  text: string | null | undefined,
): Uint8Array | null {
  if (!text || text.length > 4096) return null;
  let n = ZERO;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) return null;
    n = n * BigInt(58) + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > ZERO) {
    bytes.unshift(Number(n % BigInt(256)));
    n /= BigInt(256);
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function base58(bytes: Uint8Array): string {
  let n = ZERO;
  for (const byte of bytes) n = n * BigInt(256) + BigInt(byte);
  let output = "";
  while (n > ZERO) {
    output = ALPHABET[Number(n % BigInt(58))] + output;
    n /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    output = "1" + output;
  }
  return output;
}
function hex(bytes: Uint8Array | null, from = 0, to = 8): string {
  return bytes
    ? [...bytes.slice(from, to)]
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("")
    : "";
}
function u64(bytes: Uint8Array, offset: number): bigint {
  let value = ZERO;
  for (let i = offset + 7; i >= offset; i--)
    value = value * BigInt(256) + BigInt(bytes[i]);
  return value;
}
function owner(account: SolanaTokenAccountBalance | undefined): string | null {
  return account?.preOwner && account.preOwner === account.postOwner
    ? account.preOwner
    : null;
}
function raw(value: unknown): string | null {
  return typeof value === "string" &&
    /^\d{1,20}$/.test(value) &&
    BigInt(value) <= BigInt("18446744073709551615")
    ? value
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function ordered(a: SolanaRawMovement, b: SolanaRawMovement): boolean {
  return (
    a.outerIndex === b.outerIndex &&
    a.innerIndex !== null &&
    b.innerIndex !== null &&
    a.innerIndex < b.innerIndex
  );
}
function instructionOf(
  tx: NormalizedSolanaTransaction,
  movement: SolanaRawMovement,
) {
  return tx.instructions.find(
    (i) =>
      i.outerIndex === movement.outerIndex &&
      i.innerIndex === movement.innerIndex,
  );
}
function uniqueAccounts(accounts: readonly SolanaTokenAccountBalance[]) {
  const map = new Map<string, SolanaTokenAccountBalance>();
  const duplicates = new Set<string>();
  for (const account of accounts) {
    if (map.has(account.accountAddress)) duplicates.add(account.accountAddress);
    map.set(account.accountAddress, account);
  }
  for (const duplicate of duplicates) map.delete(duplicate);
  return map;
}

export function provenPumpVolumeRefunds(
  tx: NormalizedSolanaTransaction,
  wallet: string,
) {
  const refunds: Array<{
    instruction: SolanaNormalizedInstruction;
    eventPath: string;
    account: string;
    rawAmount: string;
  }> = [];
  if (tx.succeeded !== true) return refunds;
  for (const [index, i] of tx.instructions.entries()) {
    const data = i.dataEncoding === "base58" ? decodeRouteData(i.data) : null;
    const roles = i.accountAddresses;
    if (
      i.programId !== PUMP_AMM ||
      !data ||
      data.length !== 8 ||
      hex(data) !== PUMP_CLOSE_VOLUME ||
      !roles ||
      roles.length !== 4 ||
      roles[0] !== wallet ||
      roles[2] !== PUMP_EVENT_AUTHORITY ||
      roles[3] !== PUMP_AMM ||
      !tx.accounts.some((a) => a.address === wallet && a.signer) ||
      i.innerIndex === null ||
      i.stackHeight !== 2
    )
      continue;
    const account = tx.accounts.find((a) => a.address === roles[1]);
    const creation = tx.instructions
      .slice(0, index)
      .filter(
        (x) =>
          x.programId === SOLANA_NATIVE_MINT &&
          x.type === "createAccount" &&
          x.info?.newAccount === roles[1] &&
          x.info?.owner === PUMP_AMM &&
          x.info?.source === wallet,
      );
    const event = tx.instructions[index + 1];
    const eventData =
      event?.dataEncoding === "base58" ? decodeRouteData(event.data) : null;
    if (
      account?.preLamports !== "0" ||
      account.postLamports !== "0" ||
      creation.length !== 1 ||
      event?.programId !== PUMP_AMM ||
      event.outerIndex !== i.outerIndex ||
      event.stackHeight !== 3 ||
      event.accountAddresses?.length !== 1 ||
      event.accountAddresses[0] !== PUMP_EVENT_AUTHORITY ||
      !eventData ||
      eventData.length !== 88 ||
      hex(eventData) !== EVENT_CPI ||
      hex(eventData, 8, 16) !== "929fbdac925838f4" ||
      base58(eventData.slice(16, 48)) !== wallet
    )
      continue;
    const amount = creation[0].info?.lamports;
    const value =
      typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0
        ? String(amount)
        : raw(amount);
    if (
      !value ||
      BigInt(value) <= ZERO ||
      creation[0].outerIndex !== i.outerIndex ||
      tx.instructions.some(
        (x) =>
          x !== creation[0] &&
          x !== i &&
          x !== event &&
          x.programId === SOLANA_NATIVE_MINT &&
          Object.values(x.info ?? {}).includes(roles[1]),
      )
    )
      continue;
    const next = tx.instructions[index + 2];
    if (
      next?.outerIndex === i.outerIndex &&
      next.innerIndex !== null &&
      (next.stackHeight === null || next.stackHeight > 2)
    )
      continue;
    refunds.push({
      instruction: i,
      eventPath: event.path,
      account: roles[1],
      rawAmount: value,
    });
  }
  return refunds;
}

function readOnlyPumpInstruction(
  tx: NormalizedSolanaTransaction,
  i: SolanaNormalizedInstruction,
): boolean {
  const data = i.dataEncoding === "base58" ? decodeRouteData(i.data) : null;
  const roles = i.accountAddresses ?? [];
  if (
    !data ||
    !roles.length ||
    !roles.every((a) =>
      tx.accounts.some((x) => x.address === a && x.writable === false),
    )
  )
    return false;
  if (
    i.programId === PUMP_FEES &&
    roles.length === 2 &&
    roles[1] === PUMP_AMM &&
    hex(data) === "e7257e55cf5b3f34" &&
    [33, 34].includes(data.length) &&
    data[8] <= 1 &&
    (data.length === 33 || data[33] <= 1)
  )
    return true;
  return (
    i.programId === PUMP_AMM &&
    roles.length === 1 &&
    roles[0] === PUMP_EVENT_AUTHORITY &&
    hex(data) === EVENT_CPI &&
    ["67f4521f2cf57777", "3e2f370aa503dc2a", "929fbdac925838f4"].includes(
      hex(data, 8, 16),
    )
  );
}

/** A narrow extractor for the attribution adapter; economic.ts remains the full normalizer. */
export function extractRouteTokenMovements(
  tx: NormalizedSolanaTransaction,
): SolanaRawMovement[] {
  const accounts = uniqueAccounts(tx.tokenAccounts);
  const movements: SolanaRawMovement[] = [];
  for (const i of tx.instructions) {
    if (
      i.programId !== ROUTE_TOKEN_PROGRAM ||
      !["transfer", "transferChecked"].includes(i.type ?? "") ||
      !i.info
    )
      continue;
    const from = text(i.info.source),
      to = text(i.info.destination);
    const source = from ? accounts.get(from) : undefined,
      destination = to ? accounts.get(to) : undefined;
    const checked =
      i.info.tokenAmount && typeof i.info.tokenAmount === "object"
        ? (i.info.tokenAmount as Record<string, unknown>)
        : null;
    const amount = raw(i.info.amount ?? checked?.amount);
    if (
      !from ||
      !to ||
      !source ||
      !destination ||
      source.mint !== destination.mint ||
      source.decimals !== destination.decimals ||
      !amount
    )
      continue;
    movements.push({
      id: i.path,
      asset: { chain: "solana", assetId: source.mint },
      rawAmount: amount,
      amount: new Decimal(amount)
        .div(new Decimal(10).pow(source.decimals))
        .toFixed(),
      decimals: source.decimals,
      fromAccount: from,
      toAccount: to,
      fromWallet: owner(source),
      toWallet: owner(destination),
      outerIndex: i.outerIndex,
      innerIndex: i.innerIndex,
      classification: "transfer",
    });
  }
  return movements;
}

/** Fee proof is independent from swap/protocol proof. A public vault address alone is insufficient. */
export function proveFomoFeePath(
  tx: NormalizedSolanaTransaction,
  movements: readonly SolanaRawMovement[],
  context: Pick<
    SolanaWalletContext,
    "walletAddress" | "feeOwner" | "feeTokenAccounts"
  >,
  tokenAccounts: readonly SolanaTokenAccountBalance[] = tx.tokenAccounts,
): SolanaRouteEvidence["feeEvidence"] {
  const absent: SolanaRouteEvidence["feeEvidence"] = {
    state: "not_observed",
    walletAddress: null,
    rawAmount: "0",
    movementIds: [],
    vaultAccounts: [],
  };
  if (tx.succeeded !== true) return absent;
  const accounts = uniqueAccounts(tokenAccounts);
  const feeOwner = context.feeOwner ?? FOMO_SOLANA_FEE_OWNER;
  const vaults = [...accounts.values()].filter(
    (a) =>
      a.mint === SOLANA_USDC_MINT &&
      a.decimals === 6 &&
      owner(a) === feeOwner &&
      a.preRaw !== null &&
      a.postRaw !== null &&
      BigInt(a.postRaw) > BigInt(a.preRaw),
  );
  if (!vaults.length) return absent;
  const ambiguous = {
    ...absent,
    state: "ambiguous" as const,
    vaultAccounts: vaults.map((v) => v.accountAddress),
  };
  const ids = new Set<string>(),
    payers = new Set<string>();
  let total = ZERO;
  for (const vault of vaults) {
    const touching = movements.filter(
      (m) =>
        m.fromAccount === vault.accountAddress ||
        m.toAccount === vault.accountAddress,
    );
    const incoming = touching.filter(
      (m) =>
        m.toAccount === vault.accountAddress &&
        m.asset.assetId === SOLANA_USDC_MINT &&
        BigInt(m.rawAmount) > ZERO,
    );
    if (
      !incoming.length ||
      incoming.length !== touching.length ||
      incoming.reduce((n, m) => n + BigInt(m.rawAmount), ZERO) !==
        BigInt(vault.postRaw!) - BigInt(vault.preRaw!)
    )
      return ambiguous;
    for (const payment of incoming) {
      const source = accounts.get(payment.fromAccount),
        sourceOwner = owner(source);
      if (
        !source ||
        source.mint !== SOLANA_USDC_MINT ||
        !sourceOwner ||
        instructionOf(tx, payment)?.programId !== ROUTE_TOKEN_PROGRAM
      )
        return ambiguous;
      let payer = sourceOwner;
      const path = [payment.id];
      if (payer !== context.walletAddress) {
        // One exact pass-through is supported. Fan-in/out, timing ambiguity and
        // pre-funded spending without the matching user debit cannot be attributed.
        const intermediate = movements.filter(
          (m) =>
            m.fromAccount === source.accountAddress ||
            m.toAccount === source.accountAddress,
        );
        const feed = intermediate.find(
          (m) => m.toAccount === source.accountAddress && m.id !== payment.id,
        );
        if (
          intermediate.length !== 2 ||
          !feed ||
          !ordered(feed, payment) ||
          feed.rawAmount !== payment.rawAmount ||
          source.preRaw === null ||
          source.postRaw === null ||
          source.preRaw !== source.postRaw ||
          instructionOf(tx, feed)?.programId !== ROUTE_TOKEN_PROGRAM
        )
          return ambiguous;
        const first = accounts.get(feed.fromAccount);
        payer = owner(first) ?? "";
        if (
          !first ||
          first.mint !== SOLANA_USDC_MINT ||
          payer !== context.walletAddress
        )
          return ambiguous;
        path.push(feed.id);
      }
      if (payer !== context.walletAddress) return ambiguous;
      for (const id of path) {
        if (ids.has(id)) return ambiguous;
        ids.add(id);
      }
      payers.add(payer);
      total += BigInt(payment.rawAmount);
    }
  }
  if (payers.size !== 1) return ambiguous;
  return {
    state: "proven",
    walletAddress: [...payers][0],
    rawAmount: total.toString(),
    movementIds: [...ids],
    vaultAccounts: vaults.map((v) => v.accountAddress),
  };
}

function exactAccountDelta(
  account: SolanaTokenAccountBalance,
  expected: bigint,
): boolean {
  return (
    account.preRaw !== null &&
    account.postRaw !== null &&
    BigInt(account.postRaw) - BigInt(account.preRaw) === expected
  );
}

function relayDeposit(
  tx: NormalizedSolanaTransaction,
  i: SolanaNormalizedInstruction,
  movements: readonly SolanaRawMovement[],
  accounts: Map<string, SolanaTokenAccountBalance>,
  wallet: string,
): SolanaRouteEvidence["deposits"][number] | null {
  const data = i.dataEncoding === "base58" ? decodeRouteData(i.data) : null;
  const roles = i.accountAddresses ?? [];
  if (
    !data ||
    data.length !== 48 ||
    hex(data) !== RELAY_DEPOSIT ||
    roles.length !== 10 ||
    roles[1] !== wallet ||
    roles[7] !== ROUTE_TOKEN_PROGRAM ||
    roles[8] !== ROUTE_ASSOCIATED_PROGRAM ||
    roles[9] !== SOLANA_NATIVE_MINT ||
    !tx.accounts.some((a) => a.address === roles[1] && a.signer)
  )
    return null;
  const amount = u64(data, 8),
    source = accounts.get(roles[5]),
    vault = accounts.get(roles[6]);
  if (
    amount <= ZERO ||
    !source ||
    !vault ||
    source.mint !== roles[4] ||
    vault.mint !== roles[4] ||
    source.decimals !== vault.decimals ||
    owner(source) !== roles[1] ||
    owner(vault) !== roles[3] ||
    !exactAccountDelta(source, -amount) ||
    !exactAccountDelta(vault, amount)
  )
    return null;
  const group = movements.filter((m) => m.outerIndex === i.outerIndex);
  if (group.length !== 1) return null;
  const movement = group[0],
    cpi = instructionOf(tx, movement);
  if (
    movement.innerIndex === null ||
    movement.fromAccount !== roles[5] ||
    movement.toAccount !== roles[6] ||
    movement.rawAmount !== amount.toString() ||
    movement.decimals !== source.decimals ||
    cpi?.programId !== ROUTE_TOKEN_PROGRAM ||
    !["transfer", "transferChecked"].includes(cpi.type ?? "") ||
    text(cpi.info?.authority) !== roles[1]
  )
    return null;
  return {
    outerIndex: i.outerIndex,
    protocol: "relay",
    movementId: movement.id,
  };
}

type Hop = {
  instruction: SolanaNormalizedInstruction;
  amm: string;
  inputMint: string;
  outputMint: string;
  inputRaw: bigint;
  outputRaw: bigint;
};
function swapEvent(
  i: SolanaNormalizedInstruction,
  eventAuthority: string,
): Hop | null {
  const data = i.dataEncoding === "base58" ? decodeRouteData(i.data) : null;
  if (
    i.programId !== DFLOW_V4_PROGRAM ||
    i.innerIndex === null ||
    i.stackHeight !== 2 ||
    i.accountAddresses?.length !== 1 ||
    i.accountAddresses[0] !== eventAuthority ||
    !data ||
    data.length !== 128 ||
    hex(data) !== EVENT_CPI ||
    hex(data, 8, 16) !== SWAP_EVENT
  )
    return null;
  return {
    instruction: i,
    amm: base58(data.slice(16, 48)),
    inputMint: base58(data.slice(48, 80)),
    inputRaw: u64(data, 80),
    outputMint: base58(data.slice(88, 120)),
    outputRaw: u64(data, 120),
  };
}

function dflowSwap(
  tx: NormalizedSolanaTransaction,
  i: SolanaNormalizedInstruction,
  movements: readonly SolanaRawMovement[],
  accounts: Map<string, SolanaTokenAccountBalance>,
  context: SolanaWalletContext,
  fee: SolanaRouteEvidence["feeEvidence"],
  failures: string[],
): { swap: SolanaRouteEvidence["swaps"][number]; paths: string[] } | null {
  const fail = (reason: string): null => {
    failures.push(`dflow_${reason}`);
    return null;
  };
  const data = i.dataEncoding === "base58" ? decodeRouteData(i.data) : null,
    roles = i.accountAddresses ?? [];
  if (
    !data ||
    data.length < 24 ||
    hex(data) !== DFLOW_SWAP ||
    roles.length < 6 ||
    roles[0] !== ROUTE_TOKEN_PROGRAM ||
    roles[1] !== ROUTE_ASSOCIATED_PROGRAM ||
    roles[2] !== SOLANA_NATIVE_MINT ||
    roles[5] !== DFLOW_V4_PROGRAM
  )
    return fail("instruction_contract_unsupported");
  if (roles[3] !== context.walletAddress)
    return fail("different_user_authority");
  if (!tx.accounts.some((a) => a.address === roles[3] && a.signer))
    return fail("user_authority_not_signer");
  const group = tx.instructions.filter(
    (x) => x.outerIndex === i.outerIndex && x.innerIndex !== null,
  );
  // Token-2022 can describe a candidate route only when each transfer's
  // endpoint quantities are proven. This does not attest extension/fee history.
  if (
    group.some(
      (x) =>
        (x.type === "setAuthority" &&
          x.info?.authorityType !== "closeAccount") ||
        ["mintTo", "mintToChecked", "burn", "burnChecked"].includes(
          x.type ?? "",
        ) ||
        (x.programId === SOLANA_TOKEN_2022_PROGRAM &&
          (![
            "transfer",
            "transferChecked",
            "getAccountDataSize",
            "initializeImmutableOwner",
            "initializeAccount",
            "initializeAccount2",
            "initializeAccount3",
            "closeAccount",
            "setAuthority",
          ].includes(x.type ?? "") ||
            (["transfer", "transferChecked"].includes(x.type ?? "") &&
              !movements.some(
                (m) =>
                  m.outerIndex === x.outerIndex &&
                  m.innerIndex === x.innerIndex &&
                  m.quantityEvidence?.state === "exact",
              )))),
    )
  )
    return fail("token_effect_unsupported");
  const hops = group
    .map((x) => swapEvent(x, roles[4]))
    .filter((x): x is Hop => x !== null);
  if (!hops.length) return fail("hop_events_missing");
  const paths = [i.path],
    matched = new Set<string>();
  const feeIds = new Set(fee.state === "proven" ? fee.movementIds : []);
  const relevant = movements.filter(
    (m) =>
      m.outerIndex === i.outerIndex &&
      m.classification !== "lifecycle" &&
      (owner(accounts.get(m.fromAccount)) === context.walletAddress ||
        owner(accounts.get(m.toAccount)) === context.walletAddress),
  );
  if (
    movements.some(
      (m) =>
        m.outerIndex !== i.outerIndex &&
        m.classification !== "lifecycle" &&
        !feeIds.has(m.id) &&
        (owner(accounts.get(m.fromAccount)) === context.walletAddress ||
          owner(accounts.get(m.toAccount)) === context.walletAddress) &&
        // Only a separately ordered, explicit legacy transfer is independent
        // of the route. It is not a fee and still participates in full balances.
        !(
          m.outerIndex > i.outerIndex &&
          m.innerIndex === null &&
          instructionOf(tx, m)?.programId === ROUTE_TOKEN_PROGRAM &&
          ["transfer", "transferChecked"].includes(
            instructionOf(tx, m)?.type ?? "",
          ) &&
          instructionOf(tx, m)?.info?.source === m.fromAccount &&
          instructionOf(tx, m)?.info?.destination === m.toAccount
        ),
    )
  )
    return fail("additional_wallet_actions");
  const trade = relevant.filter((m) => !feeIds.has(m.id));
  const nativeTrade: SolanaRawMovement[] = [];
  const refundPaths = new Set(
    provenPumpVolumeRefunds(tx, context.walletAddress).flatMap((r) => [
      r.instruction.path,
      r.eventPath,
    ]),
  );
  let previousHopIndex = -1;
  for (const hop of hops) {
    // A DFlow event describes one AMM hop, not the whole user's action. Match
    // its preceding invocation and exact user-owned CPI legs before collapsing hops.
    const before = group.filter(
      (x) =>
        x.innerIndex! > previousHopIndex &&
        x.innerIndex! < hop.instruction.innerIndex! &&
        x.stackHeight === 2,
    );
    const calls = before.filter(
      (x) =>
        ![
          ROUTE_TOKEN_PROGRAM,
          SOLANA_TOKEN_2022_PROGRAM,
          ROUTE_ASSOCIATED_PROGRAM,
          SOLANA_NATIVE_MINT,
          DFLOW_V4_PROGRAM,
        ].includes(x.programId ?? "") &&
        !refundPaths.has(x.path) &&
        !readOnlyPumpInstruction(tx, x),
    );
    const call = calls[0];
    if (
      !call ||
      calls.length !== 1 ||
      call.programId !== hop.amm ||
      call.programId === DFLOW_V4_PROGRAM
    )
      return fail("hop_invocation_unmatched");
    // Native SOL is admitted only as an exact legacy System transfer inside
    // the matched AMM invocation, with wallet and counterparty in its roles.
    const nativeLegs = movements.filter(
      (m) =>
        m.outerIndex === i.outerIndex &&
        m.innerIndex !== null &&
        m.innerIndex > call.innerIndex! &&
        m.innerIndex < hop.instruction.innerIndex! &&
        m.asset.assetId === "native" &&
        m.classification === "transfer" &&
        (m.fromWallet === context.walletAddress ||
          m.toWallet === context.walletAddress) &&
        (hop.inputMint === "So11111111111111111111111111111111111111112" ||
          hop.outputMint === "So11111111111111111111111111111111111111112"),
    );
    if (
      nativeLegs.some((m) => {
        const instruction = instructionOf(tx, m);
        return (
          instruction?.programId !== SOLANA_NATIVE_MINT ||
          instruction.type !== "transfer" ||
          instruction.stackHeight === null ||
          instruction.stackHeight <= 2 ||
          !call.accountAddresses?.includes(m.fromAccount) ||
          !call.accountAddresses.includes(m.toAccount)
        );
      })
    )
      return fail("native_hop_effect_unproven");
    const legs = trade
      .filter(
        (m) =>
          m.innerIndex !== null &&
          m.innerIndex > call.innerIndex! &&
          m.innerIndex < hop.instruction.innerIndex!,
      )
      .concat(nativeLegs);
    let incoming = ZERO,
      outgoing = ZERO;
    for (const leg of legs) {
      if (leg.asset.assetId === "native") {
        if (
          leg.fromWallet === context.walletAddress &&
          hop.inputMint === "So11111111111111111111111111111111111111112"
        )
          outgoing += BigInt(leg.rawAmount);
        else if (
          leg.toWallet === context.walletAddress &&
          hop.outputMint === "So11111111111111111111111111111111111111112"
        )
          incoming += BigInt(leg.rawAmount);
        else return fail("native_hop_direction_unproven");
        if (matched.has(leg.id)) return fail("hop_movement_reused");
        matched.add(leg.id);
        nativeTrade.push(leg);
        continue;
      }
      const from = accounts.get(leg.fromAccount),
        to = accounts.get(leg.toAccount);
      if (
        !from ||
        !to ||
        from.mint !== to.mint ||
        from.decimals !== to.decimals ||
        (instructionOf(tx, leg)?.programId !== ROUTE_TOKEN_PROGRAM &&
          !(
            instructionOf(tx, leg)?.programId === SOLANA_TOKEN_2022_PROGRAM &&
            leg.quantityEvidence?.state === "exact"
          ))
      )
        return fail("hop_leg_identity_incomplete");
      if (
        owner(from) === context.walletAddress &&
        owner(to) !== context.walletAddress &&
        from.mint === hop.inputMint
      )
        outgoing += BigInt(leg.rawAmount);
      else if (
        owner(to) === context.walletAddress &&
        owner(from) !== context.walletAddress &&
        to.mint === hop.outputMint
      )
        incoming += BigInt(leg.rawAmount);
      else return fail("hop_leg_not_owned");
      if (matched.has(leg.id)) return null;
      matched.add(leg.id);
    }
    if (
      outgoing !== hop.inputRaw ||
      incoming !== hop.outputRaw ||
      outgoing <= ZERO ||
      incoming <= ZERO
    )
      return fail("hop_amounts_unreconciled");
    paths.push(call.path, hop.instruction.path);
    // An Anchor event-only self-CPI cannot mutate a wallet when its entire
    // privilege boundary is one explicitly read-only account. Its payload is
    // not interpreted as extra fills, fees or profit.
    for (const child of group.filter(
      (x) =>
        x.innerIndex! > call.innerIndex! &&
        x.innerIndex! < hop.instruction.innerIndex!,
    )) {
      const payload =
        child.dataEncoding === "base58" ? decodeRouteData(child.data) : null;
      if (
        child.programId === call.programId &&
        child.stackHeight === 3 &&
        payload &&
        payload.length >= 16 &&
        hex(payload) === EVENT_CPI &&
        child.accountAddresses?.length === 1 &&
        call.accountAddresses?.includes(child.accountAddresses[0]) &&
        tx.accounts.some(
          (a) =>
            a.address === child.accountAddresses![0] && a.writable === false,
        )
      )
        paths.push(child.path);
    }
    previousHopIndex = hop.instruction.innerIndex!;
  }
  if (matched.size !== trade.length + nativeTrade.length)
    return fail("unmatched_wallet_movements");
  // Check every touched user token account against all observable movements,
  // not merely the two sides we would like to classify as a trade.
  for (const a of accounts.values()) {
    if (owner(a) !== context.walletAddress) continue;
    const touching = movements.filter(
      (m) =>
        m.asset.assetId === a.mint &&
        (m.fromAccount === a.accountAddress ||
          m.toAccount === a.accountAddress),
    );
    const delta = touching.reduce(
      (n, m) =>
        n +
        (m.toAccount === a.accountAddress ? BigInt(m.rawAmount) : ZERO) -
        (m.fromAccount === a.accountAddress ? BigInt(m.rawAmount) : ZERO),
      ZERO,
    );
    if (!exactAccountDelta(a, delta))
      return fail("wallet_balance_unreconciled");
  }
  const deltas = new Map<string, { raw: bigint; decimals: number }>();
  for (const leg of trade.concat(nativeTrade)) {
    const native = leg.asset.assetId === "native";
    const source = accounts.get(leg.fromAccount),
      destination = accounts.get(leg.toAccount);
    const mint = native
      ? "So11111111111111111111111111111111111111112"
      : source!.mint;
    const decimals = native ? 9 : source!.decimals;
    const sign =
      (native ? leg.fromWallet : owner(source)) === context.walletAddress
        ? -BigInt(1)
        : BigInt(1);
    const old = deltas.get(mint);
    if (old && old.decimals !== decimals) return null;
    deltas.set(native ? mint : destination!.mint, {
      raw: (old?.raw ?? ZERO) + sign * BigInt(leg.rawAmount),
      decimals,
    });
  }
  const negative = [...deltas].filter(([, n]) => n.raw < ZERO),
    positive = [...deltas].filter(([, n]) => n.raw > ZERO);
  if (negative.length !== 1 || positive.length !== 1) return null;
  // CPI events with an explicitly read-only privilege boundary cannot mutate
  // wallet state. No opaque writable AMM/plugin instruction is covered here.
  for (const instruction of group)
    if (readOnlyPumpInstruction(tx, instruction)) paths.push(instruction.path);
  for (const path of refundPaths) paths.push(path);
  // Fee CPI events are recognized only when the actual token movements prove
  // the same amount and beneficiary; they never create an additional fee.
  for (const event of group.filter(
    (x) => x.programId === DFLOW_V4_PROGRAM && !paths.includes(x.path),
  )) {
    const payload =
      event.dataEncoding === "base58" ? decodeRouteData(event.data) : null;
    if (
      !payload ||
      payload.length !== 88 ||
      hex(payload) !== EVENT_CPI ||
      hex(payload, 8, 16) !== FEE_EVENT ||
      event.accountAddresses?.[0] !== roles[4] ||
      event.accountAddresses.length !== 1 ||
      event.stackHeight !== 2 ||
      fee.state !== "proven" ||
      base58(payload.slice(48, 80)) !== SOLANA_USDC_MINT ||
      !fee.vaultAccounts.includes(base58(payload.slice(16, 48))) ||
      u64(payload, 80).toString() !== fee.rawAmount
    )
      return null;
    paths.push(event.path);
  }
  return {
    paths,
    swap: {
      outerIndex: i.outerIndex,
      protocol: "dflow_v4",
      walletAddress: context.walletAddress,
      movementIds: [...matched],
      feeMovementIds: relevant.filter((m) => feeIds.has(m.id)).map((m) => m.id),
      input: {
        mint: negative[0][0],
        rawAmount: (-negative[0][1].raw).toString(),
        decimals: negative[0][1].decimals,
      },
      output: {
        mint: positive[0][0],
        rawAmount: positive[0][1].raw.toString(),
        decimals: positive[0][1].decimals,
      },
    },
  };
}

export function analyzeSolanaRouteEvidence(
  tx: NormalizedSolanaTransaction,
  movements: readonly SolanaRawMovement[],
  context: SolanaWalletContext,
  tokenAccounts: readonly SolanaTokenAccountBalance[] = tx.tokenAccounts,
): SolanaRouteEvidence {
  const feeEvidence = proveFomoFeePath(tx, movements, context, tokenAccounts);
  const result: SolanaRouteEvidence = {
    recognizedInstructionPaths: [],
    swaps: [],
    deposits: [],
    feeEvidence,
    blockers: [],
  };
  if (tx.succeeded !== true) return result;
  const accounts = uniqueAccounts(tokenAccounts);
  const isolated = isolatedThirdPartyDflowGroups(tx, context.walletAddress);
  for (const i of tx.instructions.filter((x) => x.innerIndex === null)) {
    if (isolated.has(i.outerIndex)) continue;
    if (i.programId === RELAY_SOLANA_DEPOSITORY) {
      const deposit = relayDeposit(
        tx,
        i,
        movements,
        accounts,
        context.walletAddress,
      );
      if (deposit) {
        result.deposits.push(deposit);
        result.recognizedInstructionPaths.push(i.path);
      } else result.blockers.push("relay_deposit_evidence_incomplete");
    }
    if (i.programId === DFLOW_V4_PROGRAM) {
      const swap = dflowSwap(
        tx,
        i,
        movements,
        accounts,
        context,
        feeEvidence,
        result.blockers,
      );
      if (swap) {
        result.swaps.push(swap.swap);
        result.recognizedInstructionPaths.push(...swap.paths);
      } else result.blockers.push("dflow_swap_evidence_incomplete");
    }
  }
  return result;
}
