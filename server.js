const hub = new signalR.HubConnectionBuilder()
  .withUrl(MARKET_HUB_URL, {
    skipNegotiation: true,
    transport: signalR.HttpTransportType.WebSockets,
    accessTokenFactory: () => token,
  })
  .withAutomaticReconnect()
  .build();

hub.on("GatewayTrade", (...args) => {
  // unchanged
});

hub.onclose(() => console.log("[WARN] Price feed connection closed."));

await hub.start();

// no longer need the 2-second settle delay -- skipNegotiation makes the
// WebSocket handshake immediate and synchronous, unlike the old
// negotiate flow this delay was compensating for.
try {
  await hub.invoke("SubscribeContractTrades", contract.id);
  console.log(`[OK] Subscribed to trades for ${contract.name}.`);
} catch (err) {
  console.error("[ERROR] Subscribe failed:", err.message);
  throw err;
}

feedConnection = hub;
console.log(`[OK] Price feed connected for ${contract.name}.`);
