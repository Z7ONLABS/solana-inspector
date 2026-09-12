import { describe, expect, it } from "vitest";
import { parseSolanaEconomicEvents } from "../../src/analytics/solana/economic";
import {
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
} from "../../src/analytics/solana/normalize";
import {
  decodeRouteData,
  provenPumpVolumeRefunds,
} from "../../src/analytics/solana/routes";
import type {
  NormalizedSolanaTransaction,
  SolanaNormalizedInstruction,
} from "../../src/analytics/solana/types";

// Synthetic quantities/addresses only. Actual pilot cases are replayed separately.
const wallet = "fixture-v4-wallet",
  mint = "fixture-v4-mint";
function ix(
  type: string,
  info: Record<string, unknown>,
  outerIndex: number,
  innerIndex: number | null = null,
  programId = SOLANA_TOKEN_2022_PROGRAM,
): SolanaNormalizedInstruction {
  return {
    type,
    info,
    programId,
    program: null,
    outerIndex,
    innerIndex,
    stackHeight: innerIndex === null ? 1 : 2,
    path: `${outerIndex}${innerIndex === null ? "" : `.${innerIndex}`}`,
  };
}
function fixture(): NormalizedSolanaTransaction {
  return {
    state: "normalized",
    signature: "synthetic-v4",
    slot: 10,
    transactionIndex: 0,
    blockTime: "2026-01-01T00:00:00.000Z",
    version: 0,
    succeeded: true,
    feePayer: "sponsor",
    networkFeeRaw: "5",
    provenance: {
      source: "deterministic-test",
      payloadSha256: "a".repeat(64),
      commitment: "finalized",
      commitmentEvidence: "request",
    },
    blockers: [],
    tokenAccounts: [
      {
        accountAddress: "source",
        mint,
        decimals: 6,
        preOwner: "pool-a",
        postOwner: "pool-a",
        preRaw: "100",
        postRaw: "90",
        programId: SOLANA_TOKEN_2022_PROGRAM,
      },
      {
        accountAddress: "destination",
        mint,
        decimals: 6,
        preOwner: "pool-b",
        postOwner: "pool-b",
        preRaw: "0",
        postRaw: "10",
        programId: SOLANA_TOKEN_2022_PROGRAM,
      },
    ],
    accounts: [
      {
        address: wallet,
        preLamports: "0",
        postLamports: "0",
        signer: true,
        writable: true,
      },
      {
        address: "sponsor",
        preLamports: "1000",
        postLamports: "995",
        signer: true,
        writable: true,
      },
      {
        address: "temporary",
        preLamports: "0",
        postLamports: "0",
        signer: false,
        writable: true,
      },
      ...["source", "destination"].map((address) => ({
        address,
        preLamports: "100",
        postLamports: "100",
        signer: false,
        writable: true,
      })),
    ],
    instructions: [
      ix(
        "createAccount",
        {
          source: "sponsor",
          newAccount: "temporary",
          owner: SOLANA_TOKEN_2022_PROGRAM,
          lamports: 10,
          space: 191,
        },
        0,
        null,
        SOLANA_SYSTEM_PROGRAM,
      ),
      ix(
        "initializeAccount3",
        { account: "temporary", mint, owner: wallet },
        1,
      ),
      ix(
        "transferChecked",
        {
          source: "source",
          destination: "temporary",
          authority: "pool-a",
          mint,
          tokenAmount: { amount: "10", decimals: 6 },
        },
        2,
        0,
      ),
      ix(
        "transferChecked",
        {
          source: "temporary",
          destination: "destination",
          authority: wallet,
          mint,
          tokenAmount: { amount: "10", decimals: 6 },
        },
        2,
        1,
      ),
      ix(
        "closeAccount",
        { account: "temporary", destination: "sponsor", owner: wallet },
        3,
      ),
    ],
  };
}
const parse = (tx: NormalizedSolanaTransaction) =>
  parseSolanaEconomicEvents(tx, { walletAddress: wallet, transactionOrder: 1 });

