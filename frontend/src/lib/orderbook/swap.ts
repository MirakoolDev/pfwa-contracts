// Market orders go through Uniswap's Universal Router: one V4_SWAP command with an exact-input single-pool swap,
// paid through Permit2. The router on Robinhood Chain takes the newer ExactInputSingleParams with minHopPriceX36
// (checked on a fork: the older shape reverts).
import { encodeAbiParameters, encodePacked, type Address } from 'viem';
import type { PoolKey } from './math';

const V4_SWAP = '0x10';
const SWAP_EXACT_IN_SINGLE = 0x06;
const SETTLE_ALL = 0x0c;
const TAKE_ALL = 0x0f;

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export function encodeV4Swap({ key, zeroForOne, amountIn, minOut }: { key: PoolKey; zeroForOne: boolean; amountIn: bigint; minOut: bigint }) {
  const currencyIn: Address = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut: Address = zeroForOne ? key.currency1 : key.currency0;
  const swap = encodeAbiParameters(
    [{
      type: 'tuple',
      components: [
        { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
        { name: 'zeroForOne', type: 'bool' },
        { name: 'amountIn', type: 'uint128' },
        { name: 'amountOutMinimum', type: 'uint128' },
        { name: 'minHopPriceX36', type: 'uint256' },
        { name: 'hookData', type: 'bytes' },
      ],
    }],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: BigInt(0), hookData: '0x' }],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyIn, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyOut, minOut]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
  return { commands: V4_SWAP as `0x${string}`, inputs: [input] };
}
