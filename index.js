import TelegramBot from "node-telegram-bot-api";
import { ethers } from "ethers";
import fetch from "node-fetch";
import http from "http";

// ===== ENV =====
const TG_TOKEN = process.env.TG_TOKEN;
const CHAT_ID = process.env.CHAT_ID; // -1002325097713
const LINEA_HTTP = process.env.LINEA_RPC_HTTP || "https://rpc.linea.build";
const PORT = process.env.PORT || 10000;

// REQUIRED
if (!TG_TOKEN || !CHAT_ID) {
  console.error("❌ Missing TG_TOKEN or CHAT_ID");
  process.exit(1);
}

// ===== HTTP keep-alive for Render =====
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("rusty-buy-bot alive\n");
  })
  .listen(PORT, () => console.log("HTTP health server listening on", PORT));

// ===== CONFIG (RUSTY) =====
const RUSTY = "0x12bbdc004a0e9085ff94df1717336ecbc9f9e5fe";

// trusted router / pool (Rusty main pool)
const KNOWN_SOURCES = new Set([
  "0x179e7c5721672417fe0e4998d9cf6ff68b792eee".toLowerCase()
]);

// Dexscreener API endpoint
const DEX_URL =
  "https://api.dexscreener.com/latest/dex/pairs/linea/0x179e7c5721672417fe0e4998d9cf6ff68b792eee";

// Telegram MEDIA FILE ID
const VIDEO_FILE_ID = "2128373400";

// Rusty total supply
const RUSTY_SUPPLY = 1_000_000_000;

const MC_ICON = "🏦";

// BUY + CHART buttons
const INLINE_KEYBOARD = {
  inline_keyboard: [
    [
      {
        text: "💰 BUY",
        url: "https://linea.build/hub/tokens/swap?toChain=59144&toToken=0x12bbdc004a0e9085ff94df1717336ecbc9f9e5fe"
      }
    ],
    [
      {
        text: "📈 Chart",
        url: "https://dexscreener.com/linea/0x179e7c5721672417fe0e4998d9cf6ff68b792eee"
      }
    ]
  ]
};

const bot = new TelegramBot(TG_TOKEN, { polling: false });
const provider = new ethers.JsonRpcProvider(LINEA_HTTP);

// ===== ERC20 ABI =====
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];
const iface = new ethers.Interface(ERC20_ABI);

// ===== STATE =====
let lastBlock = 0;
const seen = new Set();
const seenTx = new Set();
const recentSends = new Map();
const RECENT_WINDOW_MS = 8_000;
const MAX_SEEN = 300;

// Dex cache
let lastDex = null;
let lastDexTs = 0;
const DEX_TTL_MS = 60_000;

// ===== Dexscreener cached fetch =====
async function getDexInfoCached() {
  const now = Date.now();
  if (lastDex && now - lastDexTs < DEX_TTL_MS) {
    return { ...lastDex, fromCache: true };
  }

  try {
    const res = await fetch(DEX_URL);
    const text = await res.text();

    if (text.trim().startsWith("<")) {
      console.error("dexscreener returned HTML (rate limited)");
      if (lastDex) return { ...lastDex, fromCache: true, rateLimited: true };
      return null;
    }

    const data = JSON.parse(text);
    const pair = data?.pairs?.[0];
    if (!pair) return null;

    const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : null;
    const fdv = typeof pair.fdv === "number" ? pair.fdv : null;

    lastDex = { priceUsd, fdv };
    lastDexTs = now;
    return { priceUsd, fdv, fromCache: false };
  } catch (e) {
    console.error("dexscreener fetch error:", e);
    if (lastDex) return { ...lastDex, fromCache: true, error: true };
    return null;
  }
}

async function fallbackPrice() {
  if (lastDex && lastDex.priceUsd) {
    const mc = lastDex.priceUsd * RUSTY_SUPPLY;
    return { priceUsd: lastDex.priceUsd, mc };
  }
  return { priceUsd: 0, mc: 0 };
}

