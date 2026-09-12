export const WALLET_CHAINS = [
  "solana",
  "base",
  "bnb",
  "monad",
  "robinhood",
  "hyperliquid",
] as const;
export const walletChainOptions = [
  { value: "solana", label: "Solana" },
  { value: "base", label: "Base" },
  { value: "bnb", label: "BNB Chain" },
  { value: "monad", label: "Monad" },
  { value: "robinhood", label: "Robinhood" },
  { value: "hyperliquid", label: "Hyperliquid Perps" },
] as const;
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Syntax only: a public account address is not proof of ownership or activity. */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  let number = BigInt(0);
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    number = number * BigInt(58) + BigInt(digit);
  }
  let bytes = 0;
  while (number > BigInt(0)) {
    bytes++;
    number >>= BigInt(8);
  }
  const zeros = value.match(/^1*/)?.[0].length ?? 0;
  return zeros + bytes === 32;
}

export function parseWalletAddress(
  raw: string,
  requestedChain?: string,
): {
  state: "valid" | "invalid" | "unsupported";
  address: string;
  chain: string | null;
  family: "evm" | "solana" | null;
} {
  const address = raw.trim();
  const chain = requestedChain?.trim().toLowerCase() || null;
  const family = /^0x[0-9a-fA-F]{40}$/.test(address)
    ? "evm"
    : isSolanaAddress(address)
      ? "solana"
      : null;
  if (!family) return { state: "invalid", address, chain, family };
  const canonical = family === "evm" ? address.toLowerCase() : address;
  if (chain && !(WALLET_CHAINS as readonly string[]).includes(chain))
    return { state: "unsupported", address: canonical, chain, family };
  if (
    (family === "evm" && chain === "solana") ||
    (family === "solana" && chain && chain !== "solana")
  )
    return { state: "invalid", address: canonical, chain, family };
  return {
    state: "valid",
    address: canonical,
    chain: family === "solana" ? "solana" : chain,
    family,
  };
}
