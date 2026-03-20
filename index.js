'use strict';
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { ethers } = require('ethers');

// ===== 設定 =====
const USE_TESTNET = process.env.USE_TESTNET === 'true';
const PORT        = parseInt(process.env.PORT || '3001', 10);
const RPC_URL     = process.env.RPC_URL;
const PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:8888';
const RELAY_SECRET   = process.env.RELAY_SECRET   || '';

// トークン定義
const TOKENS = {
    testnet: {
        JPYC: {
            address:  '0x7486c9bae66ff8c227d83113315e8c02d7abe561',
            decimals: 18,
        },
    },
    mainnet: {
        JPYC: {
            address:  '0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB',
            decimals: 18,
        },
        USDC: {
            address:  '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
            decimals: 6,
        },
    },
};

// EIP-3009 ABI（transferWithAuthorization のみ）
const EIP3009_ABI = [
    'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
    'function balanceOf(address account) view returns (uint256)',
    'function nonces(address owner) view returns (uint256)',
];

// ===== 初期化 =====
if (!RPC_URL || !PRIVATE_KEY) {
    console.error('❌ RPC_URL と RELAYER_PRIVATE_KEY を .env に設定してください');
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
const tokens   = USE_TESTNET ? TOKENS.testnet : TOKENS.mainnet;

console.log(`
========================================
  JPYC リレーヤー起動
  ネットワーク : ${USE_TESTNET ? 'Polygon Amoy Testnet' : 'Polygon Mainnet'}
  ポート       : ${PORT}
  許可オリジン : ${ALLOWED_ORIGIN}
  リレーアドレス: ${wallet.address}
========================================
`);

// ===== Express設定 =====
const app = express();
app.use(express.json());
app.use(cors({
    origin: ALLOWED_ORIGIN,
    methods: ['POST', 'GET'],
    allowedHeaders: ['Content-Type', 'X-Relay-Secret'],
}));

// ===== ヘルスチェック =====
app.get('/health', async (req, res) => {
    try {
        const balance = await provider.getBalance(wallet.address);
        const network = await provider.getNetwork();
        res.json({
            status:  'ok',
            network: network.name,
            chainId: network.chainId.toString(),
            relayer: wallet.address,
            polBalance: ethers.formatEther(balance) + ' POL',
            testnet: USE_TESTNET,
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ===== リレー実行エンドポイント =====
app.post('/relay', async (req, res) => {

    // セキュリティ：秘密トークン確認
    if (RELAY_SECRET && req.headers['x-relay-secret'] !== RELAY_SECRET) {
        return res.status(403).json({ success: false, error: '不正なリクエスト' });
    }

    const { token, from, transfer1, transfer2 } = req.body;

    // バリデーション
    if (!token || !from || !transfer1 || !transfer2) {
        return res.status(400).json({ success: false, error: 'パラメータ不足' });
    }
    if (!tokens[token]) {
        return res.status(400).json({ success: false, error: `未対応トークン: ${token}` });
    }

    const tokenInfo = tokens[token];
    const contract  = new ethers.Contract(tokenInfo.address, EIP3009_ABI, wallet);

    console.log(`\n[RELAY] ${token} 送金開始`);
    console.log(`  from: ${from}`);
    console.log(`  to1 (shop): ${transfer1.to} / amount: ${transfer1.amount}`);
    console.log(`  to2 (dev):  ${transfer2.to} / amount: ${transfer2.amount}`);

    try {
        // POL残高確認
        const polBalance = await provider.getBalance(wallet.address);
        if (polBalance < ethers.parseEther('0.01')) {
            console.warn('⚠️  リレーウォレットのPOLが少なくなっています:', ethers.formatEther(polBalance));
        }

        // ===== 送金1：ショップへ =====
        console.log('[1/2] ショップへ transferWithAuthorization...');
        const tx1 = await contract.transferWithAuthorization(
            from,
            transfer1.to,
            BigInt(transfer1.amount),
            0n,                         // validAfter
            BigInt(transfer1.validBefore),
            transfer1.nonce,
            transfer1.v,
            transfer1.r,
            transfer1.s,
            { gasLimit: 120_000 }
        );
        console.log(`  tx1 hash: ${tx1.hash}`);
        const receipt1 = await tx1.wait(1);
        console.log(`  tx1 confirmed: block ${receipt1.blockNumber}`);

        if (receipt1.status !== 1) {
            throw new Error('送金1が失敗しました（revert）');
        }

        // ===== 送金2：開発者へ =====
        console.log('[2/2] 開発者へ transferWithAuthorization...');
        const tx2 = await contract.transferWithAuthorization(
            from,
            transfer2.to,
            BigInt(transfer2.amount),
            0n,
            BigInt(transfer2.validBefore),
            transfer2.nonce,
            transfer2.v,
            transfer2.r,
            transfer2.s,
            { gasLimit: 120_000 }
        );
        console.log(`  tx2 hash: ${tx2.hash}`);
        const receipt2 = await tx2.wait(1);
        console.log(`  tx2 confirmed: block ${receipt2.blockNumber}`);

        if (receipt2.status !== 1) {
            throw new Error('送金2が失敗しました（revert）');
        }

        console.log('[RELAY] ✅ 完了！');
        res.json({
            success: true,
            tx_hash_shop: tx1.hash,
            tx_hash_dev:  tx2.hash,
        });

    } catch (e) {
        console.error('[RELAY] ❌ エラー:', e.message);

        // よくあるエラーを日本語で返す
        let errMsg = e.message;
        if (errMsg.includes('nonce already used') || errMsg.includes('NONCE_USED')) {
            errMsg = '署名のnonceが既に使用されています（二重送信）';
        } else if (errMsg.includes('EXPIRED') || errMsg.includes('expired')) {
            errMsg = '署名の有効期限が切れています';
        } else if (errMsg.includes('insufficient funds')) {
            errMsg = 'リレーウォレットのPOLが不足しています';
        } else if (errMsg.includes('execution reverted')) {
            errMsg = 'トランザクションがrevertされました（残高不足または署名エラー）';
        }

        res.status(500).json({ success: false, error: errMsg });
    }
});

// ===== 起動 =====
app.listen(PORT, () => {
    console.log(`✅ リレーヤー起動中: http://localhost:${PORT}`);
    console.log(`   ヘルスチェック: http://localhost:${PORT}/health`);
});
