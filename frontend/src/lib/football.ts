/**
 * Football match markets ("Who wins: Arsenal vs Chelsea?"), resolved from
 * football-data.org v4: https://docs.football-data.org/general/v4/match.html
 * Needs FOOTBALL_DATA_API_KEY (the free tier covers the Premier League, the
 * Champions League, La Liga, Serie A, the Bundesliga and Ligue 1, at 10 requests
 * a minute), so it's only ever called from the server.
 *
 * Stored on the existing oracle row, no schema change: tokenAddress is
 * `fd:<match id>`, marketType is FOOTBALL_HOME_DRAW_AWAY (the onchain outcome
 * order), network names the competition (`football-data` for the Premier
 * League, `football-data:CL` for the Champions League, `football-data:PD` for La
 * Liga and so on, see FOOTBALL_COMPETITIONS),
 * and the deadline is 105 minutes after kickoff (90 minutes plus half-time): it
 * trades live through the match and closes just before the final whistle.
 *
 * Two ways to settle a match (FootballBasis), picked by the creator per market:
 *  - NINETY (every competition): the score after 90 minutes plus stoppage time.
 *    Extra time and penalties never count, so a match level after 90 minutes
 *    resolves to Draw.
 *  - FULL_TIME (knockout competitions: the Champions League): the match's final
 *    result. Extra time counts and a shootout's winner wins; Draw only when the
 *    match ends level with no extra time (league phase, first legs). Stored as the
 *    competition's fullTimeNetwork (`football-data:CL:FT`).
 * Both keep the same three options, Home / Draw / Away, so they're identical onchain.
 */

export const FOOTBALL_DATA_API = 'https://api.football-data.org/v4';
export const FOOTBALL_DATA_HOME = 'https://www.football-data.org';
export const FOOTBALL_PREFIX = 'fd:';
/** The Premier League's network value: every football market before the Champions League was added. */
export const FOOTBALL_NETWORK = 'football-data';

/** A competition PFWA offers match markets on. */
export type FootballCompetition = {
  /** football-data.org competition code. */
  code: string;
  /** Full name, used in the rules text. */
  name: string;
  /** Short name for labels and market titles. */
  short: string;
  /** The oracle row's `network` for this competition's 90-minute markets. */
  network: string;
  /** The oracle row's `network` for its full-time markets (extra time and penalties count), or null if not offered. */
  fullTimeNetwork: string | null;
  /** Has knockout ties that can go to extra time and penalties (the market still resolves on 90 minutes). */
  knockouts: boolean;
  /** The Odds API sport key the MM agent prices this competition from, or null if it doesn't trade it. */
  oddsSportKey: string | null;
  emblem: string;
};

/**
 * Competitions offered on the create page, in this order. To add one: check
 * football-data.org's plan covers it, give it a new `network` value (never
 * reuse one) and an emblem, and set `knockouts` if a match can go to extra time
 * (and a `fullTimeNetwork` to offer full-time markets on it).
 */
