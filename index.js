/**
 * JPYC Relayer Server v2.1.2
 * - JPYC_CONTRACT を環境変数化
 * - verifyTypedData で署名者復元チェック
 * - 形式検証・chainId確認・validBefore期限チェック追加
 */

const express    = require('express');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(express.json());

// ============================================================
// 設定・起動時チェック
// ============================================================
const PORT         = process.env.PORT         || 3001;
const RELAY_SECRET = process.env.RELAY_SECRET || 'jpyc2026secret';
const RELAYER_PK   = process.env.RELAYER_PK;
const RPC_URL      = process.env.RPC_URL      || 'https://polygon-mainnet.g.alchemy.com/v2/74eJ84-8bBLmqnu0EzzfM';

// ★ 環境変数から取得（固定値禁止）
const JPYC_CONTRACT = process.env.JPYC_CONTRACT;
if (!JPYC_CONTRACT) throw new Error('[FATAL] JPYC_CONTRACT が未設定です。Render.comの環境変数に設定してください');

// 起動時に必須チェック
if (!RELAYER_PK)   throw new Error('[FATAL] RELAYER_PK が未設定です');
if (!JPYC_CONTRACT) throw new Error('[FATAL] JPYC_CONTRACT が未設定です');

const POLYGON_CHAIN_ID = 137n;

const JPYC_ABI = [
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external"
];

// ============================================================
// 認証ミドルウェア
// ============================================================
function authMiddleware(req, res, next) {
    const secret = req.headers['x-relay-secret'];
    if (!secret || secret !== RELAY_SECRET) {
        console.warn('[AUTH] 認証失敗');
        return res.status(401).json({ success: false, error: '認証エラー' });
    }
    next();
}

// ============================================================
// 形式検証ヘルパー
// ============================================================
function isAddress(v)  { return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v); }
function isBytes32(v)  { return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v); }
function isBytes32Hex(v){ return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v); }

