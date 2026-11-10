"use client";
// Resolution: posting the outcome stops trading and opens a 2-hour dispute window. Anyone can dispute by posting
// the market's bond; the arbiter settles disputes. Once final, winning tokens redeem for 1 USDG each.
import { useEffect, useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { PublicClient } from "viem";
import { TARGET_CHAIN_ID } from "@/lib/config";
import { INVALID_OUTCOME, OB, USDG } from "@/lib/orderbook/config";
import { obMarketAbi, obResolverAbi } from "@/lib/orderbook/abi";
import { fmtAmount } from "@/lib/orderbook/math";
import { marketPhase, outcomeLabel, type BookMarket } from "@/lib/orderbook/read";
import type { BookUser } from "@/hooks/useBook";
import { ActionButton, Panel, countdown, utc } from "./ui";
import { approveStep, useTxFlow, type FlowStep } from "./useTxFlow";
import BookOracleCard, { useOracleVerdict, type OracleRow } from "./BookOracleCard";

export default function ResolutionPanel({ market, user, onDone }: { market: BookMarket; user: BookUser | undefined; onDone: () => void }) {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: TARGET_CHAIN_ID }) as unknown as PublicClient;
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(onDone);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [pick, setPick] = useState<number>(0);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const resolver = OB.resolver!;
  const id = BigInt(market.id);
  const phase = marketPhase(market, now);
  const r = market.resolution;
  const bond = fmtAmount(r.bond);
  const windowOpen = now < r.disputeEnds;

  const write = (functionName: "resolveMarket" | "dispute" | "finalize" | "settleDispute", args: readonly unknown[]) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    writeContractAsync({ address: resolver, abi: obResolverAbi, functionName, args: args as any, chainId: TARGET_CHAIN_ID });

  const choices = [...market.outcomes.map((o) => o.index), INVALID_OUTCOME];
  const OutcomePicker = (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Outcome">
      {choices.map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={pick === i}
          onClick={() => setPick(i)}
          className={`px-2.5 py-1.5 border font-mono text-[11px] transition-colors ${
            pick === i ? "border-black dark:border-white bg-black dark:bg-white text-white dark:text-black font-bold" : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-black dark:hover:text-white"
          }`}
        >
          {i === INVALID_OUTCOME ? "Invalid" : market.outcomes[i].name}
        </button>
      ))}
    </div>
  );

  // While trading, the outcome is posted from the Resolve button by the market header (ResolveButton below), as on
  // bonding curve markets; PFWA's resolver posts it for markets with a data source.
  if (phase === "trading" || phase === "ended") return null;

  let body: React.ReactNode;
  if (phase === "pending") {
    body = (
      <div className="space-y-3">
        <p className="font-heading font-bold text-lg text-black dark:text-white">{outcomeLabel(market, r.outcome)}</p>
        <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
          {windowOpen
            ? <>Final in <span className="text-black dark:text-white font-bold tabular-nums">{countdown(r.disputeEnds, now)}</span> ({utc(r.disputeEnds)}) unless someone disputes it. Disputing takes a {bond} USDG bond: you get it back if the arbiter changes the outcome, and lose it if the outcome stands.</>
            : <>The dispute window closed {utc(r.disputeEnds)}. Anyone can make it final now.</>}
        </p>
        {windowOpen ? (
          <ActionButton
            disabled={running || !address}
            onClick={() => {
              if (!address) return;
              const steps: FlowStep[] = [
                approveStep(client, writeContractAsync, { token: USDG, owner: address, spender: resolver, amount: r.bond, label: `Approve the ${bond} USDG bond` }),
                { id: "dispute", label: "Dispute the outcome", run: () => write("dispute", [id]) },
              ];
              void start("Dispute the outcome", steps);
            }}
          >
            Dispute ({bond} USDG bond)
          </ActionButton>
        ) : (
          <ActionButton disabled={running} onClick={() => void start("Make the outcome final", [{ id: "finalize", label: "Finalize", run: () => write("finalize", [id]) }])}>
            Make it final
          </ActionButton>
        )}
      </div>
    );
  } else if (phase === "disputed") {
    body = (
      <div className="space-y-3">
        <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
          Posted outcome <span className="text-black dark:text-white font-bold">{outcomeLabel(market, r.outcome)}</span> was disputed by <span className="break-all">{r.disputer}</span>. The arbiter (PFWA&apos;s multisig for now) sets the final outcome. If it changes, the disputer gets the {bond} USDG bond back; if it stands, the bond goes to the fee collector.
        </p>
        {user?.isArbiter && (
          <div className="space-y-2 border-t border-neutral-200 dark:border-neutral-800 pt-3">
            <p className="font-heading font-600 text-xs text-black dark:text-white">Settle the dispute</p>
            {OutcomePicker}
            <ActionButton
              disabled={running}
              onClick={() => void start("Settle the dispute", [{ id: "settle", label: `Final: ${outcomeLabel(market, pick)}`, run: () => write("settleDispute", [id, pick]) }])}
            >
              Set the final outcome
            </ActionButton>
          </div>
        )}
      </div>
    );
  } else {
    const winner = market.winningOutcome;
    const invalid = winner === INVALID_OUTCOME;
    const n = BigInt(market.outcomes.length);
    const redeemable = user
      ? market.outcomes.filter((o) => (invalid || o.index === winner) && user.balances[o.index] > BigInt(0))
      : [];
    const payout = user
      ? redeemable.reduce((s, o) => s + (invalid ? user.balances[o.index] / n : user.balances[o.index]), BigInt(0))
      : BigInt(0);
    body = (
      <div className="space-y-3">
        <p className="font-heading font-bold text-lg text-black dark:text-white">{invalid ? "Invalid" : `${outcomeLabel(market, winner)} won`}</p>
        <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
          {invalid
            ? `No outcome could be called, so every outcome token redeems for 1/${market.outcomes.length} USDG.`
            : `Each ${outcomeLabel(market, winner)} token redeems for 1 USDG. The other outcomes pay nothing.`}
        </p>
        {address && (
          redeemable.length > 0 ? (
            <ActionButton
              disabled={running}
              onClick={() =>
                void start(
                  "Redeem winnings",
                  redeemable.map((o) => ({
                    id: `redeem-${o.index}`,
                    label: `Redeem ${fmtAmount(user!.balances[o.index])} ${o.name}`,
                    run: () =>
                      writeContractAsync({ address: market.market, abi: obMarketAbi, functionName: "redeem", args: [o.index, user!.balances[o.index], address], chainId: TARGET_CHAIN_ID }),
                  })),
                )
              }
            >
              Redeem {fmtAmount(payout)} USDG
            </ActionButton>
          ) : (
            <p className="font-mono text-[11px] text-neutral-500">Nothing to redeem in this wallet.</p>
          )
        )}
      </div>
    );
  }

  return (
    <Panel title="Outcome">
      {modal}
      {body}
    </Panel>
  );
}

