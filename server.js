/**
 * server.js
 *
 * Minimal backend for the "Trigger" website. Exposes ONE endpoint:
 *
 *   POST /trade   body: { side: "buy" | "sell", secret: "..." }
 *
 * It authenticates with TopstepX, finds the active MNQ contract, converts
 * your fixed dollar stop/target into ticks using the contract's LIVE tick
 * value, and places a 1-contract market order with a bracket -- no
 * confirmation prompt. This is the same logic as Trading-GOTCHI.py's
 * place_test_order(), just reachable over HTTP instead of a terminal
 * command.
 *
 * ENV VARS (set these in Render's dashboard -- never in code):
 *   TOPSTEPX_USERNAME     your TopstepX username
 *   TOPSTEPX_API_KEY      your TopstepX API key
 *   TOPSTEPX_ACCOUNT_ID   the account to trade on (practice account id)
 *   TRIGGER_SECRET        a password only you and your webpage know
 *   STOP_DOLLARS          default 18
 *   TARGET_DOLLARS        default 22
 *   ALLOWED_ORIGIN        the exact URL of your GitHub Pages site
 *                         (e.g. https://yourusername.github.io)
 *
 * USAGE FROM THE WEBPAGE:
 *   fetch("https://your-render-url.onrender.com/trade", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ side: "buy", secret: "your-trigger-secret" })
 *   })
 *
 * ALSO EXPOSES:
 *   GET /prices   returns recent MNQ price ticks for a simple live chart.
 *   The JWT that can place trades never leaves this server -- the page
 *   only ever receives plain price numbers, nothing that can trade.
 *   The feed connection to TopstepX (same one tick_recorder.py uses) is
 *   started lazily on the first /prices request and stopped automatically
 *   after 2 minutes of no polling, so it doesn't run unattended.
 */

const express = require("express");
const cors = require("cors");
const signalR = require("@microsoft/signalr");

const app = express();
app.use(express.json());

const BASE_URL = "https://api.topstepx.com/api";
const MARKET_HUB_URL = "https://rtc.topstepx.com/hubs/market";
const PRICE_BUFFER_MAX = 300; // keep roughly the last few minutes of ticks
const FEED_IDLE_TIMEOUT_MS = 2 * 60 * 1000; // stop the feed after 2 min of no polling

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

async function authenticate() {
  const resp = await fetch(`${BASE_URL}/Auth/loginKey`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userName: process.env.TOPSTEPX_USERNAME,
      apiKey: process.env.TOPSTEPX_API_KEY,
    }),
  });
  const data = await resp.json();
  if (!data.success) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.token;
}

