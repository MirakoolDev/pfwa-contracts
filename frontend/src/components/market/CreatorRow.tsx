"use client";
// The creator row above a market: Ethos avatar, name and score, PFWA's own markets marked verified, and the
// page's buttons (Resolve, Share) on the right. Same lookup and look as the bonding curve market page
// (app/market/[id]); used by order book markets (app/book/[id]).
import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import EthosScore from "@/components/EthosScore";
import { DitherAvatar } from "@/components/dither-kit/avatar";

const ETHOS_DEFAULT_SCORE = 1200;
/** Wallets whose markets show as "by PFWA" (NEXT_PUBLIC_PROTOCOL_WALLETS, comma-separated). */
const PROTOCOL_WALLETS = (process.env.NEXT_PUBLIC_PROTOCOL_WALLETS ?? "").toLowerCase().split(",").map((a) => a.trim()).filter(Boolean);

type Profile = { name: string; avatar: string; link: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CreatorUser = any;

export default function CreatorRow({ creator, creatorUser, onFraudWatch, actions }: { creator: string; creatorUser?: CreatorUser; onFraudWatch?: boolean; actions?: React.ReactNode }) {
  const [score, setScore] = useState<number | null>(null);
  const [noProfile, setNoProfile] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const adminWallet = process.env.NEXT_PUBLIC_ADMIN_WALLET?.toLowerCase();
  const orchestratorWallet = process.env.NEXT_PUBLIC_ORCHESTRATOR_ADDRESS?.toLowerCase();
  const cLower = creator.toLowerCase();
  const isAdmin = cLower === adminWallet || cLower === orchestratorWallet || PROTOCOL_WALLETS.includes(cLower);

  useEffect(() => {
    setScore(null);
    setNoProfile(false);
    setProfile(null);
    setAvatarFailed(false);
    // Protocol markets (admin, orchestrator, relayer) show the admin wallet's Ethos profile.
    const addressToFetch = isAdmin && adminWallet ? adminWallet : creator;
    let live = true;
    fetch("https://api.ethos.network/api/v2/users/by/address", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ethos-Client": "PFWA" },
      body: JSON.stringify({ addresses: [addressToFetch] }),
    })
      .then((r) => r.json())
      .then(async (data) => {
        if (!live) return;
        const user = Array.isArray(data) ? data[0] : undefined;
        if (user) {
          setProfile({
            name: user.displayName || "Creator Profile",
            avatar: user.avatarUrl || "",
            link: user.links?.profile || `https://app.ethos.network/profile/${addressToFetch}`,
          });
        }
        if (typeof user?.score === "number") {
          setScore(user.score);
          setNoProfile(!user.profileId);
          return;
        }
        // Wallets Ethos hasn't indexed answer 0 / "untrusted", which only means "never seen"; Ethos's own app shows
        // its default 1200 for them, so show that, marked as no profile.
        const res = await fetch(`https://api.ethos.network/api/v2/score/address?address=${encodeURIComponent(addressToFetch)}`, { headers: { "X-Ethos-Client": "PFWA" } });
        if (!res.ok || !live) return;
        const s = await res.json();
        if (typeof s?.score !== "number") return;
        setScore(s.score === 0 && s.level === "untrusted" ? ETHOS_DEFAULT_SCORE : s.score);
        setNoProfile(true);
      })
      .catch((err) => console.error("Failed to fetch Ethos score:", err));
    return () => { live = false; };
  }, [creator, isAdmin, adminWallet]);

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div className="flex items-center gap-3 sm:gap-5 min-w-0">
        <div className="relative flex-shrink-0">
          {profile?.avatar && !avatarFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.avatar} alt="Creator" onError={() => setAvatarFailed(true)} className="w-10 h-10 sm:w-12 sm:h-12 rounded-full object-cover border-2 border-neutral-200 dark:border-neutral-800" />
          ) : (
            <DitherAvatar name={creator} className="w-10 h-10 sm:w-12 sm:h-12 rounded-full" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <h3 className="font-heading font-bold text-sm sm:text-base text-black dark:text-white line-clamp-1">
              {isAdmin ? "by PFWA" : profile?.name || creatorUser?.username || "Creator Profile"}
            </h3>
            {isAdmin && <CheckCircle2 className="w-4 h-4 flex-shrink-0 text-emerald-500" aria-label="Verified protocol market" />}
            {score !== null && <EthosScore score={score} href={profile?.link || `https://app.ethos.network/profile/${creator}`} />}
            {score !== null && noProfile && !isAdmin && (
              <span className="font-mono text-[9px] uppercase tracking-widest text-amber-500" title="This wallet has no Ethos profile, so it shows Ethos's default starting score.">
                no profile
              </span>
            )}
          </div>
          <div className="font-mono text-[10px] sm:text-xs text-neutral-500 mt-1 flex items-center gap-2">
            <span>{isAdmin ? "Verified protocol market" : creatorUser?.username || <>{creator.slice(0, 6)}...{creator.slice(-4)}</>}</span>
            {creatorUser?.marketsCreated > 0 && !isAdmin && (
              <span className="px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-[9px]">
                {((creatorUser.marketsResolvedBySelf / creatorUser.marketsCreated) * 100).toFixed(0)}% SELF-RESOLVED
              </span>
            )}
            {onFraudWatch && (
              <span className="px-1.5 py-0.5 rounded font-bold uppercase tracking-widest text-[9px] bg-rose-500/10 text-rose-500 border border-rose-500/20 ml-2">⚠️ ON FRAUD WATCH</span>
            )}
          </div>
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