export const FOOTBALL_COMPETITIONS: readonly FootballCompetition[] = [
  {
    code: 'PL',
    name: 'Premier League',
    short: 'Premier League',
    network: FOOTBALL_NETWORK,
    fullTimeNetwork: null,
    knockouts: false,
    oddsSportKey: 'soccer_epl',
    emblem: 'https://crests.football-data.org/PL.png',
  },
  {
    code: 'CL',
    name: 'UEFA Champions League',
    short: 'Champions League',
    network: 'football-data:CL',
    fullTimeNetwork: 'football-data:CL:FT',
    knockouts: true,
    oddsSportKey: 'soccer_uefa_champs_league',
    emblem: 'https://crests.football-data.org/CL.png',
  },
  // Domestic leagues: 90-minute markets only (a league match never goes to extra
  // time), and no bookmaker odds feed for the MM agent yet.
  {
    code: 'PD',
    name: 'La Liga',
    short: 'La Liga',
    network: 'football-data:PD',
    fullTimeNetwork: null,
    knockouts: false,
    oddsSportKey: null,
    emblem: 'https://crests.football-data.org/PD.png',
  },
  {
    code: 'SA',
    name: 'Serie A',
    short: 'Serie A',
    network: 'football-data:SA',
    fullTimeNetwork: null,
    knockouts: false,
    oddsSportKey: null,
    emblem: 'https://crests.football-data.org/SA.png',
  },
  {
    code: 'BL1',
    name: 'Bundesliga',
    short: 'Bundesliga',
    network: 'football-data:BL1',
    fullTimeNetwork: null,
    knockouts: false,
    oddsSportKey: null,
    emblem: 'https://crests.football-data.org/BL1.png',
  },
  {
    code: 'FL1',
    name: 'Ligue 1',
    short: 'Ligue 1',
    network: 'football-data:FL1',
    fullTimeNetwork: null,
    knockouts: false,
    oddsSportKey: null,
    emblem: 'https://crests.football-data.org/FL1.png',
  },
];

export const footballCompetitionByCode = (code: unknown): FootballCompetition | null =>
  FOOTBALL_COMPETITIONS.find((c) => c.code === code) ?? null;

/** A football network value (`football-data`, `football-data:CL`, ...), known or not. */
export const isFootballNetwork = (network: unknown): network is string =>
  typeof network === 'string' && (network === FOOTBALL_NETWORK || network.startsWith(`${FOOTBALL_NETWORK}:`));

/** How a match market settles: the score after 90 minutes, or the match's final result (extra time and penalties included). */
export type FootballBasis = 'NINETY' | 'FULL_TIME';

/** Short tags for each basis, on the create page and market labels. */
export const FOOTBALL_BASIS_TAG: Record<FootballBasis, string> = {
  NINETY: '90 minutes',
  FULL_TIME: 'Full time (incl. ET + pens)',
};

/** The `network` a market on this competition and basis is stored with. */
export function footballNetworkFor(c: FootballCompetition, basis: FootballBasis): string {
  if (basis === 'FULL_TIME') {
    if (!c.fullTimeNetwork) throw new Error(`${c.name} has no full-time markets`);
    return c.fullTimeNetwork;
  }
  return c.network;
}

/**
 * A match market's competition and basis, from its oracle row's network. A row
 * without a football network is from before competitions existed, so a
 * Premier League 90-minute market. Null for a football network we don't offer.
 */
export function footballMarketOf(o: { network?: string | null } | null | undefined): { competition: FootballCompetition; basis: FootballBasis } | null {
  const network = o?.network;
  if (!isFootballNetwork(network)) return { competition: FOOTBALL_COMPETITIONS[0], basis: 'NINETY' };
  for (const c of FOOTBALL_COMPETITIONS) {
    if (c.network === network) return { competition: c, basis: 'NINETY' };
    if (c.fullTimeNetwork && c.fullTimeNetwork === network) return { competition: c, basis: 'FULL_TIME' };
  }
  return null;
}

/** The competition of a match market's oracle row (see footballMarketOf). */
export function footballCompetitionOf(o: { network?: string | null } | null | undefined): FootballCompetition | null {
  return footballMarketOf(o)?.competition ?? null;
}

/** How a match market's oracle row settles (see footballMarketOf). */
export const footballBasisOf = (o: { network?: string | null } | null | undefined): FootballBasis =>
  footballMarketOf(o)?.basis ?? 'NINETY';

/** "Premier League", "Champions League", "La Liga"..., or "Football" for an unknown competition. */
export const footballCompetitionLabel = (o: { network?: string | null } | null | undefined) =>
  footballCompetitionOf(o)?.short ?? 'Football';

/** Stages with no extra time: a match there settles the same on 90 minutes and at full time. */
const NO_EXTRA_TIME_STAGES = new Set(['LEAGUE_STAGE', 'GROUP_STAGE', 'REGULAR_SEASON']);
/** Knockout rounds played over two legs: only the second leg can go to extra time. */
const TWO_LEGGED_STAGES = new Set(['PLAYOFFS', 'LAST_32', 'LAST_16', 'QUARTER_FINALS', 'SEMI_FINALS']);

