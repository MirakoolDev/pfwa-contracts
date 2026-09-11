// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PFWAMarkets — Curated market ideas from the FWA Dashboard
/// @notice This file documents the market types PFWA supports beyond weekly checkpoints.
///         These can be created via PFWAMarketFactory.createMarket() or createRelayerMarket().
///
/// ─────────────────────────────────────────────────────────────────────────────
/// BINARY MARKETS (2 options, bonding curve, fixed payout)
/// ─────────────────────────────────────────────────────────────────────────────
///
/// 1. Daily $FWA Distribution Threshold
///    "Will daily $FWA distributed exceed 500M today?"
///    Options: ["Yes", "No"]
///    Data source: Daily $FWA Distributed chart
///    Expiry: end of UTC day
///
/// 2. Weekly Purchase Volume Milestone
///    "Will weekly ETH purchase volume exceed 1,000 ETH?"
///    Options: ["Yes", "No"]
///    Data source: Purchase Volume chart
///
/// 3. Unique Users Growth
///    "Will unique users reach 4,000 this week?"
///    Options: ["Yes", "No"]
///    Data source: No. Unique Users metric (currently 3,474)
///
/// 4. NFT Listing Decision (one per FWA listing, auto-created by relayer)
///    "Listing #[N] — Keep or Remove?"
///    Options: ["Keep", "Remove"]
///    Resolved by: FWA governance relayer
///
/// ─────────────────────────────────────────────────────────────────────────────
/// MULTI-OPTION MARKETS (up to 10 options, bonding curve, fixed payout)
/// ─────────────────────────────────────────────────────────────────────────────
///
/// 5. Weekly Deposit Volume Range (already in PFWA via checkpoint)
///    "What range will weekly deposits land in?"
///    Options: ["<0.5x", "0.5x-0.75x", "0.75x-0.9x", "0.9x-1.1x", "1.1x-1.25x", "1.25x-1.5x", ">=1.5x"]
///    Baseline: previous week's deposits
///
/// 6. Weekly Fee Volume Range (already in PFWA via checkpoint)
///    "What range will weekly fees land in?"
///    Options: same 7 buckets
///
/// 7. Weekly Collection Volume Race (already in PFWA via checkpoint)
///    "Which NFT collection gets the most deposits this week?"
///    Options: up to 10 curated collections + "Others"
///
/// 8. Day of Peak Distribution
///    "Which day this week will have the highest $FWA distributed?"
///    Options: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
///    Data source: Daily $FWA Distributed chart
///
/// 9. $FWA Distribution Mechanism Dominance
///    "Which mechanism distributes the most $FWA this week?"
///    Options: e.g. ["NFT Deposits", "Purchases", "Staking", "Trading Fees", "Other"]
///    Data source: Daily $FWA Distributed by mechanism chart
///
/// 10. Top Recipient Wallet Tier
///     "How much $FWA will the #1 wallet receive this week?"
///     Options: [">100M", "50M-100M", "30M-50M", "20M-30M", "10M-20M", "<10M"]
///     Data source: $FWA Distribution by Wallet table (currently top wallet: 56.32M)
///
/// 11. Platform Revenue Band
///     "Will Platform Revenue exceed [X] ETH this week?"
///     Options: ["<500 ETH", "500-1000 ETH", "1000-2000 ETH", ">2000 ETH"]
///     Data source: Platform Revenue section
///
/// ─────────────────────────────────────────────────────────────────────────────
/// NOTES FOR SMART CONTRACT INTEGRATION
/// ─────────────────────────────────────────────────────────────────────────────
///
/// - Markets 1-4 (binary) should use MarketType.BINARY
/// - Markets 5-11 (multi) should use MarketType.MULTI_OPTION
/// - Markets 5-7 are automatically opened/resolved by the PFWA checkpoint relayer
/// - Markets 1-4, 8-11 are opened by admin via createMarket() with a creation fee
/// - All data sources are publicly available from Dune Analytics (@fookin_no_wan)
/// - The relayer should pull data from the Dune API to resolve markets deterministically
