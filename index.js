const express = require('express');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Relay-Secret');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// 設定
const JPYC_CONTRACT   = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
const DEV_FEE_PERCENT = 3;

// ABIは最小限（transferWithAuthorization のみ）
const JPYC_ABI = [
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)'
];

// ヘルスチェック
app.get('/health', async (req, res) => {
    try {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const network  = await provider.getNetwork();
        const wallet   = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
        res.json({
            status:  'ok',
            network: network.name,
            relayer: wallet.address
        });
    } catch(e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// リレー処理（1回署名→内部で97/3分配）
app.post('/relay', async (req, res) => {

    // シークレット認証
    const secret = req.headers['x-relay-secret'];
    if (!secret || secret !== process.env.RELAY_SECRET) {
        return res.status(401).json({ success: false, error: '認証エラー' });
    }

    const { from, to, amount, nonce, validBefore, v, r, s } = req.body;

    // バリデーション
    if (!from || !to || !amount || !nonce || !v || !r || !s) {
        return res.status(400).json({ success: false, error: 'パラメータが不足しています' });
    }

    try {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const wallet   = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
        const jpyc     = new ethers.Contract(JPYC_CONTRACT, JPYC_ABI, wallet);

        const totalAmount = BigInt(amount);
        const devAmount   = totalAmount * BigInt(DEV_FEE_PERCENT) / BigInt(100);
        const shopAmount  = totalAmount - devAmount;

        const DEV_ADDRESS  = process.env.DEV_ADDRESS  || '0x46a6caFa8A38DE599b327441D830EAC09FB7fE54';
        const validAfter   = 0;
        const validBeforeN = Number(validBefore);

        console.log(`[RELAY] from: ${from}`);
        console.log(`[RELAY] to(shop): ${to} / amount: ${shopAmount}`);
        console.log(`[RELAY] to(dev):  ${DEV_ADDRESS} / amount: ${devAmount}`);

        // ショップへ送金（署名をそのまま使用）
        const tx1 = await jpyc.transferWithAuthorization(
            from, to, shopAmount,
            validAfter, validBeforeN,
            nonce, v, r, s
        );
        const receipt1 = await tx1.wait();
        console.log(`[RELAY] shop tx: ${receipt1.hash}`);

        // 開発者へ送金（リレーヤーウォレットから直接送金）
        const jpycToken = new ethers.Contract(JPYC_CONTRACT, [
            'function transfer(address to, uint256 amount) returns (bool)'
        ], wallet);

        const tx2 = await jpycToken.transfer(DEV_ADDRESS, devAmount);
        const receipt2 = await tx2.wait();
        console.log(`[RELAY] dev tx: ${receipt2.hash}`);

        res.json({
            success:      true,
            tx_hash_shop: receipt1.hash,
            tx_hash_dev:  receipt2.hash,
            message:      '送金完了'
        });

    } catch(e) {
        console.error('[RELAY ERROR]', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`JPYC Relayer listening on port ${PORT}`);
});
