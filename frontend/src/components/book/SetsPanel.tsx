"use client";
// Complete sets: X USDG mints X of every outcome, and X of every outcome burns back into X USDG.
import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { USDG } from "@/lib/orderbook/config";
import { obMarketAbi } from "@/lib/orderbook/abi";
import { fmtAmount } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";
import type { BookUser } from "@/hooks/useBook";
import { ActionButton, AmountInput, Panel, Seg, parseAmount, toInput } from "./ui";
import { approveStep, useTxFlow } from "./useTxFlow";

export default function SetsPanel({ market, user, onDone }: { market: BookMarket; user: BookUser | undefined; onDone: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(onDone);
  const [mode, setMode] = useState<"mint" | "burn">("mint");
  const [amount, setAmount] = useState("");
  const raw = parseAmount(amount);
  if (market.resolved) return null;

  const fullSets = user ? user.balances.reduce((a, b) => (b < a ? b : a), user.balances[0] ?? BigInt(0)) : undefined;
  const balance = mode === "mint" ? user?.usdg : fullSets;
  const room = market.depositCap > BigInt(0) ? market.depositCap - market.collateral : undefined;
  const overCap = mode === "mint" && room !== undefined && raw > room;
  const tooMuch = balance !== undefined && raw > balance;
  const names = market.outcomes.map((o) => o.name).join(" + ");

  const submit = () => {
    if (!address) return;
    if (mode === "mint") {
      void start("Mint full sets", [
        approveStep(client, writeContractAsync, { token: USDG, owner: address, spender: market.market, amount: raw, label: "Approve USDG for the market" }),
        {
          id: "mint",
          label: `Mint ${fmtAmount(raw)} of each outcome`,
          run: () => writeContractAsync({ address: market.market, abi: obMarketAbi, functionName: "mintSet", args: [raw, address], chainId: TARGET_CHAIN_ID }),
        },
      ]);
    } else {
      void start("Redeem full sets", [{
        id: "burn",
        label: `Turn ${fmtAmount(raw)} sets back into USDG`,
        run: () => writeContractAsync({ address: market.market, abi: obMarketAbi, functionName: "burnSet", args: [raw, address], chainId: TARGET_CHAIN_ID }),
      }]);
    }
  };

  return (
    <Panel title="Full sets" collapsible>
      {modal}
      <div className="space-y-3">
        <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
          One of every outcome ({names}) is always worth exactly 1 USDG, because one of them wins. Mint sets to sell the outcomes you don&apos;t want, or turn sets back into USDG any time before the outcome is final.
        </p>
        <Seg value={mode} onChange={setMode} options={[{ value: "mint", label: "USDG → sets" }, { value: "burn", label: "Sets → USDG" }]} />
        <AmountInput
          label={mode === "mint" ? "USDG in" : "Sets to redeem"}
          value={amount}
          onChange={setAmount}
          unit={mode === "mint" ? "USDG" : "sets"}
          balance={balance !== undefined ? fmtAmount(balance) : undefined}
          onMax={balance !== undefined ? () => setAmount(toInput(room !== undefined && mode === "mint" && room < balance ? room : balance)) : undefined}
        />
        {room !== undefined && mode === "mint" && (
          <p className="font-mono text-[10px] text-neutral-500">Launch deposit cap: {fmtAmount(room)} USDG of {fmtAmount(market.depositCap)} left in this market.</p>
        )}
        <ActionButton onClick={submit} disabled={running || raw === BigInt(0) || tooMuch || overCap}>
          {overCap ? "Over the deposit cap" : tooMuch ? (mode === "mint" ? "Not enough USDG" : "Not enough full sets") : mode === "mint" ? "Mint sets" : "Get USDG back"}
        </ActionButton>
      </div>
    </Panel>
  );
}
