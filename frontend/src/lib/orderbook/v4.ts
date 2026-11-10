// Uniswap v4 helpers the liquidity code uses: the ModifyLiquidity event, a tick's sqrt price, and a position's packed info.
import { parseAbi } from 'viem';

export const modifyLiquidityEvent = parseAbi(['event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)'])[0];

/** Uniswap's TickMath.getSqrtPriceAtTick, exact. */
const MAX_TICK = 887272;
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  if (abs > BigInt(MAX_TICK)) throw new Error('tick out of range');
  const mul = (r: bigint, m: string) => (r * BigInt(m)) >> BigInt(128);
  let r = (abs & BigInt(1)) !== BigInt(0) ? BigInt('0xfffcb933bd6fad37aa2d162d1a594001') : BigInt('0x100000000000000000000000000000000');
  const steps: [number, string][] = [
    [0x2, '0xfff97272373d413259a46990580e213a'], [0x4, '0xfff2e50f5f656932ef12357cf3c7fdcc'], [0x8, '0xffe5caca7e10e4e61c3624eaa0941cd0'],
    [0x10, '0xffcb9843d60f6159c9db58835c926644'], [0x20, '0xff973b41fa98c081472e6896dfb254c0'], [0x40, '0xff2ea16466c96a3843ec78b326b52861'],
    [0x80, '0xfe5dee046a99a2a811c461f1969c3053'], [0x100, '0xfcbe86c7900a88aedcffc83b479aa3a4'], [0x200, '0xf987a7253ac413176f2b074cf7815e54'],
    [0x400, '0xf3392b0822b70005940c7a398e4b70f3'], [0x800, '0xe7159475a2c29b7443b29c7fa6e889d9'], [0x1000, '0xd097f3bdfd2022b8845ad8f792aa5825'],
    [0x2000, '0xa9f746462d870fdf8a65dc1f90e061e5'], [0x4000, '0x70d869a156d2a1b890bb3df62baf32f7'], [0x8000, '0x31be135f97d08fd981231505542fcfa6'],
    [0x10000, '0x9aa508b5b7a84e1c677de54f3e99bc9'], [0x20000, '0x5d6af8dedb81196699c329225ee604'], [0x40000, '0x2216e584f5fa1ea926041bedfe98'],
    [0x80000, '0x48a170391f7dc42444e8fa2'],
  ];
  for (const [bit, m] of steps) if ((abs & BigInt(bit)) !== BigInt(0)) r = mul(r, m);
  if (tick > 0) r = ((BigInt(1) << BigInt(256)) - BigInt(1)) / r;
  return (r >> BigInt(32)) + ((r & ((BigInt(1) << BigInt(32)) - BigInt(1))) === BigInt(0) ? BigInt(0) : BigInt(1));
}

/** A v4 PositionInfo's tick range. */
export function decodePositionInfo(info: bigint) {
  const int24 = (v: bigint) => {
    const n = Number(v & BigInt(0xffffff));
    return n >= 0x800000 ? n - 0x1000000 : n;
  };
  return { tickLower: int24(info >> BigInt(8)), tickUpper: int24(info >> BigInt(32)) };
}
