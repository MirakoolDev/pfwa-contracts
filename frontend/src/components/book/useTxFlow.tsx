"use client";
// Runs a sequence of wallet transactions (approvals, then the action) and shows each step in TxStepsModal.
// Approval steps check the chain first and skip themselves when the allowance is already there.
import { useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { BaseError, ContractFunctionRevertedError, erc20Abi, maxUint256, type Address, type PublicClient, type TransactionReceipt } from "viem";
import TxStepsModal, { type TxFlow, type TxStep } from "@/components/TxStepsModal";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { PERMIT2 } from "@/lib/orderbook/config";
import { permit2Abi } from "@/lib/orderbook/abi";

export type FlowStep = {
  id: string;
  label: string;
  /** Resolves to a reason to skip this step, or false to run it. */
  skip?: () => Promise<string | false>;
  run: () => Promise<`0x${string}`>;
  /** Called with the receipt once the step's transaction succeeds. */
  onReceipt?: (receipt: TransactionReceipt) => void;
};

const FRIENDLY: Record<string, string> = {
  TradingClosed: "Trading is closed on this market.",
  CapExceeded: "This market has reached its deposit cap for launch.",
  CrossedRange: "The price moved past your limit price. Pick a new price.",
  BadTick: "That price is outside 0.001–0.999 USDG.",
  ZeroLiquidity: "That amount is too small for a limit order.",
  NothingToWithdraw: "There's nothing left in this order.",
  NotFilled: "This order hasn't filled yet.",
  WrongState: "The market isn't at that stage any more. Refresh the page.",
  NotAllowedToResolve: "Only the creator, PFWA's resolver or the owner can post this market's outcome.",
  DisputeWindowOver: "The 2-hour dispute window has closed.",
  DisputeWindowOpen: "The dispute window is still open.",
  AlreadyResolved: "This market is already resolved.",
  NotResolved: "The outcome isn't final yet.",
  BadOutcome: "That outcome doesn't win in this market.",
  NotArbiter: "Only the arbiter can settle disputes.",
  CreationIsPaused: "Creating markets is paused right now.",
  BadOutcomeCount: "A market needs 2 to 10 outcomes.",
  BadOpeningPrices: "Each opening price must be between 0.1% and 99.9%.",
  BadEndOfTrading: "The end of trading must be in the future.",
  FeeTooHigh: "The creator fee can be at most 1%.",
  TradingStillOpen: "Your liquidity stays locked until trading stops.",
  TradingNotOpen: "This market isn't trading any more.",
  NothingLocked: "There's no locked liquidity to release.",
  BadRules: "Say how the outcome is decided, in at most 2,000 bytes.",
  MinimumAmountInsufficient: "Prices moved while you were withdrawing. Try again at the new prices.",
};

export function txError(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError);
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    if (name && FRIENDLY[name]) return FRIENDLY[name];
    if (name) return `The transaction didn't go through: ${name}.`;
  }
  const err = e as { shortMessage?: string; message?: string } | null;
  const raw = err?.shortMessage || err?.message || "Something went wrong";
  if (/user (rejected|denied)|rejected the request|ACTION_REJECTED/i.test(raw)) return "You cancelled the transaction.";
  for (const [name, text] of Object.entries(FRIENDLY)) if (raw.includes(name)) return text;
  return raw.length > 220 ? `${raw.slice(0, 220)}…` : raw;
}

export function useTxFlow(onSettled?: () => void) {
  const [flow, setFlow] = useState<TxFlow | null>(null);
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID });

  const start = async (title: string, steps: FlowStep[]): Promise<boolean> => {
    let state: TxStep[] = steps.map((s) => ({ id: s.id, label: s.label, state: "waiting" }));
    const show = (running: boolean, extra: Partial<TxFlow> = {}) => setFlow({ title, steps: state, running, ...extra });
    const patch = (i: number, p: Partial<TxStep>) => {
      state = state.map((s, j) => (j === i ? { ...s, ...p } : s));
      show(true);
    };
    show(true);
    for (let i = 0; i < steps.length; i++) {
      try {
        const skip = steps[i].skip ? await steps[i].skip!() : false;
        if (skip) {
          patch(i, { state: "skipped", detail: skip });
          continue;
        }
        patch(i, { state: "wallet" });
        const hash = await steps[i].run();
        patch(i, { state: "pending", hash });
        const receipt = await client!.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("The transaction reverted onchain.");
        steps[i].onReceipt?.(receipt);
        patch(i, { state: "done" });
      } catch (e) {
        state = state.map((s, j) => (j === i ? { ...s, state: "failed" } : s));
        show(false, { error: txError(e), retry: { label: "Try again", run: () => void start(title, steps) } });
        onSettled?.();
        return false;
      }
    }
    show(false);
    onSettled?.();
    return true;
  };

  const modal = flow ? <TxStepsModal flow={flow} onClose={() => setFlow(null)} /> : null;
  return { start, modal, running: flow?.running ?? false };
}

type Write = ReturnType<typeof useWriteContract>["writeContractAsync"];

/** Approve `spender` for `amount` of `token`, skipped when already approved. */
export function approveStep(
  client: PublicClient,
  write: Write,
  p: { token: Address; owner: Address; spender: Address; amount: bigint; label: string; approveAmount?: bigint },
): FlowStep {
  return {
    id: `approve-${p.token}-${p.spender}`,
    label: p.label,
    skip: async () => {
      const allowance = await client.readContract({ address: p.token, abi: erc20Abi, functionName: "allowance", args: [p.owner, p.spender] });
      return allowance >= p.amount ? "Already approved" : false;
    },
    run: () => write({ address: p.token, abi: erc20Abi, functionName: "approve", args: [p.spender, p.approveAmount ?? p.amount], chainId: TARGET_CHAIN_ID }),
  };
}

const MAX_UINT160 = (BigInt(1) << BigInt(160)) - BigInt(1);
const THIRTY_DAYS = 30 * 24 * 3600;

/**
 * Uniswap's contracts pull tokens through Permit2: approve Permit2 for the token once, then let `spender` (the
 * Universal Router or the position manager) spend it through Permit2 for 30 days.
 */
export function permit2Steps(
  client: PublicClient,
  write: Write,
  p: { token: Address; symbol: string; owner: Address; spender: Address; spenderName: string; amount: bigint },
): FlowStep[] {
  return [
    // Permit2 gets a one-time approval, as in Uniswap's own app: it can only move tokens for a spender the owner
    // allowed below (here for 30 days), so an exact-amount approval would only ask for a second signature every trade.
    approveStep(client, write, { token: p.token, owner: p.owner, spender: PERMIT2, amount: p.amount, approveAmount: maxUint256, label: `Approve ${p.symbol} for Permit2 (once)` }),
    {
      id: `permit2-${p.token}-${p.spender}`,
      label: `Let ${p.spenderName} use your ${p.symbol}`,
      skip: async () => {
        const [amount, expiration] = await client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [p.owner, p.token, p.spender] });
        return amount >= p.amount && expiration > Math.floor(Date.now() / 1000) + 600 ? "Already approved" : false;
      },
      run: () =>
        write({
          address: PERMIT2,
          abi: permit2Abi,
          functionName: "approve",
          args: [p.token, p.spender, MAX_UINT160, Math.floor(Date.now() / 1000) + THIRTY_DAYS],
          chainId: TARGET_CHAIN_ID,
        }),
    },
  ];
}