/**
 * Can this match go to extra time? False for league and group stages, and for
 * the first leg of a two-legged knockout tie (football-data numbers the legs as
 * matchday 1 and 2 within a knockout stage). Anything else, or unknown: true.
 */
export function canGoToExtraTime(f: { stage?: string | null; matchday?: number | null }): boolean {
  if (f.stage && NO_EXTRA_TIME_STAGES.has(f.stage)) return false;
  if (f.stage && TWO_LEGGED_STAGES.has(f.stage) && f.matchday === 1) return false;
  return true;
}
export const FOOTBALL_MARKET_TYPE = 'FOOTBALL_HOME_DRAW_AWAY';
/** Onchain option order — option i resolves for FOOTBALL_OUTCOMES[i]. */
export const FOOTBALL_OUTCOMES = ['HOME', 'DRAW', 'AWAY'] as const;
/** Upcoming matches the create page offers (football-data allows at most 10 days per query). */
export const FOOTBALL_FIXTURE_DAYS = 10;
/** A match must kick off at least this far out to be picked — time to sign and send the create tx. */
export const FOOTBALL_MIN_LEAD_MS = 15 * 60 * 1000;
/** Trading closes this long after kickoff: 90 minutes plus half-time, just before full time. */
export const FOOTBALL_CLOSE_AFTER_KICKOFF_MS = 105 * 60 * 1000;
/** A match market's onchain deadline (when trading closes) → the match's kickoff. */
export const footballKickoffMs = (deadline: Date | number | string) => new Date(deadline).getTime() - FOOTBALL_CLOSE_AFTER_KICKOFF_MS;
/** When trading closes for a match kicking off at `utcDate`, in ms. */
export const footballCloseMs = (utcDate: string) => Date.parse(utcDate) + FOOTBALL_CLOSE_AFTER_KICKOFF_MS;
/** The resolver doesn't look before this long after kickoff: no match is over sooner. */
export const FOOTBALL_FIRST_CHECK_MS = 110 * 60 * 1000;
/** No final result this long after kickoff → a human decides. */
export const FOOTBALL_MANUAL_AFTER_MS = 6 * 60 * 60 * 1000;

export const isFootballSlug = (slug: unknown): slug is string =>
  typeof slug === 'string' && /^fd:\d+$/.test(slug);
export const footballMatchId = (slug: string) => slug.slice(FOOTBALL_PREFIX.length);
export const isFootballMarket = (o: { marketType?: string | null } | null | undefined) =>
  !!o && o.marketType === FOOTBALL_MARKET_TYPE;

type Team = { name?: string; shortName?: string; tla?: string; crest?: string };

/** The parts of football-data's Match resource we use. */
export type FootballMatch = {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number | null;
  stage?: string | null;
  competition?: { code?: string; name?: string; emblem?: string };
  homeTeam: Team;
  awayTeam: Team;
  score?: {
    winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
    duration?: string;
    fullTime?: { home: number | null; away: number | null };
    /** Only when the match went past 90 minutes: the score after 90 minutes plus stoppage time. */
    regularTime?: { home: number | null; away: number | null };
    extraTime?: { home: number | null; away: number | null };
    penalties?: { home: number | null; away: number | null };
  };
};

/** A fixture as the create page shows it. */
export type Fixture = {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  /** football-data competition code (PL, CL, ...). */
  competition: string;
  /** LEAGUE_STAGE, LAST_16, FINAL, ... (REGULAR_SEASON for league matches). */
  stage: string | null;
  home: { name: string; crest: string | null };
  away: { name: string; crest: string | null };
};

const teamName = (t: Team) => t.shortName || t.name || t.tla || 'TBD';

