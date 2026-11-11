"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { ArrowLeft, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { useAccount, useWriteContract } from "wagmi";
import { robinhoodChain, TARGET_CHAIN_ID } from "@/lib/config";
import { OB, OB_ENABLED } from "@/lib/orderbook/config";
import { obHookAbi } from "@/lib/orderbook/abi";
import { fmtAmount, fmtUsdg } from "@/lib/orderbook/math";
import { marketPhase } from "@/lib/orderbook/read";
import { useBookMarket, useBookUser, useRefreshBook } from "@/hooks/useBook";
import TradePanel, { type LimitPick } from "@/components/book/TradePanel";
import OrderBookView from "@/components/book/OrderBookView";
import MyOrders from "@/components/book/MyOrders";
import SetsPanel from "@/components/book/SetsPanel";
import ResolutionPanel, { ResolveButton } from "@/components/book/ResolutionPanel";
import BookOracleCard, { useOracleRow } from "@/components/book/BookOracleCard";
import BookPriceChart from "@/components/book/BookPriceChart";
import BookActivity from "@/components/book/BookActivity";
import MarketCard from "@/components/MarketCard";
import CreatorRow from "@/components/market/CreatorRow";
import { bookMarketCard } from "@/lib/orderbook/listing";
import LiquidityPanel from "@/components/book/LiquidityPanel";
import LockedLiquidityPanel from "@/components/book/LockedLiquidityPanel";
import WithdrawPanel from "@/components/book/WithdrawPanel";
import PayAnyChain from "@/components/book/PayAnyChain";
import { Panel, utc, PreviewNotice } from "@/components/book/ui";
import { useTxFlow } from "@/components/book/useTxFlow";

const EXPLORER = robinhoodChain.blockExplorers.default.url;