async function findMnqContract(token) {
  const resp = await fetch(`${BASE_URL}/Contract/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ live: false, searchText: "MNQ" }),
  });
  const data = await resp.json();
  if (!data.success) throw new Error(`Contract search failed: ${JSON.stringify(data)}`);
  const contracts = (data.contracts || []).filter((c) => c.activeContract);
  if (!contracts.length) throw new Error("No active MNQ contract found.");
  return contracts[0]; // has .id, .tickSize, .tickValue
}

async function placeOrder(token, accountId, contractId, side, stopTicks, targetTicks) {
  const order = {
    accountId,
    contractId,
    type: 2, // Market order
    side, // 0 = Buy, 1 = Sell
    size: 1, // ALWAYS 1 contract
    limitPrice: null,
    stopPrice: null,
    trailPrice: null,
    customTag: `trigger-${Date.now()}`,
    stopLossBracket: { ticks: -stopTicks, type: 4 },
    takeProfitBracket: { ticks: targetTicks, type: 1 },
  };
  const resp = await fetch(`${BASE_URL}/Order/place`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(order),
  });
  const data = await resp.json();
  if (!data.success) throw new Error(`Order placement failed: ${JSON.stringify(data)}`);
  return data;
}

app.post("/trade", async (req, res) => {
  try {
    const { side, secret } = req.body || {};

    if (secret !== process.env.TRIGGER_SECRET) {
      return res.status(401).json({ error: "Invalid secret." });
    }
    if (side !== "buy" && side !== "sell") {
      return res.status(400).json({ error: "side must be 'buy' or 'sell'." });
    }

    const accountId = parseInt(process.env.TOPSTEPX_ACCOUNT_ID, 10);
    if (!accountId) {
      return res.status(500).json({ error: "TOPSTEPX_ACCOUNT_ID not set on server." });
    }

    const stopDollars = parseFloat(process.env.STOP_DOLLARS || "18");
    const targetDollars = parseFloat(process.env.TARGET_DOLLARS || "22");

    const token = await authenticate();
    const contract = await findMnqContract(token);

    // Convert dollar risk into ticks using the contract's LIVE tick value,
    // so this stays correct even if the contract multiplier ever changes.
    const stopTicks = Math.round(stopDollars / contract.tickValue);
    const targetTicks = Math.round(targetDollars / contract.tickValue);

    const sideCode = side === "buy" ? 0 : 1;
    const result = await placeOrder(
      token,
      accountId,
      contract.id,
      sideCode,
      stopTicks,
      targetTicks
    );

    console.log(
      `[OK] ${side.toUpperCase()} placed. orderId=${result.orderId} ` +
        `stop=${stopTicks}t ($${stopDollars}) target=${targetTicks}t ($${targetDollars})`
    );

    res.json({
      ok: true,
      side,
      orderId: result.orderId,
      stopTicks,
      targetTicks,
      contract: contract.name,
    });
  } catch (err) {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- live price feed (for the chart) ----------
// Reuses the exact same TopstepX live trade feed tick_recorder.py already
// connects to -- just relayed from the backend instead of saved to a CSV.
// The page only ever gets { t, price } numbers, never the trading token.
let priceBuffer = []; // [{ t: epochMs, price }]
let feedConnection = null;
let feedContractId = null;
let feedIdleTimer = null;

function resetFeedIdleTimer() {
  if (feedIdleTimer) clearTimeout(feedIdleTimer);
  feedIdleTimer = setTimeout(stopFeed, FEED_IDLE_TIMEOUT_MS);
}

async function stopFeed() {
  if (!feedConnection) return;
  try {
    await feedConnection.send("UnsubscribeContractTrades", [feedContractId]);
  } catch (_) {
    /* best-effort -- we're tearing this down anyway */
  }
  try {
    await feedConnection.stop();
  } catch (_) {}
  feedConnection = null;
  console.log("[INFO] Price feed stopped (idle).");
}

async function ensureFeedRunning() {
  if (feedConnection) return; // already connected

  const token = await authenticate();
  const contract = await findMnqContract(token);
  feedContractId = contract.id;

  const hub = new signalR.HubConnectionBuilder()
    .withUrl(`${MARKET_HUB_URL}?access_token=${token}`)
    .withAutomaticReconnect()
    .build();

  hub.on("GatewayTrade", (...args) => {
    try {
      const payload = args[args.length - 1];
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) {
        if (item && typeof item.price === "number") {
          priceBuffer.push({ t: Date.now(), price: item.price });
        }
      }
      if (priceBuffer.length > PRICE_BUFFER_MAX) {
        priceBuffer = priceBuffer.slice(-PRICE_BUFFER_MAX);
      }
    } catch (err) {
      console.error("[WARN] Could not parse trade message:", err.message);
    }
  });

  hub.onclose(() => console.log("[WARN] Price feed connection closed."));

  await hub.start();

  // Give the connection a moment to fully settle before subscribing --
  // subscribing immediately after start() can look successful (the socket
  // reports connected) while the subscription itself silently never
  // registers server-side, so no ticks ever arrive. tick_recorder.py
  // already found this the hard way and waits 2 seconds here too.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  await hub.send("SubscribeContractTrades", [contract.id]);
  feedConnection = hub;
  console.log(`[OK] Price feed connected for ${contract.name}.`);
}

app.get("/prices", async (req, res) => {
  try {
    await ensureFeedRunning();
    resetFeedIdleTimer();
    res.json({ ok: true, prices: priceBuffer });
  } catch (err) {
    console.error("[ERROR] /prices:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Trigger backend listening on port ${PORT}`));