describe("v4 linear Token-2022 temporary evidence", () => {
  it("proves only the exact two-edge quantities, never extension history or profits", () => {
    const result = parse(fixture());
    const transfers = result.rawMovements.filter((m) => m.quantityEvidence);
    expect(transfers).toHaveLength(2);
    expect(transfers.every((m) => m.quantityEvidence?.state === "exact")).toBe(
      true,
    );
    expect(result.blockers).toEqual(["token_2022_extension_state_unproven"]);
    expect(result.feesComplete).toBe(false);
    expect(result.swaps).toEqual([]);
  });
  it.each([
    "difference",
    "owner",
    "extra",
    "hook",
    "reinitialization",
    "ordering",
    "not-closed",
    "unknown-opening",
  ])("rejects insufficient conduit proof: %s", (kind) => {
    const tx = fixture();
    if (kind === "difference") tx.tokenAccounts[1].postRaw = "9";
    if (kind === "owner") tx.tokenAccounts[0].postOwner = "changed";
    if (kind === "extra")
      tx.instructions.splice(
        4,
        0,
        ix(
          "transferChecked",
          {
            source: "source",
            destination: "temporary",
            authority: "pool-a",
            mint,
            tokenAmount: { amount: "1", decimals: 6 },
          },
          2,
          2,
        ),
      );
    if (kind === "hook")
      tx.instructions.splice(3, 0, {
        ...ix("hook", {}, 2, 5, "unrecognized-hook"),
        stackHeight: 3,
      });
    if (kind === "reinitialization")
      tx.instructions.splice(
        2,
        0,
        ix(
          "initializeAccount3",
          { account: "temporary", mint, owner: wallet },
          1,
          0,
        ),
      );
    if (kind === "ordering") tx.instructions[2].innerIndex = 3;
    if (kind === "not-closed") tx.instructions.pop();
    if (kind === "unknown-opening")
      tx.accounts.find((a) => a.address === "temporary")!.preLamports = "10";
    expect(
      parse(tx)
        .rawMovements.filter((m) => m.quantityEvidence)
        .some((m) => m.quantityEvidence?.state === "exact"),
    ).toBe(false);
  });
  it("never lets a supply change be mistaken for the other side of the conduit", () => {
    const tx = fixture();
    tx.instructions[2] = ix(
      "mintTo",
      { account: "temporary", mint, mintAuthority: "issuer", amount: "10" },
      2,
      0,
    );
    const result = parse(tx);
    expect(
      result.rawMovements.find((m) => m.quantityEvidence)?.quantityEvidence
        ?.state,
    ).not.toBe("exact");
    expect(result.swaps).toEqual([]);
  });
});

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function encode(bytes: Uint8Array): string {
  let n = BigInt(0),
    result = "";
  for (const byte of bytes) n = n * BigInt(256) + BigInt(byte);
  while (n) {
    result = alphabet[Number(n % BigInt(58))] + result;
    n /= BigInt(58);
  }
  for (const byte of bytes) {
    if (byte) break;
    result = `1${result}`;
  }
  return result;
}
const pump = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const eventAuthority = "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR";
const publicWallet = encode(new Uint8Array(32).fill(7));
function volumeFixture() {
  const tx = fixture();
  tx.tokenAccounts = [];
  tx.accounts.find((a) => a.address === wallet)!.address = publicWallet;
  tx.accounts.push({
    address: eventAuthority,
    preLamports: "1",
    postLamports: "1",
    writable: false,
    signer: false,
  });
  tx.instructions = [
    {
      ...ix(
        "createAccount",
        {
          source: publicWallet,
          newAccount: "temporary",
          owner: pump,
          lamports: 10,
          space: 137,
        },
        0,
        0,
        SOLANA_SYSTEM_PROGRAM,
      ),
      stackHeight: 3,
    },
    {
      ...ix("", {}, 0, 1, pump),
      type: null,
      info: null,
      data: "ihFZiQrP7CM",
      dataEncoding: "base58",
      accountAddresses: [publicWallet, "temporary", eventAuthority, pump],
    },
    {
      ...ix("", {}, 0, 2, pump),
      type: null,
      info: null,
      stackHeight: 3,
      data: encode(
        Uint8Array.from([
          ...Buffer.from("e445a52e51cb9a1d929fbdac925838f4", "hex"),
          ...decodeRouteData(publicWallet)!,
          ...new Uint8Array(40),
        ]),
      ),
      dataEncoding: "base58",
      accountAddresses: [eventAuthority],
    },
  ];
  return tx;
}
describe("bounded Pump volume-account rent refund", () => {
  it("reconstructs a proven closure at instruction order, not income or a swap", () => {
    const tx = volumeFixture();
    const result = parseSolanaEconomicEvents(tx, {
      walletAddress: publicWallet,
      transactionOrder: 1,
    });
    expect(provenPumpVolumeRefunds(tx, publicWallet)).toHaveLength(1);
    expect(
      result.rawMovements.map((m) => [m.rawAmount, m.classification]),
    ).toEqual([
      ["10", "lifecycle"],
      ["10", "lifecycle"],
    ]);
    expect(result.blockers).toEqual([]);
    expect(result.transfers).toEqual([]);
    expect(result.swaps).toEqual([]);
  });
  it.each([
    "failed",
    "wrong-program",
    "wrong-owner",
    "wrong-beneficiary",
    "missing-event",
    "unknown-start",
    "funded-again",
    "unsafe-value",
  ])(
    "does not infer a closure/refund from an endpoint zero alone: %s",
    (kind) => {
      const tx = volumeFixture();
      if (kind === "failed") tx.succeeded = false;
      if (kind === "wrong-program")
        tx.instructions[1].programId = "other-program";
      if (kind === "wrong-owner")
        tx.instructions[0].info!.owner = "other-program";
      if (kind === "wrong-beneficiary")
        tx.instructions[1].accountAddresses![0] = encode(
          new Uint8Array(32).fill(8),
        );
      if (kind === "missing-event") tx.instructions.pop();
      if (kind === "unknown-start")
        tx.accounts.find((a) => a.address === "temporary")!.preLamports = null;
      if (kind === "funded-again")
        tx.instructions.unshift(
          ix(
            "transfer",
            { source: "sponsor", destination: "temporary", lamports: 10 },
            0,
            9,
            SOLANA_SYSTEM_PROGRAM,
          ),
        );
      if (kind === "unsafe-value")
        tx.instructions[0].info!.lamports = Number.MAX_SAFE_INTEGER + 1;
      expect(provenPumpVolumeRefunds(tx, publicWallet)).toEqual([]);
    },
  );
});
