/**
 * JPYC Relayer Server v2.0.1
 * - 署名値を一切加工しない（value / to / contract すべてそのまま）
 * - 97/3分配なし（まず100%をそのまま通す）
 * - 実行直前にすべてのパラメータをログ出力
 * - v/r/s/nonce の型変換を確実に行う（invalid signature 防止）
 */

const express    = require('express');
const { ethers } = require('ethers');
require('dotenv').config();

const app  = express();
app.use(express.json());

const PORT         = process.env.PORT         || 3001;
const RELAY_SECRET = process.env.RELAY_SECRET || 'jpyc2026secret';
const RELAYER_PK   = process.env.RELAYER_PK;
const RPC_URL      = process.env.RPC_URL      || 'https://polygon-mainnet.g.alchemy.com/v2/74eJ84-8bBLmqnu0EzzfM';

const JPYC_CONTRACT = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';

const JPYC_ABI = [
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external"
];

function authMiddleware(req, res, next) {
    const secret = req.headers['x-relay-secret'];
    if (!secret || secret !== RELAY_SECRET) {
        console.warn('[AUTH] 認証失敗:', secret);
        return res.status(401).json({ success: false, error: '認証エラー' });
    }
    next();
}

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

app.post('/relay', authMiddleware, async (req, res) => {

    const { from, to, amount, value, nonce, validBefore, v, r, s } = req.body;
    const rawValue = amount ?? value;

    if (!from || !to || !rawValue || !nonce || !validBefore || v == null || !r || !s) {
        console.error('[RELAY] パラメータ不足:', req.body);
        return res.status(400).json({ success: false, error: 'パラメータが不足しています' });
    }

    if (!RELAYER_PK) {
        console.error('[RELAY] RELAYER_PK が未設定');
        return res.status(500).json({ success: false, error: 'リレーヤー秘密鍵が未設定です' });
    }

    const safeV           = Number(v);
    const safeValidBefore = Number(validBefore);
    const safeNonce       = nonce.startsWith('0x') ? nonce : '0x' + nonce;
    const safeR           = r.startsWith('0x')     ? r     : '0x' + r;
    const safeS           = s.startsWith('0x')     ? s     : '0x' + s;
    const safeBigValue    = BigInt(rawValue);

    console.log('==========================================================');
    console.log('[RELAY] transferWithAuthorization 実行前パラメータ確認');
    console.log('  contract    :', JPYC_CONTRACT);
    console.log('  from        :', from);
    console.log('  to          :', to);
    console.log('  value(wei)  :', safeBigValue.toString(), '← 加工なし');
    console.log('  validAfter  :', 0);
    console.log('  validBefore :', safeValidBefore);
    console.log('  nonce       :', safeNonce);
    console.log('  v           :', safeV, '(number型)');
    console.log('  r           :', safeR);
    console.log('  s           :', safeS);
    console.log('==========================================================');

    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
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

        if (receipt.status !== 1) {
            throw new Error(`TX失敗 (status=0): ${receipt.hash}`);
        }

        return res.json({
            success:      true,
            tx_hash_shop: receipt.hash,
            tx_hash_dev:  '',
        });

    } catch (err) {
        console.error('[RELAY] エラー:', err.message);

        let errMsg = err.message || '不明なエラー';
        if (/invalid signature/i.test(errMsg))    errMsg = 'invalid signature：署名パラメータ不一致';
        if (/AUTHORIZATION_USED/i.test(errMsg))   errMsg = 'このnonceはすでに使用済みです';
        if (/insufficient funds/i.test(errMsg))   errMsg = 'リレーヤーのMATICが不足しています';
        if (/INSUFFICIENT_BALANCE/i.test(errMsg)) errMsg = 'JPYCの残高が不足しています';

        return res.status(500).json({ success: false, error: errMsg });
    }
});

app.listen(PORT, () => {
    console.log(`[SERVER] JPYC Relayer v2.0.1 起動 port=${PORT}`);
    console.log(`[SERVER] JPYC Contract : ${JPYC_CONTRACT}`);
    console.log(`[SERVER] RPC           : ${RPC_URL}`);
});
