"use client";
// Pay from any chain, from a wallet: sends the deposit to the order's 1Click deposit address for the user, instead
// of them copying it. EVM chains use the wallet already connected to PFWA (switched to the source chain for the
// transfer, then back to Robinhood Chain); Solana uses any Wallet Standard wallet (Phantom, Solflare, Backpack).
// Other chains keep the deposit address.
import { encodeFunctionData, erc20Abi, numberToHex, type Address, type Chain, type EIP1193Provider } from "viem";
import { abstract, arbitrum, avalanche, base, berachain, bsc, gnosis, mainnet, monad, optimism, plasma, polygon, scroll, xLayer } from "viem/chains";

/** 1Click's chain codes for the EVM chains a connected wallet can pay from. */
export const EVM_CHAINS: Record<string, Chain> = {
  eth: mainnet, base, arb: arbitrum, op: optimism, pol: polygon, bsc, avax: avalanche, gnosis, bera: berachain,
  scroll, monad, xlayer: xLayer, abs: abstract, plasma,
};

export const isEvmChain = (blockchain: string) => blockchain in EVM_CHAINS;
export const isSolana = (blockchain: string) => blockchain === "sol";

const isUserRejection = (e: unknown) => {
  const err = e as { code?: number; message?: string };
  return err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? "");
};
export const walletErrorText = (e: unknown) =>
  isUserRejection(e) ? "You cancelled it in your wallet." : ((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? "The wallet couldn't send it.");

async function switchTo(provider: EIP1193Provider, chain: Chain) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chain.id) }] });
  } catch (e) {
    // 4902: the wallet doesn't know the chain yet, so add it (that also switches to it).
    if ((e as { code?: number })?.code !== 4902 && !/unrecognized|not added|unknown chain/i.test((e as Error)?.message ?? "")) throw e;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: numberToHex(chain.id),
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [...chain.rpcUrls.default.http],
        blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
      }],
    });
  }
}

/**
 * Sends `amount` of a coin on an EVM chain from `from` to `to` through the wallet's own provider: the native coin
 * when `token` is null, otherwise an ERC-20 transfer. Switches the wallet to that chain first and back to
 * `returnChainId` afterwards. Returns the transaction hash.
 */
export async function sendEvm(p: { provider: EIP1193Provider; blockchain: string; from: Address; to: Address; token: Address | null; amount: bigint; returnChainId: number }): Promise<`0x${string}`> {
  const chain = EVM_CHAINS[p.blockchain];
  if (!chain) throw new Error(`Can't send on ${p.blockchain} from this wallet`);
  await switchTo(p.provider, chain);
  try {
    // The wallet hands back a hash even for a payment that then fails, so check the balance first.
    const have = p.token
      ? BigInt((await p.provider.request({ method: "eth_call", params: [{ to: p.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [p.from] }) }, "latest"] as never })) as string)
      : BigInt((await p.provider.request({ method: "eth_getBalance", params: [p.from, "latest"] as never })) as string);
    if (have < p.amount) throw new Error(`Not enough on ${chain.name}: this wallet has less than the amount to send`);
    const tx = p.token
      ? { from: p.from, to: p.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [p.to, p.amount] }) }
      : { from: p.from, to: p.to, value: numberToHex(p.amount) };
    return (await p.provider.request({ method: "eth_sendTransaction", params: [tx as never] })) as `0x${string}`;
  } finally {
    // Back to Robinhood Chain for trading; if the wallet refuses, the app asks to switch on the next trade.
    p.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(p.returnChainId) }] }).catch(() => {});
  }
}

// ── Solana: Wallet Standard (https://github.com/wallet-standard/wallet-standard), without the library ────────────

type SolAccount = { address: string; publicKey: Uint8Array; chains: readonly string[] };
export type SolWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly SolAccount[];
  features: Record<string, unknown>;
};
type ConnectFeature = { connect: (input?: { silent?: boolean }) => Promise<{ accounts: readonly SolAccount[] }> };
type SignAndSendFeature = {
  signAndSendTransaction: (...inputs: { account: SolAccount; chain: string; transaction: Uint8Array }[]) => Promise<{ signature: Uint8Array }[]>;
};

const SOLANA_MAINNET = "solana:mainnet";

/** Solana wallets installed in this browser that can sign and send a transaction. */
export function solanaWallets(): SolWallet[] {
  if (typeof window === "undefined") return [];
  const found = new Set<SolWallet>();
  const api = { register: (...ws: SolWallet[]) => { ws.forEach((w) => found.add(w)); return () => {}; } };
  const onRegister = (e: Event) => (e as CustomEvent<(a: typeof api) => void>).detail?.(api);
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } finally {
    window.removeEventListener("wallet-standard:register-wallet", onRegister);
  }
  return [...found].filter((w) => w.chains.some((c) => c.startsWith("solana:")) && "standard:connect" in w.features && "solana:signAndSendTransaction" in w.features);
}

export async function connectSolana(w: SolWallet): Promise<SolAccount> {
  const { accounts } = await (w.features["standard:connect"] as ConnectFeature).connect();
  const account = accounts[0] ?? w.accounts[0];
  if (!account) throw new Error(`${w.name} didn't share an account`);
  return account;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = (n << BigInt(8)) + BigInt(b);
  let out = "";
  while (n > BigInt(0)) { out = B58[Number(n % BigInt(58))] + out; n /= BigInt(58); }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/**
 * Sends SOL (`mint` null) or an SPL token from the connected Solana account to `to`: the server builds the unsigned
 * transfer (api/intents/solana-tx), the wallet signs and sends it. Returns the transaction signature.
 */
export async function sendSolana(p: { wallet: SolWallet; account: SolAccount; to: string; mint: string | null; amount: bigint; decimals: number }): Promise<string> {
  const r = await fetch("/api/intents/solana-tx", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: p.account.address, to: p.to, mint: p.mint, amount: p.amount.toString(), decimals: p.decimals }),
  });
  const d = await r.json();
  if (!r.ok || !d.transaction) throw new Error(d.error ?? "Couldn't build the Solana transfer");
  const transaction = Uint8Array.from(atob(d.transaction), (c) => c.charCodeAt(0));
  const [res] = await (p.wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature).signAndSendTransaction({
    account: p.account,
    chain: p.account.chains.find((c) => c === SOLANA_MAINNET) ?? SOLANA_MAINNET,
    transaction,
  });
  return base58(res.signature);
}

/** Lets 1Click know about the deposit right away (optional; it finds it anyway). */
export function reportDeposit(txHash: string, depositAddress: string, depositMemo?: string | null) {
  fetch("/api/intents/deposit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash, depositAddress, depositMemo }) }).catch(() => {});
}