/**
 * The Resolve button by the market header, shown to whoever may post the outcome now (the creator, PFWA's resolver,
 * the owner), as on bonding curve markets. Opens a small dialog: pick the outcome, post it, trading stops and the
 * 2-hour dispute window opens. Markets with a data source are posted by PFWA's resolver; the dialog says so.
 */
export function ResolveButton({ market, user, onDone, oracle }: { market: BookMarket; user: BookUser | undefined; onDone: () => void; oracle: OracleRow | null | undefined }) {
  const hasOracle = !!oracle;
  const verdict = useOracleVerdict(oracle ?? null, marketPhase(market) !== "trading");
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(onDone);
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const phase = marketPhase(market);
  if (!OB.resolver || !user?.mayResolve || (phase !== "trading" && phase !== "ended")) return modal ?? null;
  const choices = [...market.outcomes.map((o) => o.index), INVALID_OUTCOME];
  const bond = fmtAmount(market.resolution.bond);
  const close = () => { if (!running) { setOpen(false); setPick(null); } };

  return (
    <>
      {modal}
      <button
        type="button"
        onClick={() => { setPick(verdict?.pick ?? null); setOpen(true); }}
        className="flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 rounded hover:bg-emerald-500/20 transition-colors"
      >
        <CheckCircle2 className="w-3 h-3 text-emerald-500" />
        <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-emerald-500">Resolve</span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
          <div role="dialog" aria-modal="true" aria-label="Resolve market" onClick={(e) => e.stopPropagation()} className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800">
            <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
              <h2 className="font-heading font-600 text-sm text-black dark:text-white">Resolve market</h2>
              <button type="button" onClick={close} aria-label="Close" className="text-neutral-500 hover:text-black dark:hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <p className="font-mono text-[11px] text-neutral-500 leading-relaxed">
                {hasOracle
                  ? <>PFWA&apos;s resolver posts this market&apos;s outcome from its data source when it&apos;s known. Post it yourself only if the resolver can&apos;t. </>
                  : null}
                Posting the outcome stops trading. Anyone can dispute it within 2 hours with a {bond} USDG bond.
              </p>
              {oracle && (
                <div className="space-y-3 p-3 border border-neutral-200 dark:border-neutral-800">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-neutral-500">What the oracle says</span>
                    {verdict && (
                      <span className={`font-mono text-[11px] font-bold ${verdict.pick === 0 ? "text-emerald-500" : verdict.pick === 1 ? "text-rose-500" : "text-amber-500"}`}>{verdict.text}</span>
                    )}
                  </div>
                  <BookOracleCard oracle={oracle} resolved={market.resolved} expired={phase !== "trading"} bare />
                </div>
              )}
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Outcome">
                {choices.map((i) => (
                  <button
                    key={i}
                    type="button"
                    role="radio"
                    aria-checked={pick === i}
                    onClick={() => setPick(i)}
                    className={`px-3 py-2 border font-mono text-xs transition-colors ${
                      pick === i ? "border-black dark:border-white bg-black dark:bg-white text-white dark:text-black font-bold" : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-black dark:hover:text-white"
                    }`}
                  >
                    {i === INVALID_OUTCOME ? "Invalid" : market.outcomes[i].name}
                  </button>
                ))}
              </div>
              <ActionButton
                disabled={running || pick === null}
                onClick={() => {
                  if (pick === null) return;
                  setOpen(false);
                  void start("Post the outcome", [{
                    id: "resolve",
                    label: `Post: ${outcomeLabel(market, pick)}`,
                    run: () => writeContractAsync({ address: OB.resolver!, abi: obResolverAbi, functionName: "resolveMarket", args: [BigInt(market.id), pick], chainId: TARGET_CHAIN_ID }),
                  }]);
                }}
              >
                {pick === null ? "Pick the outcome" : `Post ${outcomeLabel(market, pick)} and stop trading`}
              </ActionButton>
              {pick !== null && verdict?.pick != null && verdict.pick !== pick && (
                <p className="font-mono text-[11px] text-amber-500">The oracle points to {outcomeLabel(market, verdict.pick)}. Posting something else will likely be disputed.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
