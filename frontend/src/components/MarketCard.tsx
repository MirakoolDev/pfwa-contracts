"use client";
import { useState, useEffect } from "react";
import { CheckCircle2, TrendingUp, Trophy, Users } from "lucide-react";
import { isFootballMarket } from "@/lib/football";
import { DitherButton } from "./dither-kit/button";

interface MarketCardProps {
  title: string;
  volume: string;
  image?: string;
  image2?: string;
  category: string;
  outcomes: { label: string; chance: number; color: string }[];
  onSelectOutcome?: (outcome: any) => void;
  onSelectMarket?: () => void;
  showAll?: boolean;
  resolved?: boolean;
  winningOptionIndex?: number;
  selectedOutcomeLabel?: string;
  tradesCount?: number;
  creator?: string;
  creatorIsOnFraudWatch?: boolean;
  resolutionCriteria?: React.ReactNode;
  showStats?: boolean;
  hideLiquidityStats?: boolean;
  oracleData?: any;
  creatorUser?: any;
  /** 'book': an order book market (USDG, app/book/[id]); bonding curve markets leave it out. */
  pricing?: 'book';
}

// Every option sits in one row (up to 5), so multi-option cards are the same
// height as YES/NO cards. Literal class names so Tailwind picks them up.
const MAX_OUTCOMES_PER_ROW = 5;
const OUTCOME_GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5',
};