export function toFixture(m: FootballMatch, competition = m.competition?.code ?? 'PL'): Fixture {
  return {
    id: m.id,
    utcDate: m.utcDate,
    status: m.status,
    matchday: m.matchday ?? null,
    competition,
    stage: m.stage ?? null,
    home: { name: teamName(m.homeTeam), crest: m.homeTeam.crest || null },
    away: { name: teamName(m.awayTeam), crest: m.awayTeam.crest || null },
  };
}

const STAGE_LABELS: Record<string, string> = {
  LEAGUE_STAGE: 'League phase',
  GROUP_STAGE: 'Group stage',
  PLAYOFFS: 'Knockout play-offs',
  LAST_32: 'Round of 32',
  LAST_16: 'Round of 16',
  QUARTER_FINALS: 'Quarter-finals',
  SEMI_FINALS: 'Semi-finals',
  FINAL: 'Final',
};

/** "Matchday 7", "League phase · Matchday 3", "Round of 16"... */
export function fixtureRound(f: Pick<Fixture, 'stage' | 'matchday'>): string {
  const stage = f.stage && f.stage !== 'REGULAR_SEASON' ? STAGE_LABELS[f.stage] ?? null : null;
  const day = f.matchday ? `Matchday ${f.matchday}` : null;
  if (stage && day && f.stage === 'LEAGUE_STAGE') return `${stage} · ${day}`;
  return stage ?? day ?? '';
}

/**
 * The market question. The Premier League's is unchanged; the other leagues name
 * the league ("La Liga: Who wins Real Madrid vs Barcelona?"), knockout
 * competitions say "in 90 minutes", and full-time markets "extra time and
 * penalties included".
 */
export function footballQuestion(c: FootballCompetition, home: string, away: string, basis: FootballBasis = 'NINETY'): string {
  if (basis === 'FULL_TIME') return `${c.short}: Who wins ${home} vs ${away}, extra time and penalties included?`;
  if (c.knockouts) return `${c.short}: Who wins ${home} vs ${away} in 90 minutes?`;
  return c.network === FOOTBALL_NETWORK ? `Who wins: ${home} vs ${away}?` : `${c.short}: Who wins ${home} vs ${away}?`;
}

/** The rules written onchain. `kickoff` is the formatted kickoff time. The Premier League's text is unchanged. */
export function footballRulesText(c: FootballCompetition, home: string, away: string, kickoff: string, basis: FootballBasis = 'NINETY'): string {
  const after = 'Trading stays open during the match and closes 105 minutes after kickoff. If the match is postponed, cancelled or abandoned, it will be resolved manually.';
  if (basis === 'FULL_TIME') {
    return `This market will resolve to ${home} if they win, Draw if the match ends level with no extra time played, or ${away} if they win, by the final result of the ${c.name} match kicking off ${kickoff}, according to football-data.org. Extra time and penalty shootouts count: if there is a penalty shootout, its winner wins, even if the other team won the match itself (as can happen in a second leg); otherwise, if the match goes to extra time, the team ahead at the end of extra time wins. Draw wins only if the match ends level without extra time, as in a league-phase match or a first leg. Trading stays open during the match and closes 105 minutes after kickoff, before any extra time. If the match is postponed, cancelled or abandoned, it will be resolved manually.`;
  }
  if (!c.knockouts) {
    return `This market will resolve to ${home} if they win, Draw if the match is drawn, or ${away} if they win, by the full-time score (90 minutes plus stoppage time) of the ${c.name} match kicking off ${kickoff}, according to football-data.org. ${after}`;
  }
  return `This market will resolve to ${home} if they are ahead, Draw if the score is level, or ${away} if they are ahead, after 90 minutes plus stoppage time of the ${c.name} match kicking off ${kickoff}, according to football-data.org. Extra time and penalty shootouts do not count: a match that is level after 90 minutes resolves to Draw, even if a team then wins it in extra time or on penalties, or goes through in the tie. ${after}`;
}

/**
 * `available` is football-data's X-Requests-Available-Minute: what's left of the
 * key's 10 requests a minute after this one, or null if it didn't say.
 */