// ===== Setup =====
async function setup() {
  const currentBlock = await provider.getBlockNumber();
  console.log("Rusty bot started. Current block:", currentBlock);
  lastBlock = currentBlock;

  setInterval(() => {
    pollTransfers().catch((e) => console.error("poll error:", e));
  }, 5000);
}

// ===== Poll Transfers =====
async function pollTransfers() {
  const now = Date.now();

  for (const [k, ts] of recentSends.entries()) {
    if (now - ts > RECENT_WINDOW_MS) recentSends.delete(k);
  }

  const latest = await provider.getBlockNumber();
  if (latest <= lastBlock) return;

  const fromBlock = lastBlock + 1;
  const toBlock = latest;

  console.log("🔍 scanning RUSTY transfers", fromBlock, "→", toBlock);

  const logs = await provider.getLogs({
    address: RUSTY,
    fromBlock,
    toBlock,
    topics: [iface.getEvent("Transfer").topicHash]
  });

  if (logs.length === 0) {
    console.log("…no RUSTY transfers");
  }

  for (const log of logs) {
    const key = `${log.transactionHash}-${log.index}`;
    if (seen.has(key)) continue;
    if (recentSends.has(key)) continue;

    await handleTransferLog(log);

    seen.add(key);
    recentSends.set(key, Date.now());
    if (seen.size > MAX_SEEN) {
      const first = seen.values().next().value;
      seen.delete(first);
    }
  }

  lastBlock = latest;
}

// ===== Handle Transfer =====
async function handleTransferLog(log) {
  const parsed = iface.parseLog(log);
  const { from, to, value } = parsed.args;

  if (value === 0n) return;

  const fromL = from.toLowerCase();

  // only alerts from trusted pair
  if (!KNOWN_SOURCES.has(fromL)) {
    console.log("  skip (unknown source):", from);
    return;
  }

  // avoid double-alerts
  if (seenTx.has(log.transactionHash)) return;
  seenTx.add(log.transactionHash);
  if (seenTx.size > 500) {
    const first = seenTx.values().next().value;
    seenTx.delete(first);
  }

  const rustyAmount = Number(ethers.formatUnits(value, 18));

  // price
  const ds = await getDexInfoCached();
  let usdValue = 0;
  let mcPretty = "--";

  if (ds && ds.priceUsd) {
    usdValue = rustyAmount * ds.priceUsd;

    if (typeof ds.fdv === "number" && ds.fdv > 0) {
      mcPretty =
        ds.fdv >= 1_000_000
          ? `$${(ds.fdv / 1_000_000).toFixed(2)}M`
          : `$${ds.fdv.toLocaleString()}`;
    } else {
      const mc = ds.priceUsd * RUSTY_SUPPLY;
      mcPretty =
        mc >= 1_000_000
          ? `$${(mc / 1_000_000).toFixed(2)}M`
          : `$${mc.toLocaleString()}`;
    }
  } else {
    const fb = await fallbackPrice();
    if (fb.priceUsd > 0) {
      usdValue = rustyAmount * fb.priceUsd;
      mcPretty =
        fb.mc >= 1_000_000
          ? `$${(fb.mc / 1_000_000).toFixed(2)}M (fb)`
          : `$${fb.mc.toLocaleString()} (fb)`;
    }
  }

  // ⚡ EMOJI LOGIC
  let bolts = "⚡";
  if (usdValue > 0) {
    const raw = Math.floor(usdValue);
    const clamped = Math.min(100, Math.max(1, raw));
    bolts = "⚡".repeat(clamped);
  }

  // message text
  const caption = `🟢 RUSTY BUY
👤 ${to}
🪙 ${rustyAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} RUSTY
💵 $${usdValue.toFixed(2)}
${MC_ICON} MC: ${mcPretty}
${bolts}`;

  // ===== SEND TO TOPIC #1 =====
  await bot.sendVideo(CHAT_ID, VIDEO_FILE_ID, {
    caption,
    reply_markup: INLINE_KEYBOARD,
    message_thread_id: 1 // IMPORTANT!
  });

  console.log(
    "✅ alert sent",
    log.transactionHash,
    "amount:",
    rustyAmount,
    "usd:",
    usdValue.toFixed(2),
    "bolts:",
    bolts.length
  );
}

setup().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
