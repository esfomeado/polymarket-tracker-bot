const WebSocket = require("ws");
const { logToFile } = require("../utils/logger");

class OrderbookWebSocketManager {
  constructor(apiKey, apiSecret, apiPassphrase) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.apiPassphrase = apiPassphrase;
    this.ws = null;
    this.orderbooks = new Map();
    this.subscribedAssets = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.pingInterval = null;
    this.isConnected = false;
  }

  connect() {
    if (this.ws && this.isConnected) {
      return;
    }

    const url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logToFile("INFO", "WebSocket connected to Polymarket orderbook", {});
      this.isConnected = true;
      this.reconnectAttempts = 0;

      this.pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.send("PING");
          } catch (error) {
            logToFile("WARN", "Failed to send PING", { error: error.message });
          }
        }
      }, 10000);

      setTimeout(() => {
        this.resubscribeAll();
      }, 500);
    });

    this.ws.on("message", (data) => {
      try {
        const message = data.toString();
        if (message === "PONG" || message.trim() === "PONG") {
          return;
        }

        const parsed = JSON.parse(message);

        if (
          parsed.asset_id &&
          (parsed.bids !== undefined || parsed.asks !== undefined)
        ) {
          this.orderbooks.set(parsed.asset_id, {
            asks: parsed.asks || [],
            bids: parsed.bids || [],
            timestamp: Date.now(),
          });
        } else if (parsed.type === "error" || parsed.event_type === "error") {
          logToFile("WARN", "WebSocket error message", { error: parsed });
        }
      } catch (error) {
        const message = data.toString();
        if (message !== "PONG" && message.trim() !== "PONG") {
          logToFile("WARN", "Failed to parse websocket message", {
            error: error.message,
            messagePreview: message.substring(0, 100),
          });
        }
      }
    });

    this.ws.on("error", (error) => {
      logToFile("WARN", "WebSocket error", { error: error.message });
    });

    this.ws.on("close", (code, reason) => {
      logToFile("WARN", "WebSocket closed", {
        code,
        reason: reason?.toString(),
        reconnectAttempts: this.reconnectAttempts,
        subscribedAssets: this.subscribedAssets.size,
      });
      this.isConnected = false;
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(
          1000 * Math.pow(2, this.reconnectAttempts),
          30000
        );
        logToFile("INFO", "Reconnecting WebSocket", {
          attempt: this.reconnectAttempts,
          delayMs: delay,
        });
        setTimeout(() => this.connect(), delay);
      } else {
        logToFile("ERROR", "WebSocket max reconnection attempts reached", {
          maxAttempts: this.maxReconnectAttempts,
        });
      }
    });
  }

  subscribe(assetId) {
    if (this.subscribedAssets.has(assetId)) {
      return;
    }

    this.subscribedAssets.add(assetId);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const subscribeMessage = {
          assets_ids: [assetId],
          type: "market",
        };
        this.ws.send(JSON.stringify(subscribeMessage));
      } catch (error) {
        logToFile("WARN", "Failed to send subscription message", {
          assetId,
          error: error.message,
        });
      }
    }
  }

  resubscribeAll() {
    if (
      this.subscribedAssets.size > 0 &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN
    ) {
      const subscribeMessage = {
        assets_ids: Array.from(this.subscribedAssets),
        type: "market",
      };
      this.ws.send(JSON.stringify(subscribeMessage));
    }
  }

  getOrderbook(assetId) {
    return this.orderbooks.get(assetId) || null;
  }

  disconnect() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

module.exports = OrderbookWebSocketManager;