export type FootballFetch<T> =
  | { ok: true; data: T; available: number | null }
  | { ok: false; status: number; error: string; available?: number | null };

/** GET a football-data.org v4 path with our key. Never throws. */
export async function footballFetch<T>(path: string, init?: RequestInit): Promise<FootballFetch<T>> {
  const key = process.env.FOOTBALL_DATA_API_KEY;
  if (!key) return { ok: false, status: 503, error: 'FOOTBALL_DATA_API_KEY not set' };
  try {
    const res = await fetch(`${FOOTBALL_DATA_API}${path}`, {
      ...init,
      headers: { 'X-Auth-Token': key, Accept: 'application/json', ...(init?.headers ?? {}) },
    });
    const left = Number(res.headers.get('x-requests-available-minute'));
    const available = res.headers.has('x-requests-available-minute') && Number.isFinite(left) ? left : null;
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return { ok: false, status: res.status, error: body?.message || `football-data.org returned ${res.status}`, available };
    }
    return { ok: true, data: (await res.json()) as T, available };
  } catch {
    return { ok: false, status: 502, error: 'Could not reach football-data.org' };
  }
}

export type FootballDecision =
  | { kind: 'resolve'; index: number; note: string }
  | { kind: 'wait'; note: string }
  | { kind: 'manual'; reason: string };

/**
 * The score after 90 minutes plus stoppage time (what every match market
 * resolves on), or why there isn't a usable one. A match that went to extra
 * time or penalties (only allowed in knockout competitions) uses football-data's
 * regularTime, and the parts must add up to its fullTime: regular time plus
 * extra time, plus the shootout for PENALTY_SHOOTOUT.
 */
export function ninetyMinuteScore(
  match: FootballMatch,
  competition: FootballCompetition,
): { ok: true; home: number; away: number; duration: string } | { ok: false; reason: string } {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const s = match.score ?? {};
  const duration = s.duration || 'REGULAR';
  const ft = s.fullTime;
  if (!ft || !num(ft.home) || !num(ft.away)) {
    return { ok: false, reason: `match ${match.id} is FINISHED without a full-time score` };
  }
  if (duration === 'REGULAR') return { ok: true, home: ft.home, away: ft.away, duration };
  if (!competition.knockouts || (duration !== 'EXTRA_TIME' && duration !== 'PENALTY_SHOOTOUT')) {
    return { ok: false, reason: `match ${match.id} went to ${duration}` };
  }
  const rt = s.regularTime;
  const et = s.extraTime;
  const pens = s.penalties;
  if (!rt || !num(rt.home) || !num(rt.away)) {
    return { ok: false, reason: `match ${match.id} went to ${duration} without a 90-minute score` };
  }
  if (!et || !num(et.home) || !num(et.away)) {
    return { ok: false, reason: `match ${match.id} went to ${duration} without an extra-time score` };
  }
  const shootout = duration === 'PENALTY_SHOOTOUT';
  const pensHome = shootout ? pens?.home : 0;
  const pensAway = shootout ? pens?.away : 0;
  if (!num(pensHome) || !num(pensAway)) {
    return { ok: false, reason: `match ${match.id} went to penalties without a shootout score` };
  }
  if (rt.home + et.home + pensHome !== ft.home || rt.away + et.away + pensAway !== ft.away) {
    return {
      ok: false,
      reason: `match ${match.id} scores don't add up (90 minutes ${rt.home}-${rt.away}, extra time ${et.home}-${et.away}${shootout ? `, penalties ${pensHome}-${pensAway}` : ''}, full time ${ft.home}-${ft.away})`,
    };
  }
  return { ok: true, home: rt.home, away: rt.away, duration };
}