export default function BookMarketPage() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { address } = useAccount();
  const { data: market, isLoading, isError } = useBookMarket(id);
  const { data: user } = useBookUser(market, address);
  const refresh = useRefreshBook();
  // ?outcome=YES (from a card's outcome button in the markets grid) picks that outcome to trade.
  const outcomeParam = useSearchParams().get("outcome");
  const [outcomeIndex, setOutcomeIndex] = useState(0);
  const [pickedFromLink, setPickedFromLink] = useState(false);
  const [pick, setPick] = useState<LimitPick>(null);
  const { writeContractAsync } = useWriteContract();
  const { start, modal, running } = useTxFlow(refresh);
  // Just created (/book/:id?new=1): lead with adding liquidity.
  const justCreated = useSearchParams().has("new");
  const { data: oracle } = useOracleRow(id);
  const [copied, setCopied] = useState(false);
  // pfwa.fun shows the creator's PFWA profile here (from its database); this standalone app shows the address.
  const creatorUser = undefined;

  if (!OB_ENABLED) return <Shell><p className="font-mono text-sm text-neutral-500">Order book markets aren&apos;t live yet.</p></Shell>;
  if (isLoading) return <Shell><p className="font-mono text-xs text-neutral-500 flex items-center gap-2"><Loader2 className="w-3 h-3 animate-spin" /> Reading the market from chain…</p></Shell>;
  if (isError || !market) return <Shell><p className="font-mono text-sm text-neutral-500">{isError ? "Couldn't read this market. Retrying…" : `There's no order book market #${params.id}.`}</p></Shell>;

  if (!pickedFromLink && outcomeParam) {
    const i = market.outcomes.findIndex((o) => o.name.toLowerCase() === outcomeParam.toLowerCase());
    setPickedFromLink(true);
    if (i >= 0) setOutcomeIndex(i);
  }
  const phase = marketPhase(market);
  const outcome = market.outcomes[Math.min(outcomeIndex, market.outcomes.length - 1)];
  const fee = (market.creatorFeeBps + market.protocolFeeBps) / 100;
  const hook = market.outcomes[0].key.hooks;
  const card = bookMarketCard(market, oracle ?? null, creatorUser);
  // On a phone the trade panel sits below the market, so picking an outcome (or a price in the book) brings it into
  // view.
  const toTrade = () => {
    if (window.innerWidth < 1024) setTimeout(() => document.getElementById("trade-panel")?.scrollIntoView({ behavior: "smooth" }), 50);
  };

  return (
    <Shell>
      {modal}
      <CreatorRow
        creator={market.creator}
        creatorUser={creatorUser}
        actions={
          <>
            <ResolveButton market={market} user={user} onDone={refresh} oracle={oracle} />
            <button
              type="button"
              onClick={() => { void navigator.clipboard.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
              className="flex items-center gap-1.5 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 rounded hover:bg-neutral-200 dark:hover:bg-neutral-800 transition-colors shadow-sm"
            >
              <ExternalLink className="w-3 h-3 text-neutral-500" />
              <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-neutral-500">{copied ? "Copied" : "Share"}</span>
            </button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
        <div className="space-y-4 min-w-0">
          <MarketCard
            {...card}
            showAll
            showStats={false}
            selectedOutcomeLabel={outcome.name}
            onSelectOutcome={(o: { label: string }) => { setOutcomeIndex(Math.max(0, market.outcomes.findIndex((x) => x.name === o.label))); toTrade(); }}
          />
          <dl className="flex flex-wrap gap-x-6 gap-y-1.5 font-mono text-xs px-1">
            <Meta k={phase === "trading" ? "Trading ends" : "Trading ended"} v={utc(market.endOfTrading)} />
            <Meta k="In the market" v={`${fmtUsdg(market.collateral)} USDG`} />
            <Meta k="Fee" v={`${fee}%`} />
            {user && market.outcomes.map((o, i) => user.balances[i] > BigInt(0) && <Meta key={o.token} k={`Your ${o.name}`} v={fmtAmount(user.balances[i])} />)}
          </dl>

          <details className="group w-full bg-white dark:bg-[#0a0a0a] border border-neutral-200 dark:border-neutral-800 p-4">
            <summary className="font-heading font-600 text-sm flex items-center justify-between cursor-pointer list-none [&::-webkit-details-marker]:hidden text-black dark:text-white">
              <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-blue-500" />Resolution Rules</span>
              <ChevronDown className="w-4 h-4 text-neutral-500 group-open:rotate-180 transition-transform" />
            </summary>
            <div className="pt-4 mt-2 border-t border-neutral-200 dark:border-neutral-800">
              <p className="font-mono text-xs text-neutral-700 dark:text-neutral-300 leading-relaxed whitespace-pre-wrap break-words">{market.rules}</p>
              <p className="mt-3 font-mono text-[10px] text-neutral-500">Stored onchain with the market. Disputes are judged against these rules.</p>
            </div>
          </details>

          <BookPriceChart market={market} />
          {oracle && <BookOracleCard oracle={oracle} resolved={market.resolved} expired={phase !== "trading"} />}

          <BookActivity market={market} />

          <OrderBookView outcome={outcome} onPick={(p) => { setPick(p); if (p) toTrade(); }} outcomes={market.outcomes} onOutcome={setOutcomeIndex} />
          <MyOrders market={market} onDone={refresh} />

          <Panel title="Contracts" collapsible dot="#a855f7" right={<span className="font-mono text-[10px] text-neutral-500">Fee {market.creatorFeeBps / 100}% creator · {market.protocolFeeBps / 100}% PFWA</span>}>
            <ul className="space-y-2 font-mono text-[11px]">
              <Addr k="Market (holds the USDG)" a={market.market} />
              {market.outcomes.map((o) => <Addr key={o.token} k={`${o.name} token`} a={o.token} />)}
              <Addr k="Creator" a={market.creator} />
              <Addr k="Hook (fees, trading window)" a={hook} />
              {OB.limitOrders && <Addr k="Limit orders" a={OB.limitOrders} />}
              {OB.resolver && <Addr k="Resolver (outcome, disputes)" a={OB.resolver} />}
            </ul>
          </Panel>
        </div>

        <aside className="space-y-6 min-w-0 lg:sticky lg:top-4">
          {OB.locker && <LockedLiquidityPanel market={market} user={user} onDone={refresh} highlight={justCreated} />}
          {!OB.locker && justCreated && <LiquidityPanel market={market} user={user} onDone={refresh} highlight />}
          <div id="trade-panel" className="scroll-mt-4">
            <TradePanel market={market} outcomeIndex={outcomeIndex} onOutcome={setOutcomeIndex} user={user} pick={pick} onDone={refresh} />
          </div>
          <SetsPanel market={market} user={user} onDone={refresh} />
          {OB.forwarder && <PayAnyChain market={market} outcomeIndex={outcomeIndex} onDone={refresh} />}
          <ResolutionPanel market={market} user={user} onDone={refresh} />
          {(OB.locker || !justCreated) && <LiquidityPanel market={market} user={user} onDone={refresh} />}
          <WithdrawPanel market={market} onDone={refresh} />
          {user && user.creatorFees > BigInt(0) && (
            <Panel title="Your creator fees">
              <div className="flex items-center justify-between gap-3">
                <span className="font-heading font-bold text-lg text-black dark:text-white tabular-nums">{fmtUsdg(user.creatorFees)} USDG</span>
                <button
                  type="button"
                  disabled={running}
                  onClick={() =>
                    void start("Claim creator fees", [{
                      id: "claim",
                      label: `Claim ${fmtUsdg(user.creatorFees)} USDG`,
                      run: () => writeContractAsync({ address: hook, abi: obHookAbi, functionName: "claimCreatorFees", args: [address!], chainId: TARGET_CHAIN_ID }),
                    }])
                  }
                  className="px-3 py-2 bg-[#00ff87] text-black font-heading font-bold text-xs disabled:opacity-40"
                >
                  Claim
                </button>
              </div>
              <p className="mt-2 font-mono text-[10px] text-neutral-500">From every market you created, across the hook.</p>
            </Panel>
          )}
        </aside>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto bg-neutral-50 dark:bg-[#0a0a0a] px-4 sm:px-6 py-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <Link href="/book" className="inline-flex items-center gap-1.5 font-mono text-xs text-neutral-500 hover:text-black dark:hover:text-white">
          <ArrowLeft className="w-3.5 h-3.5" /> Order book markets
        </Link>
        <PreviewNotice />
        {children}
      </div>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-neutral-500">{k}</dt>
      <dd className="text-black dark:text-white tabular-nums">{v}</dd>
    </div>
  );
}

function Addr({ k, a }: { k: string; a: string }) {
  return (
    <li className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-3 p-2.5 border border-neutral-100 dark:border-neutral-800/60 bg-neutral-50 dark:bg-neutral-900/30">
      <span className="text-neutral-500">{k}</span>
      <a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-black dark:text-neutral-300 hover:underline break-all">
        {a} <ExternalLink className="w-3 h-3 flex-shrink-0" />
      </a>
    </li>
  );
}
