"use client";
// Add liquidity so a market can trade: USDG in, split into complete sets and each pool's USDG side, then one
// position per outcome pool across 0.001–0.999 at today's prices.
import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { POSITION_MANAGER, USDG } from "@/lib/orderbook/config";
import { obMarketAbi } from "@/lib/orderbook/abi";
import { positionManagerAbi, seedPlan, seedUnlockData } from "@/lib/orderbook/liquidity";
import { fmtAmount } from "@/lib/orderbook/math";
import type { BookMarket } from "@/lib/orderbook/read";
import type { BookUser } from "@/hooks/useBook";
import { ActionButton, AmountInput, Panel, parseAmount, toInput } from "./ui";
import { approveStep, permit2Steps, useTxFlow, type FlowStep } from "./useTxFlow";

export default function LiquidityPanel({ market, user, onDone, highlight }: { market: BookMarket; user: BookUser | undefined; onDone: () => void; highlight?: boolean }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(onDone);
  const [amount, setAmount] = useState(highlight ? "100" : "");
  if (!market.tradingOpen) return null;

  const raw = parseAmount(amount);
  const plan = seedPlan(market, raw);
  const room = market.depositCap > BigInt(0) ? market.depositCap - market.collateral : undefined;
  const overCap = !!plan && room !== undefined && plan.sets > room;
  const tooMuch = user !== undefined && raw > user.usdg;

  const submit = () => {
    if (!address || !plan) return;
    const steps: FlowStep[] = [
      approveStep(client, writeContractAsync, { token: USDG, owner: address, spender: market.market, amount: plan.sets, label: "Approve USDG for the market" }),
      {
        id: "mint",
        label: `Mint ${fmtAmount(plan.sets)} full sets`,
        run: () => writeContractAsync({ address: market.market, abi: obMarketAbi, functionName: "mintSet", args: [plan.sets, address], chainId: TARGET_CHAIN_ID }),
      },
      ...permit2Steps(client, writeContractAsync, { token: USDG, symbol: "USDG", owner: address, spender: POSITION_MANAGER, spenderName: "Uniswap's position manager", amount: plan.usdgToPools }),
      ...plan.positions.flatMap((p) =>
        permit2Steps(client, writeContractAsync, { token: p.outcome.token, symbol: p.outcome.name, owner: address, spender: POSITION_MANAGER, spenderName: "Uniswap's position manager", amount: p.tokens }),
      ),
      {
        id: "positions",
        label: `Add liquidity to ${plan.positions.length} pools`,
        run: () =>
          writeContractAsync({
            address: POSITION_MANAGER,
            abi: positionManagerAbi,
            functionName: "modifyLiquidities",
            args: [seedUnlockData(plan, address), BigInt(Math.floor(Date.now() / 1000) + 1200)],
            chainId: TARGET_CHAIN_ID,
          }),
      },
    ];
    void start("Add liquidity", steps);
  };

  return (
    <Panel title="Add liquidity" collapsible open={highlight}>
      {modal}
      <div className="space-y-3">
        {highlight && (
          <p className="border border-[#00ff87]/40 bg-[#00ff87]/10 p-3 font-mono text-[11px] text-black dark:text-white leading-relaxed">
            Your market is live. Market orders need liquidity in the pools, so add some to open it to trading.
          </p>
        )}
        <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
          Your USDG mints full sets, and each outcome&apos;s pool gets those tokens plus USDG at today&apos;s price, spread from 0.001 to 0.999. Positions earn no swap fee (the market&apos;s fee goes to the creator and PFWA), so this is for getting a market trading. Each position is a Uniswap v4 position NFT in your wallet, and you can take it out any time under Your liquidity.
        </p>
        <AmountInput
          label="USDG in"
          value={amount}
          onChange={setAmount}
          unit="USDG"
          balance={user ? fmtAmount(user.usdg) : undefined}
          onMax={user ? () => setAmount(toInput(user.usdg)) : undefined}
        />
        {plan && (
          <div className="font-mono text-[11px] text-neutral-500 space-y-1">
            <div className="flex justify-between"><span>Full sets minted</span><span className="tabular-nums text-black dark:text-white">{fmtAmount(plan.sets)}</span></div>
            {plan.positions.map((p) => (
              <div key={p.outcome.token} className="flex justify-between gap-3">
                <span>{p.outcome.name} pool</span>
                <span className="tabular-nums text-right text-neutral-700 dark:text-neutral-300">{fmtAmount(p.tokens)} {p.outcome.name} + {fmtAmount(p.usdg)} USDG</span>
              </div>
            ))}
          </div>
        )}
        <ActionButton onClick={submit} disabled={running || !plan || tooMuch || overCap}>
          {tooMuch ? "Not enough USDG" : overCap ? "Over the deposit cap" : "Add liquidity"}
        </ActionButton>
      </div>
    </Panel>
  );
}