/**
 * A FINISHED match's final result (full-time markets): Home / Draw / Away with
 * extra time counted and the shootout's winner winning, or why it can't be
 * trusted. football-data's figures are cross-checked against each other:
 *  - REGULAR: the full-time score, which `winner` must agree with.
 *  - EXTRA_TIME: regular time + extra time must add up to the full-time score,
 *    which can't be level (it would have gone to penalties), and `winner` must agree.
 *  - PENALTY_SHOOTOUT: football-data's fullTime adds the shootout goals in, so
 *    regular time + extra time + penalties must add up to it; the shootout can't
 *    be level; `winner` must be its winner. The shootout winner wins even if the
 *    other team won the match itself: in a second leg the shootout settles a tie
 *    that's level on aggregate (Atleti 1-0 Real Madrid, Real Madrid won on penalties).
 * `winner` must be present in every case.
 */
export function finalResult(
  match: FootballMatch,
  competition: FootballCompetition,
): { ok: true; index: number; duration: string; home: number; away: number; penalties: { home: number; away: number } | null } | { ok: false; reason: string } {
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const s = match.score ?? {};
  const duration = s.duration || 'REGULAR';
  const ft = s.fullTime;
  const winnerIndex = s.winner === 'HOME_TEAM' ? 0 : s.winner === 'DRAW' ? 1 : s.winner === 'AWAY_TEAM' ? 2 : -1;
  if (!ft || !num(ft.home) || !num(ft.away)) {
    return { ok: false, reason: `match ${match.id} is FINISHED without a full-time score` };
  }
  if (winnerIndex < 0) return { ok: false, reason: `match ${match.id} is FINISHED without a winner` };
  const agree = (index: number, what: string) =>
    index === winnerIndex ? null : `match ${match.id} ${what} disagrees with winner ${s.winner}`;

  if (duration === 'REGULAR') {
    const index = ft.home > ft.away ? 0 : ft.home === ft.away ? 1 : 2;
    const bad = agree(index, `score ${ft.home}-${ft.away}`);
    return bad ? { ok: false, reason: bad } : { ok: true, index, duration, home: ft.home, away: ft.away, penalties: null };
  }
  if (!competition.knockouts || (duration !== 'EXTRA_TIME' && duration !== 'PENALTY_SHOOTOUT')) {
    return { ok: false, reason: `match ${match.id} went to ${duration}` };
  }
  const rt = s.regularTime;
  const et = s.extraTime;
  if (!rt || !num(rt.home) || !num(rt.away) || !et || !num(et.home) || !num(et.away)) {
    return { ok: false, reason: `match ${match.id} went to ${duration} without regular-time and extra-time scores` };
  }
  const afterEt = { home: rt.home + et.home, away: rt.away + et.away };

  if (duration === 'EXTRA_TIME') {
    if (afterEt.home !== ft.home || afterEt.away !== ft.away) {
      return { ok: false, reason: `match ${match.id} scores don't add up (90 minutes ${rt.home}-${rt.away}, extra time ${et.home}-${et.away}, full time ${ft.home}-${ft.away})` };
    }
    if (ft.home === ft.away) return { ok: false, reason: `match ${match.id} ended level after extra time without a shootout` };
    const index = ft.home > ft.away ? 0 : 2;
    const bad = agree(index, `score after extra time ${ft.home}-${ft.away}`);
    return bad ? { ok: false, reason: bad } : { ok: true, index, duration, home: ft.home, away: ft.away, penalties: null };
  }

  const pens = s.penalties;
  if (!pens || !num(pens.home) || !num(pens.away)) {
    return { ok: false, reason: `match ${match.id} went to penalties without a shootout score` };
  }
  if (afterEt.home + pens.home !== ft.home || afterEt.away + pens.away !== ft.away) {
    return { ok: false, reason: `match ${match.id} scores don't add up (after extra time ${afterEt.home}-${afterEt.away}, penalties ${pens.home}-${pens.away}, full time ${ft.home}-${ft.away})` };
  }
  if (pens.home === pens.away) return { ok: false, reason: `match ${match.id} shootout is level (${pens.home}-${pens.away})` };
  const index = pens.home > pens.away ? 0 : 2;
  const bad = agree(index, `shootout ${pens.home}-${pens.away}`);
  return bad ? { ok: false, reason: bad } : { ok: true, index, duration, home: afterEt.home, away: afterEt.away, penalties: { home: pens.home, away: pens.away } };
}