export default function MarketCard({ title, volume, category, outcomes, image, image2, endsOn, onSelectOutcome, onSelectMarket, showAll = false, resolved = false, winningOptionIndex = -1, selectedOutcomeLabel, tradesCount = 0, creator, creatorIsOnFraudWatch, resolutionCriteria, showStats = true, hideLiquidityStats = false, oracleData, creatorUser, pricing }: MarketCardProps & { endsOn?: string }) {
  const rawQuestion = title.split(' | ')[0];
  // For challenge markets, oracleData.displayName is the correct trader name.
  // The onchain question string may contain the wrong name (e.g. "unipcs") — override it.
  const question = (() => {
    if (oracleData?.isChallenge && oracleData?.displayName && oracleData?.fomoHandle) {
      // The onchain string has the wrong name — replace any occurrence of it before "reach"
      const wrongName = rawQuestion.match(/^Will (.+?) reach/)?.[1];
      if (wrongName && wrongName !== oracleData.displayName) {
        return rawQuestion.replace(wrongName, oracleData.displayName);
      }
    }
    return rawQuestion;
  })();
  const ethVolume = parseFloat(volume.replace(' ETH', ''));
  const hasActivity = ethVolume > 0 || tradesCount > 0;
  const isExpired = endsOn === "Expired";
  
  const avatarSize = showAll ? "w-20 h-20" : "w-12 h-12";
  const titleSize = showAll ? "text-xl" : "text-sm";

  const [creatorName, setCreatorName] = useState<string | null>(null);

  useEffect(() => {
    if (creator && !showAll) {
      const adminWallet = process.env.NEXT_PUBLIC_ADMIN_WALLET?.toLowerCase();
      const orchestratorWallet = process.env.NEXT_PUBLIC_ORCHESTRATOR_ADDRESS?.toLowerCase();
      
      const cLower = creator.toLowerCase();
      if (cLower === adminWallet || cLower === orchestratorWallet || (process.env.NEXT_PUBLIC_PROTOCOL_WALLETS ?? "").toLowerCase().split(",").map((a) => a.trim()).includes(cLower)) {
        setCreatorName("PFWA");
        return;
      }
      if (creatorUser?.username) {
        setCreatorName(creatorUser.username);
        return;
      }
      fetch('https://api.ethos.network/api/v2/users/by/address', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: [creator] })
      })
      .then(res => res.json())
      .then(data => {
        if (data && data[0] && data[0].displayName) {
          setCreatorName(data[0].displayName);
        }
      })
      .catch(console.error);
    }
  }, [creator, showAll, creatorUser?.username]);

  const displayCreator = creatorName ? creatorName : (creator ? `${creator.slice(0, 6)}...${creator.slice(-4)}` : "");

  const isChallenge = oracleData?.isChallenge === true;
  const isRwa = oracleData?.isRwa === true;
  const isFootball = isFootballMarket(oracleData);

  // Humanise category label
  const categoryLabel = (() => {
    const raw = category ?? '';
    if (raw.includes(' · ')) return raw; // template label from lib/marketTypes.ts
    if (raw === 'rwa') return 'Real World Asset';
    if (raw === 'precious-metals') return 'Precious Metals';
    if (raw === 'private-credit') return 'Private Credit';
    if (raw === 'treasuries') return 'Treasuries';
    if (raw === 'money-markets') return 'Money Markets';
    if (raw === 'equities') return 'Equities';
    if (raw === 'infrastructure') return 'Infrastructure';
    return raw;
  })();

  const statusPill = resolved ? (
    <span className="font-mono text-[9px] uppercase tracking-wider text-emerald-500 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 whitespace-nowrap">
      Resolved
    </span>
  ) : isExpired ? (
    <span className="font-mono text-[9px] uppercase tracking-wider text-neutral-400 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 px-2 py-0.5 whitespace-nowrap">
      Expired
    </span>
  ) : (
    <span className="flex items-center gap-1.5 bg-neutral-50 dark:bg-neutral-900/80 border border-neutral-200 dark:border-neutral-800 px-2 py-0.5 whitespace-nowrap">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      <span className="font-mono text-[9px] text-neutral-500 dark:text-neutral-400 uppercase tracking-wider">{endsOn}</span>
    </span>
  );

  return (
    <div 
      onClick={onSelectMarket}
      className={`bg-white dark:bg-[#0d0d0d] border transition-all duration-200 cursor-pointer flex flex-col group relative overflow-hidden ${
        isChallenge 
          ? "border-amber-500/40 dark:border-amber-500/40 hover:border-amber-400 dark:hover:border-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.15)] dark:shadow-[0_0_20px_rgba(245,158,11,0.2)]" 
          : isRwa
          ? "border-teal-500/40 dark:border-teal-500/40 hover:border-teal-400 dark:hover:border-teal-400 shadow-[0_0_15px_rgba(20,184,166,0.1)] dark:shadow-[0_0_20px_rgba(20,184,166,0.15)]"
          : "border-neutral-200 dark:border-neutral-800/80 hover:border-neutral-400 dark:hover:border-neutral-600"
      }`}
    >
      {/* Subtle top accent line for live markets */}
      {!isExpired && !resolved && (
        <div className={`absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent ${
          isChallenge ? 'via-amber-500/60' : isRwa ? 'via-teal-500/60' : 'via-emerald-500/60'
        } to-transparent`} />
      )}

      {/* Main Content — grows so the outcome bars sit at the bottom of every card */}
      <div className="p-4 flex flex-col gap-3 flex-1">

        {/* Meta line: market type · creator, status on the right — one line, never wraps */}
        <div className="flex items-center gap-2 min-w-0">
          {categoryLabel && (
            <span className={`font-mono text-[9px] uppercase tracking-widest whitespace-nowrap ${
              isRwa ? 'text-teal-500 dark:text-teal-400' : isChallenge ? 'text-amber-500' : isFootball ? 'text-violet-500 dark:text-violet-400' : 'text-neutral-400 dark:text-neutral-500'
            }`}>
              {isFootball && <Trophy className="inline w-2.5 h-2.5 mr-1 -mt-px" aria-hidden="true" />}{categoryLabel}
            </span>
          )}
          {creator && !showAll && (
            <span
              className="font-mono text-[9px] text-neutral-400 dark:text-neutral-500 uppercase tracking-widest flex items-center gap-1 min-w-0 cursor-default"
              title={creatorUser?.marketsCreated > 0 && creatorName !== "PFWA"
                ? `${((creatorUser.marketsResolvedBySelf / creatorUser.marketsCreated) * 100).toFixed(0)}% self-resolved (${creatorUser.marketsCreated} markets)`
                : creator}
            >
              <span className="text-neutral-300 dark:text-neutral-700">&bull;</span>
              <span className="truncate">by {displayCreator}</span>
              {creatorName === "PFWA" && <CheckCircle2 className="w-3 h-3 flex-shrink-0 text-emerald-500" />}
            </span>
          )}
          {pricing === 'book' && (
            <span className="font-mono text-[9px] uppercase tracking-widest whitespace-nowrap text-sky-500 dark:text-sky-400" title="Order book market, traded in USDG">
              <span className="text-neutral-300 dark:text-neutral-700 mr-1">&bull;</span>Order book
            </span>
          )}
          <span className="ml-auto flex-shrink-0">{statusPill}</span>
        </div>

        {/* Token avatar(s) + question */}
        <div className="flex items-center gap-3">
          {/* Multi-option markets get smaller, tighter avatars capped at 3 (+N) */}
          {(() => {
            let extraImages: string[] = [];
            if (oracleData?.extraTokens) {
              try { extraImages = JSON.parse(oracleData.extraTokens).map((t: any) => t.imageUrl).filter(Boolean); } catch {}
            }
            const images = [image, image2, ...extraImages].filter(Boolean) as string[];
            const isMulti = images.length > 2;
            const size = isMulti ? (showAll ? 'w-12 h-12' : 'w-9 h-9') : avatarSize;
            const overlap = isMulti ? (showAll ? '-space-x-4' : '-space-x-3') : (showAll ? '-space-x-6' : '-space-x-4');
            const shown = images.slice(0, isMulti ? (showAll ? 4 : 3) : 2);
            const hidden = images.length - shown.length;
            const ring = 'rounded-full ring-2 ring-white dark:ring-[#0d0d0d] relative';
            return (
              <div className={`flex ${overlap} flex-shrink-0`}>
                {shown.length === 0 ? (
                  <div className={`${size} ${ring} overflow-hidden bg-neutral-900 flex items-center justify-center`}>
                    <img src="/dither-logo.svg" alt="PFWA" className="w-full h-full object-cover" />
                  </div>
                ) : shown.map((src, i) => (
                  <div key={i} className={`${size} ${ring} overflow-hidden bg-neutral-100 dark:bg-neutral-900`} style={{ zIndex: shown.length - i + 1 }}>
                    <img src={src} alt="" className="w-full h-full object-cover" />
                  </div>
                ))}
                {hidden > 0 && (
                  <div className={`${size} ${ring} bg-neutral-100 dark:bg-neutral-900 flex items-center justify-center font-mono text-[10px] text-neutral-500`}>
                    +{hidden}
                  </div>
                )}
              </div>
            );
          })()}

          <h3 className={`flex-1 min-w-0 font-heading font-bold text-black dark:text-white ${titleSize} leading-snug ${showAll ? '' : 'line-clamp-2'}`} title={showAll ? undefined : question}>
            {question}
          </h3>
        </div>

        {/* Activity stats row — only when there's data AND showStats is on */}
        {showStats && hasActivity && (
          <div className="flex items-center gap-4 mt-1 flex-wrap">
            <div className="flex items-center gap-1">
              {creatorIsOnFraudWatch ? (
                <span className="px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-500 border border-rose-500/20 mr-2 flex items-center gap-1">
                  ⚠️ On Fraud Watch
                </span>
              ) : null}
              
              {!hideLiquidityStats && (
                <>
                  <TrendingUp className="w-3 h-3 text-neutral-400" />
                  <span className="font-mono text-[10px] text-neutral-500">{pricing === 'book' ? volume : `${ethVolume.toFixed(4)} ETH`}</span>
                </>
              )}
            </div>
            {!hideLiquidityStats && (
              <div className="flex items-center gap-1">
                <Users className="w-3 h-3 text-neutral-400" />
                <span className="font-mono text-[10px] text-neutral-500">{tradesCount} trades</span>
              </div>
            )}
          </div>
        )}

        {/* Fraud Watch Alert - Fallback if no activity */}
        {creatorIsOnFraudWatch && !hasActivity && (
          <div className="flex items-center mt-2">
            <span className="px-1.5 py-0.5 rounded text-[8px] sm:text-[9px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-500 border border-rose-500/20 flex items-center gap-1">
              ⚠️ On Fraud Watch
            </span>
          </div>
        )}

        {/* Resolution Criteria */}
        {resolutionCriteria && showAll && (
          <div className="mt-3 pr-4">
            {resolutionCriteria}
          </div>
        )}
      </div>

      {/* Outcome buttons — flush to bottom, no padding container */}
      <div className={`grid gap-px border-t border-neutral-200 dark:border-neutral-800/80 ${OUTCOME_GRID_COLS[Math.min(outcomes.length, MAX_OUTCOMES_PER_ROW)] ?? 'grid-cols-2'}`}>
        {(showAll ? outcomes : outcomes.slice(0, MAX_OUTCOMES_PER_ROW)).map((outcome, idx) => {
          const isWinner = resolved && winningOptionIndex === idx;
          const isSelected = selectedOutcomeLabel === outcome.label;
          return (
            <div
              key={idx}
              className={`relative ${resolved && !isWinner ? 'opacity-30' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                if (onSelectOutcome) onSelectOutcome(outcome);
              }}
            >
              <DitherButton
                color={outcome.color as "green" | "blue" | "red" | "purple" | "orange"}
                variant="gradient"
                className={`w-full font-mono uppercase transition-all ${outcomes.length > 3 ? 'text-[10px] tracking-normal px-1.5' : 'text-xs tracking-wider'} ${isSelected ? 'opacity-100' : 'opacity-80 hover:opacity-100'}`}
              >
                <span className="flex items-center justify-center gap-1.5 w-full min-w-0" title={outcome.label}>
                  {isWinner && <CheckCircle2 className="w-3 h-3 flex-shrink-0" />}
                  <span className="truncate">{outcome.label}</span>
                  {!resolved && outcome.chance > 0 && (
                    <span 
                      className="opacity-60 text-[10px] cursor-help flex-shrink-0"
                      title="This outcome's share of the ETH in the market"
                    >
                      {outcome.chance.toFixed(0)}%
                    </span>
                  )}
                </span>
              </DitherButton>
              {isSelected && (
                <div className="absolute inset-0 ring-2 ring-inset ring-blue-500 pointer-events-none" />
              )}
            </div>
          );
        })}
        {!showAll && outcomes.length > MAX_OUTCOMES_PER_ROW && (
          <div className="col-span-full font-mono text-[10px] text-neutral-500 dark:text-neutral-400 text-center py-2">
            +{outcomes.length - MAX_OUTCOMES_PER_ROW} more outcomes
          </div>
        )}
      </div>

    </div>
  );
}


