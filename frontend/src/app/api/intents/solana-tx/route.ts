import { NextRequest, NextResponse } from 'next/server';
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from '@solana-program/token';

export const dynamic = 'force-dynamic';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Pay from any chain, from a Solana wallet: builds the unsigned transfer of SOL or an SPL token (USDC, USDT, ...)
// from the user's wallet to the order's 1Click deposit address. The page hands it to the wallet (Phantom, Solflare,
// Backpack) to sign and send, so the user approves one transaction instead of copying an address. For a token,
// the deposit address's token account is created in the same transaction if it doesn't exist yet.
export async function POST(req: NextRequest) {
  let body: { from?: string; to?: string; mint?: string | null; amount?: string; decimals?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad JSON' }, { status: 400 }); }
  try {
    if (!body.from || !body.to || !body.amount || !/^\d+$/.test(body.amount)) throw new Error('from, to and amount are required');
    const from = address(body.from);
    const to = address(body.to);
    const amount = BigInt(body.amount);
    const signer = createNoopSigner(from);
    const rpc = createSolanaRpc(SOLANA_RPC);

    let instructions: Instruction[];
    if (!body.mint) {
      instructions = [getTransferSolInstruction({ source: signer, destination: to, amount })];
    } else {
      const mint = address(body.mint);
      // The mint's owner is its token program (Token or Token-2022).
      const info = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send();
      if (!info.value) throw new Error('Unknown token on Solana');
      const tokenProgram = info.value.owner;
      const [source] = await findAssociatedTokenPda({ owner: from, mint, tokenProgram });
      const [destination] = await findAssociatedTokenPda({ owner: to, mint, tokenProgram });
      instructions = [
        getCreateAssociatedTokenIdempotentInstruction({ payer: signer, ata: destination, owner: to, mint, tokenProgram }),
        getTransferCheckedInstruction({ source, mint, destination, authority: signer, amount, decimals: Number(body.decimals) }, { programAddress: tokenProgram }),
      ];
    }

    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    return NextResponse.json({ transaction: getBase64EncodedWireTransaction(compileTransaction(message)) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