/**
 * What the resolver should do with a match market, from the match as
 * football-data reports it. Only a FINISHED match in the market's competition
 * with a usable 90-minute score (NINETY) or final result (FULL_TIME) resolves;
 * anything unusual goes to a human.
 */
export function footballDecision(
  match: FootballMatch,
  kickoffMs: number,
  competition: FootballCompetition,
  basis: FootballBasis = 'NINETY',
  nowMs = Date.now(),
): FootballDecision {
  if (match.competition?.code && match.competition.code !== competition.code) {
    return { kind: 'manual', reason: `match ${match.id} is not a ${competition.name} match (${match.competition.code})` };
  }
  // Trading closed 105 minutes after the kickoff we were given. If the match
  // started earlier, people could trade after it was over.
  const startedMs = Date.parse(match.utcDate);
  if (Number.isFinite(startedMs) && startedMs < kickoffMs - 5 * 60 * 1000) {
    return { kind: 'manual', reason: `match ${match.id} was moved earlier (${match.utcDate}) than the market's deadline` };
  }

  if (match.status === 'FINISHED' && basis === 'FULL_TIME') {
    if (!competition.fullTimeNetwork) return { kind: 'manual', reason: `${competition.name} has no full-time markets` };
    const result = finalResult(match, competition);
    if (!result.ok) return { kind: 'manual', reason: result.reason };
    const home = teamName(match.homeTeam);
    const away = teamName(match.awayTeam);
    const note = result.duration === 'PENALTY_SHOOTOUT'
      ? ` (${home} ${result.home}-${result.away} ${away} after extra time, ${result.index === 0 ? home : away} won the shootout ${Math.max(result.penalties!.home, result.penalties!.away)}-${Math.min(result.penalties!.home, result.penalties!.away)}; final result)`
      : result.duration === 'EXTRA_TIME'
        ? ` (${home} ${result.home}-${result.away} ${away} after extra time; final result)`
        : ` (full time ${home} ${result.home}-${result.away} ${away}; final result)`;
    return { kind: 'resolve', index: result.index, note };
  }

  if (match.status === 'FINISHED') {
    const score = ninetyMinuteScore(match, competition);
    if (!score.ok) return { kind: 'manual', reason: score.reason };
    const { home, away } = score;
    const index = home > away ? 0 : home === away ? 1 : 2;
    // football-data's winner counts extra time and penalties, so it only has to
    // agree with the score when the match ended after 90 minutes.
    const winner = match.score?.winner;
    const expected = ['HOME_TEAM', 'DRAW', 'AWAY_TEAM'][index];
    if (score.duration === 'REGULAR' && winner && winner !== expected) {
      return { kind: 'manual', reason: `match ${match.id} score ${home}-${away} disagrees with winner ${winner}` };
    }
    const line = `${teamName(match.homeTeam)} ${home}-${away} ${teamName(match.awayTeam)}`;
    const note = score.duration === 'REGULAR'
      ? ` (full time ${line})`
      : ` (${line} after 90 minutes; ${score.duration === 'EXTRA_TIME' ? 'extra time' : 'extra time and penalties'} not counted)`;
    return { kind: 'resolve', index, note };
  }

  if (['POSTPONED', 'CANCELLED', 'SUSPENDED', 'AWARDED'].includes(match.status)) {
    return { kind: 'manual', reason: `match ${match.id} is ${match.status}` };
  }
  if (nowMs > kickoffMs + FOOTBALL_MANUAL_AFTER_MS) {
    return { kind: 'manual', reason: `match ${match.id} has no result 6h after kickoff (status ${match.status})` };
  }
  return { kind: 'wait', note: `match ${match.id} is ${match.status}` };
}