// ============================================================
// GET /health
// ============================================================
app.get('/health', async (req, res) => {
    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const network  = await provider.getNetwork();
        res.json({
            status:   'ok',
            network:  `Polygon (chainId: ${network.chainId})`,
            contract: JPYC_CONTRACT,
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ============================================================
// POST /relay
// ============================================================
app.post('/relay', authMiddleware, async (req, res) => {

    const { from, to, amount, value, nonce, validBefore, v, r, s } = req.body;
    // amount と value の同時指定禁止
    if (amount !== undefined && value !== undefined) {
        return res.status(400).json({ success: false, error: 'amount と value はどちらか一方のみ指定してください' });
    }
    const rawValue = amount !== undefined ? amount : value;

    // ① 形式検証
    const errors = [];
    if (!isAddress(from))   errors.push('from が不正なアドレスです');
    if (!isAddress(to))     errors.push('to が不正なアドレスです');
    if (!rawValue)          errors.push('value/amount が未指定です');
    if (!isBytes32(nonce))  errors.push('nonce が不正です（bytes32必須）');
    if (!isBytes32Hex(r))   errors.push('r が不正です（bytes32必須）');
    if (!isBytes32Hex(s))   errors.push('s が不正です（bytes32必須）');
    if (v == null)          errors.push('v が未指定です');

    if (errors.length > 0) {
        console.error('[RELAY] 形式検証エラー:', errors);
        return res.status(400).json({ success: false, error: errors.join(' / ') });
    }

    // ② 型変換
    const safeV           = Number(v);
    const safeValidBefore = Number(validBefore);
    const safeNonce       = nonce.startsWith('0x') ? nonce : '0x' + nonce;
    const safeR           = r.startsWith('0x') ? r : '0x' + r;
    const safeS           = s.startsWith('0x') ? s : '0x' + s;
    const safeBigValue    = BigInt(rawValue);

    // ③ v の値チェック（27 or 28のみ）
    if (safeV !== 27 && safeV !== 28) {
        console.error('[RELAY] v が不正:', safeV);
        return res.status(400).json({ success: false, error: `v は 27 または 28 である必要があります（受信値: ${safeV}）` });
    }

    // ④ validBefore 期限チェック
    const nowSec = Math.floor(Date.now() / 1000);
    if (safeValidBefore <= nowSec) {
        console.error('[RELAY] 署名期限切れ:', safeValidBefore, '現在:', nowSec);
        return res.status(400).json({ success: false, error: '署名の有効期限が切れています。もう一度お試しください。' });
    }

    // ============================================================
    // ⑤ デバッグログ
    // ============================================================
    console.log('==========================================================');
    console.log('[RELAY] 実行前パラメータ確認');
    console.log('  contract    :', JPYC_CONTRACT);
    console.log('  from        :', from);
    console.log('  to          :', to);
    console.log('  value(wei)  :', safeBigValue.toString(), '← 加工なし');
    console.log('  validAfter  :', 0);
    console.log('  validBefore :', safeValidBefore, '(残り', safeValidBefore - nowSec, '秒)');
    console.log('  nonce       :', safeNonce);
    console.log('  v           :', safeV);
    console.log('  r           :', safeR);
    console.log('  s           :', safeS);
    console.log('==========================================================');

    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);

        // ⑥ chainId確認（Polygon Mainnet=137のみ許可）
        const network = await provider.getNetwork();
        if (network.chainId !== POLYGON_CHAIN_ID) {
            throw new Error(`chainId不一致: 期待=137, 実際=${network.chainId}`);
        }

        // ⑦ verifyTypedData で署名者復元チェック（★最重要）
        const domain = {
            name:              process.env.EIP712_NAME    || 'JPY Coin',
            version:           process.env.EIP712_VERSION || '1',
            chainId:           Number(process.env.CHAIN_ID || 137),
            verifyingContract: JPYC_CONTRACT,
        };
        const types = {
            TransferWithAuthorization: [
                { name: 'from',        type: 'address' },
                { name: 'to',          type: 'address' },
                { name: 'value',       type: 'uint256' },
                { name: 'validAfter',  type: 'uint256' },
                { name: 'validBefore', type: 'uint256' },
                { name: 'nonce',       type: 'bytes32' },
            ],
        };
        const message = {
            from:        from,
            to:          to,
            value:       safeBigValue,
            validAfter:  0n,
            validBefore: BigInt(safeValidBefore),
            nonce:       safeNonce,
        };

        const recoveredAddress = ethers.verifyTypedData(domain, types, message, { v: safeV, r: safeR, s: safeS });
        console.log('[RELAY] 署名復元アドレス:', recoveredAddress);
        console.log('[RELAY] from             :', from);

        if (recoveredAddress.toLowerCase() !== from.toLowerCase()) {
            console.error('[RELAY] ❌ 署名者不一致!');
            console.error('  recovered:', recoveredAddress);
            console.error('  from     :', from);
            return res.status(400).json({
                success: false,
                error: `署名者不一致: recovered=${recoveredAddress} / from=${from}`,
            });
        }
        console.log('[RELAY] ✅ 署名者一致確認OK');

        // ⑧ コントラクト実行
        const wallet   = new ethers.Wallet(RELAYER_PK, provider);
        const contract = new ethers.Contract(JPYC_CONTRACT, JPYC_ABI, wallet);

        const gasEstimate = await contract.transferWithAuthorization.estimateGas(
            from, to, safeBigValue, 0, safeValidBefore, safeNonce, safeV, safeR, safeS
        );
        console.log('[RELAY] ガス見積もり:', gasEstimate.toString());

        const tx = await contract.transferWithAuthorization(
            from, to, safeBigValue, 0, safeValidBefore, safeNonce, safeV, safeR, safeS,
            { gasLimit: gasEstimate * 120n / 100n }
        );
        console.log('[RELAY] TX送信:', tx.hash);

        const receipt = await tx.wait(1);
        console.log('[RELAY] TX確認:', receipt.hash, '/ status:', receipt.status);

        if (receipt.status !== 1) throw new Error(`TX失敗: ${receipt.hash}`);

        return res.json({
            success:      true,
            tx_hash_shop: receipt.hash,
            tx_hash_dev:  '',
        });

    } catch (err) {
        console.error('[RELAY] エラー:', err.message);

        let errMsg = err.message || '不明なエラー';
        if (/invalid signature/i.test(errMsg))     errMsg = 'invalid signature：verifyingContract不一致の可能性。JPYC_CONTRACTを確認してください';
        if (/AUTHORIZATION_USED/i.test(errMsg))    errMsg = 'このnonceはすでに使用済みです';
        if (/insufficient funds/i.test(errMsg))    errMsg = 'リレーヤーのMATICが不足しています';
        if (/INSUFFICIENT_BALANCE/i.test(errMsg))  errMsg = 'JPYCの残高が不足しています';
        if (/chainId不一致/i.test(errMsg))          errMsg = errMsg;

        return res.status(500).json({ success: false, error: errMsg });
    }
});

// ============================================================
// サーバー起動
// ============================================================
app.listen(PORT, () => {
    console.log(`[SERVER] JPYC Relayer v2.1.2 起動 port=${PORT}`);
    console.log(`[SERVER] JPYC Contract : ${JPYC_CONTRACT}`);
    console.log(`[SERVER] RPC           : ${RPC_URL}`);
});
