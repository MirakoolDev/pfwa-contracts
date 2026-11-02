// NEAR Intents' 1Click API: quotes, deposit submission and status for cross-chain swaps.
// Docs: https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/introduction.md
// A partner key (ONECLICK_API_KEY, from https://partners.near-intents.org) is optional; without one every
// quote carries an extra 0.25% platform fee.

export const ONECLICK_URL = 'https://1click.chaindefuser.com';
/** USDG (Global Dollar) on Robinhood Chain, as NEAR Intents names it. */
export const USDG_ON_HOOD = 'nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near';
export const STATUSES = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'];
/** Statuses after which 1Click does nothing more for a deposit address. */
export const FINAL_STATUSES = ['SUCCESS', 'REFUNDED', 'FAILED'];

export class OneClickError extends Error {
  constructor(status, body) {
    super(`1Click ${status}: ${body?.message ?? JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function createOneClick({ apiKey = process.env.ONECLICK_API_KEY, baseUrl = ONECLICK_URL, fetchImpl = globalThis.fetch } = {}) {
  const headers = { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) };
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!res.ok) throw new OneClickError(res.status, data);
    return data;
  };
  return {
    authenticated: Boolean(apiKey),
    /** Every asset 1Click can route: assetId, symbol, blockchain, decimals, price. */
    tokens: () => call('GET', '/v0/tokens'),
    /** POST /v0/quote. `dry: true` prices it without opening a deposit address. */
    quote: (request) => call('POST', '/v0/quote', request),
    /** Tells 1Click about the deposit transaction so it picks it up sooner. */
    submitDeposit: ({ txHash, depositAddress, memo, nearSenderAccount }) =>
      call('POST', '/v0/deposit/submit', { txHash, depositAddress, ...(memo ? { memo } : {}), ...(nearSenderAccount ? { nearSenderAccount } : {}) }),
    /** GET /v0/status for a deposit address. */
    status: (depositAddress, depositMemo) =>
      call('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}${depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : ''}`),
  };
}

/**
 * The 1Click quote for "pay `amount` of `originAsset` on its chain, deliver USDG on Robinhood Chain to
 * `recipient`". Refunds go back to `refundTo` on the origin chain. `amount` is in the origin asset's base units.
 */
export function buyQuoteRequest({ originAsset, amount, refundTo, recipient, deadline, slippageBps = 100, dry = false, referral }) {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: USDG_ON_HOOD,
    amount: String(amount),
    refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(deadline * 1000).toISOString(),
    ...(referral ? { referral: referral.toLowerCase() } : {}),
  };
}

/** The reverse: pay USDG on Robinhood Chain, deliver `destinationAsset` to `recipient` on its chain. */
export function withdrawQuoteRequest({ destinationAsset, amount, recipient, refundTo, deadline, slippageBps = 100, dry = false, referral }) {
  return {
    dry,
    swapType: 'EXACT_INPUT',
    slippageTolerance: slippageBps,
    originAsset: USDG_ON_HOOD,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset,
    amount: String(amount),
    refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(deadline * 1000).toISOString(),
    ...(referral ? { referral: referral.toLowerCase() } : {}),
  };
}

/** "1.5" with 6 decimals → 1500000n. Rejects more decimals than the asset has. */
export function toBaseUnits(decimal, decimals) {
  const s = String(decimal).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Not an amount: ${decimal}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`${decimal} has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function fromBaseUnits(units, decimals) {
  const n = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}
