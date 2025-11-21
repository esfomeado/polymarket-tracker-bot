require("dotenv").config();

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const fetch = require("node-fetch");
const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const { Contract } = require("@ethersproject/contracts");
const { Side, OrderType } = require("@polymarket/clob-client");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const DEFAULT_WALLET = "0x0f37cb80dee49d55b5f6d9e595d52591d6371410";

const LOG_FILE = path.join(__dirname, "bot.log");

try {
  if (fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "");
  }
} catch (error) {
  console.error("Failed to clear log file:", error.message);
}

function logToFile(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level,
    message,
    data,
  };
  const logLine = `[${timestamp}] [${level}] ${message}${
    data ? ` | Data: ${JSON.stringify(data)}` : ""
  }\n`;

  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (error) {
    console.error("Failed to write to log file:", error.message);
  }

  if (level === "ERROR") {
    console.error(`[${level}] ${message}`, data || "");
  } else if (level === "WARN") {
    console.warn(`[${level}] ${message}`, data || "");
  } else {
    console.log(`[${level}] ${message}`, data || "");
  }
}

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15000);
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const COMMAND_PREFIX = process.env.COMMAND_PREFIX ?? "!";
const START_COMMAND = `${COMMAND_PREFIX}start`;
const STOP_COMMAND = `${COMMAND_PREFIX}stop`;
const BUY_COMMAND = `${COMMAND_PREFIX}buy`;
const SELL_COMMAND = `${COMMAND_PREFIX}sell`;
const BALANCE_COMMAND = `${COMMAND_PREFIX}balance`;
const PAPER_BALANCE_COMMAND = `${COMMAND_PREFIX}paperbalance`;
const PAPER_RESET_COMMAND = `${COMMAND_PREFIX}paperreset`;
const PAPER_CLOSE_COMMAND = `${COMMAND_PREFIX}paperclose`;
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID;

const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const POLYMARKET_FUNDER = process.env.POLYMARKET_FUNDER;
const POLYMARKET_SIGNATURE_TYPE = Number(
  process.env.POLYMARKET_SIGNATURE_TYPE ?? 1
);
const AUTO_TRADE_ENABLED = process.env.AUTO_TRADE_ENABLED === "true";
const AUTO_TRADE_FILTER = process.env.AUTO_TRADE_FILTER;
const AUTO_TRADE_AMOUNT_USD = Number(process.env.AUTO_TRADE_AMOUNT_USD ?? 1);
const AUTO_TRADE_USE_MARKET = process.env.AUTO_TRADE_USE_MARKET === "true";
const MAX_ORDER_VALUE_USD = Number(process.env.MAX_ORDER_VALUE_USD ?? 10);
const BIG_TRADE_THRESHOLD_USD = Number(
  process.env.BIG_TRADE_THRESHOLD_USD ?? 10
);
const CLOUDFLARE_RETRY_DELAY_MS = Number(
  process.env.CLOUDFLARE_RETRY_DELAY_MS ?? 60000
);
const MAX_CLOUDFLARE_RETRIES = Number(process.env.MAX_CLOUDFLARE_RETRIES ?? 2);
const MAX_POSITIONS = Number(process.env.MAX_POSITIONS ?? 20);
const MAX_TOTAL_EXPOSURE_USD = Number(process.env.MAX_TOTAL_EXPOSURE_USD ?? 0);
const MAX_BET_AMOUNT_PER_MARKET_USD = Number(
  process.env.MAX_BET_AMOUNT_PER_MARKET_USD ?? 0
);
const HIGH_CONFIDENCE_THRESHOLD_USD = Number(
  process.env.HIGH_CONFIDENCE_THRESHOLD_USD ?? 50
);
const LOW_CONFIDENCE_THRESHOLD_USD = Number(
  process.env.LOW_CONFIDENCE_THRESHOLD_USD ?? 10
);
const MIN_TRACKED_TRADE_SIZE_USD = Number(
  process.env.MIN_TRACKED_TRADE_SIZE_USD ?? 0
);
const MIN_TRACKED_CONFIDENCE_LEVEL = Number(
  process.env.MIN_TRACKED_CONFIDENCE_LEVEL ?? 0
);
const PAPER_TRADING_ENABLED = process.env.PAPER_TRADING_ENABLED === "true";
const PAPER_TRADING_INITIAL_BALANCE = Number(
  process.env.PAPER_TRADING_INITIAL_BALANCE ?? 200
);
const POLY_WS_API_KEY = process.env.POLY_WS_API_KEY;
const POLY_WS_API_SECRET = process.env.POLY_WS_API_SECRET;
const POLY_WS_API_PASSPHRASE = process.env.POLY_WS_API_PASSPHRASE;
const SEND_TRADES_ONLY = process.env.SEND_TRADES_ONLY !== "false";

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in environment variables.");
}

if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS < 5000) {
  throw new Error("POLL_INTERVAL_MS must be a number >= 5000.");
}

const POLYGON_RPC = process.env.POLYGON_RPC || "https://polygon-rpc.com";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const CLOB_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";

const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

let clobClient = null;
let clobClientReady = false;
let provider = null;
let signer = null;
let apiCreds = null;
const orderNonce = 0;

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

let orderbookWS = null;
if (POLYMARKET_PRIVATE_KEY) {
  provider = new JsonRpcProvider(POLYGON_RPC);
  signer = new Wallet(POLYMARKET_PRIVATE_KEY, provider);
  (async () => {
    try {
      const host = "https://clob.polymarket.com";
      const chainId = 137;

      const credsPromise = new ClobClient(host, chainId, signer).deriveApiKey();
      const rawCreds = await credsPromise;

      const creds = {
        key: rawCreds.apiKey || rawCreds.key,
        secret: rawCreds.secret,
        passphrase: rawCreds.passphrase,
      };

      apiCreds = creds;

      if (POLYMARKET_FUNDER) {
        clobClient = new ClobClient(
          host,
          chainId,
          signer,
          creds,
          POLYMARKET_SIGNATURE_TYPE,
          POLYMARKET_FUNDER
        );
      } else {
        clobClient = new ClobClient(host, chainId, signer, creds, 0);
      }

      clobClientReady = true;

      logToFile("INFO", "CLOB client initialized successfully", {
        apiKeySet: true,
        hasFunder: !!POLYMARKET_FUNDER,
        initialNonce: orderNonce,
      });

      if (POLY_WS_API_KEY && POLY_WS_API_SECRET && POLY_WS_API_PASSPHRASE) {
        orderbookWS = new OrderbookWebSocketManager(
          POLY_WS_API_KEY,
          POLY_WS_API_SECRET,
          POLY_WS_API_PASSPHRASE
        );
        orderbookWS.connect();
        logToFile("INFO", "WebSocket orderbook manager initialized", {});
      } else {
        logToFile(
          "WARN",
          "WebSocket API credentials not set. Using REST API for orderbook data."
        );
      }
    } catch (error) {
      logToFile("ERROR", "Failed to initialize CLOB client", {
        error: error.message,
        stack: error.stack,
      });
      clobClient = null;
      clobClientReady = false;
    }
  })();
} else {
  logToFile(
    "WARN",
    "POLYMARKET_PRIVATE_KEY not set. Order placement features disabled."
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

let isInitialized = false;
const seenHashes = new Set();
const trackedPositions = new Map();
let isPolling = false;
let pollTimeout = null;
let activeChannel = null;
let currentWallet = DEFAULT_WALLET;

const PAPER_TRADING_STATE_FILE = path.join(
  __dirname,
  "paper-trading-state.json"
);
let paperTradingState = {
  balance: PAPER_TRADING_INITIAL_BALANCE,
  positions: {},
  tradeHistory: [],
  totalPnL: 0,
  realizedPnL: 0,
};

function loadPaperTradingState() {
  try {
    if (fs.existsSync(PAPER_TRADING_STATE_FILE)) {
      const data = fs.readFileSync(PAPER_TRADING_STATE_FILE, "utf8");
      const saved = JSON.parse(data);
      paperTradingState = {
        ...paperTradingState,
        ...saved,
        positions: saved.positions || {},
        tradeHistory: saved.tradeHistory || [],
      };
      logToFile("INFO", "Loaded paper trading state from file", {
        balance: paperTradingState.balance,
        positions: Object.keys(paperTradingState.positions).length,
      });
    }
  } catch (error) {
    logToFile("WARN", "Could not load paper trading state", {
      error: error.message,
    });
  }
}

function savePaperTradingState() {
  try {
    fs.writeFileSync(
      PAPER_TRADING_STATE_FILE,
      JSON.stringify(paperTradingState, null, 2),
      "utf8"
    );
  } catch (error) {
    logToFile("ERROR", "Failed to save paper trading state", {
      error: error.message,
    });
  }
}

loadPaperTradingState();

async function fetchLatestActivity(walletAddress) {
  const apiUrl = `https://data-api.polymarket.com/activity?user=${walletAddress}&limit=25&offset=0`;
  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Polymarket API returned ${response.status} ${response.statusText}`
    );
  }

  const parsed = await response.json();

  if (!Array.isArray(parsed)) {
    throw new Error("Unexpected API response format.");
  }

  return parsed;
}

function scheduleNextPoll() {
  pollTimeout = setTimeout(runPollLoop, POLL_INTERVAL_MS);
}

async function pollOnce() {
  try {
    if (!activeChannel) {
      return;
    }

    const activities = await fetchLatestActivity(currentWallet);

    const trades = SEND_TRADES_ONLY
      ? activities.filter(
          (item) =>
            item?.type === "TRADE" &&
            (String(item?.side).toUpperCase() === "BUY" ||
              String(item?.side).toUpperCase() === "SELL") &&
            item?.transactionHash
        )
      : activities.filter(
          (item) =>
            item?.type === "TRADE" &&
            (String(item?.side).toUpperCase() === "BUY" ||
              String(item?.side).toUpperCase() === "SELL")
        );

    if (!isInitialized) {
      trades.forEach((trade) => {
        seenHashes.add(trade.transactionHash);
      });
      isInitialized = true;
      return;
    }

    const newTrades = trades.filter(
      (trade) => !seenHashes.has(trade.transactionHash)
    );

    if (newTrades.length === 0) {
      return;
    }

    if (!activeChannel?.isTextBased()) {
      console.error("Active channel is missing or not text-based.");
      return;
    }

    for (const trade of newTrades.reverse()) {
      seenHashes.add(trade.transactionHash);

      const {
        title,
        price,
        size,
        usdcSize,
        timestamp,
        transactionHash,
        outcome,
        eventSlug,
        slug,
        side,
        conditionId,
        asset,
        orderType,
        type,
        fillType,
        isMarketOrder,
        marketOrder,
      } = trade;

      const tradeSide = String(side).toUpperCase();
      const priceInCents = price != null ? Math.round(price * 100) : null;
      const formattedPrice = priceInCents != null ? `${priceInCents}¢` : "N/A";
      const discordTimestamp = timestamp != null ? `<t:${timestamp}:f>` : "N/A";

      let detectedOrderType = "UNKNOWN";
      if (orderType) {
        detectedOrderType = String(orderType).toUpperCase();
      } else if (fillType) {
        detectedOrderType = String(fillType).toUpperCase();
      } else if (isMarketOrder !== undefined) {
        detectedOrderType = isMarketOrder ? "MARKET" : "LIMIT";
      } else if (marketOrder !== undefined) {
        detectedOrderType = marketOrder ? "MARKET" : "LIMIT";
      }

      const mention = ALERT_ROLE_ID ? `<@&${ALERT_ROLE_ID}>` : "";
      const orderTypeDisplay =
        detectedOrderType !== "UNKNOWN" ? ` (${detectedOrderType})` : "";
      const embedColor =
        tradeSide === "BUY"
          ? 0x00aa00
          : tradeSide === "SELL"
          ? 0xaa0000
          : 0x808080;

      const embed = {
        title: `New Polymarket ${tradeSide}${orderTypeDisplay}`,
        color: embedColor,
        fields: [
          {
            name: "Market",
            value: title ?? slug ?? "Unknown market",
            inline: false,
          },
          {
            name: "Outcome",
            value: `${outcome ?? "Unknown"} @ ${formattedPrice}`,
            inline: true,
          },
          {
            name: "Size",
            value: `${size ?? "?"} shares (~${usdcSize ?? "?"} USDC)`,
            inline: true,
          },
        ],
        timestamp: timestamp
          ? new Date(timestamp * 1000).toISOString()
          : undefined,
        footer: {
          text: "Polymarket Trade",
        },
      };

      if (transactionHash) {
        embed.fields.push({
          name: "Transaction",
          value: `[View on PolygonScan](https://polygonscan.com/tx/${transactionHash})`,
          inline: false,
        });
      }

      if (eventSlug) {
        embed.fields.push({
          name: "Market Page",
          value: `[View Market](https://polymarket.com/market/${eventSlug})`,
          inline: false,
        });
      }

      try {
        await activeChannel.send({
          content: mention || undefined,
          embeds: [embed],
        });

        logToFile("INFO", "Trade detected", {
          tradeSide,
          market: title || slug,
          outcome,
          price,
          size,
          conditionId,
          transactionHash,
          orderType: detectedOrderType,
          allTradeFields: Object.keys(trade),
        });

        const trackedTradeSize = usdcSize || 0;
        const tradePrice = price || 0;
        const meetsMinTradeSize =
          MIN_TRACKED_TRADE_SIZE_USD === 0 ||
          trackedTradeSize >= MIN_TRACKED_TRADE_SIZE_USD;
        const meetsMinConfidence =
          MIN_TRACKED_CONFIDENCE_LEVEL === 0 ||
          tradePrice >= MIN_TRACKED_CONFIDENCE_LEVEL;

        const canAutoTrade =
          AUTO_TRADE_ENABLED &&
          conditionId &&
          matchesAutoTradeFilter(trade) &&
          meetsMinTradeSize &&
          meetsMinConfidence &&
          (PAPER_TRADING_ENABLED || (clobClient && clobClientReady));

        if (!canAutoTrade && AUTO_TRADE_ENABLED && conditionId) {
          const skipReasons = [];
          if (!matchesAutoTradeFilter(trade)) {
            skipReasons.push("filter mismatch");
          }
          if (!meetsMinTradeSize) {
            skipReasons.push(
              `trade size $${trackedTradeSize.toFixed(
                2
              )} < min $${MIN_TRACKED_TRADE_SIZE_USD}`
            );
          }
          if (!meetsMinConfidence) {
            skipReasons.push(
              `confidence ${(tradePrice * 100).toFixed(1)}% < min ${(
                MIN_TRACKED_CONFIDENCE_LEVEL * 100
              ).toFixed(1)}%`
            );
          }
          if (!PAPER_TRADING_ENABLED && (!clobClient || !clobClientReady)) {
            skipReasons.push("clobClient not ready");
          }
          if (skipReasons.length > 0) {
            logToFile("INFO", "Auto-trade skipped", {
              conditionId,
              market: title || slug,
              reasons: skipReasons,
              tradeSize: trackedTradeSize,
              confidence: tradePrice,
              paperTradingEnabled: PAPER_TRADING_ENABLED,
              clobClientReady: clobClient && clobClientReady,
            });
          }
        }

        if (canAutoTrade) {
          if (!asset) {
            logToFile(
              "WARN",
              "Missing asset tokenId - cannot determine specific outcome token",
              {
                conditionId,
                market: title || slug,
                outcome,
                note: "Falling back to conditionId, but this may cause issues with orderbook lookups",
              }
            );
          }
          const tokenId = asset || conditionId;
          const orderPrice = price;
          const MIN_ORDER_VALUE_USD = 1;

          const trackedShareSize = size || 0;
          let orderSize = 0;
          let orderValue = 0;
          let confidenceLevel = "MEDIUM";

          if (tradeSide === "BUY") {
            if (trackedTradeSize >= HIGH_CONFIDENCE_THRESHOLD_USD) {
              confidenceLevel = "HIGH";
              const maxBetAmount =
                MAX_BET_AMOUNT_PER_MARKET_USD > 0
                  ? MAX_BET_AMOUNT_PER_MARKET_USD
                  : MAX_ORDER_VALUE_USD;
              orderValue = Math.min(trackedTradeSize, maxBetAmount);
              orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;
              logToFile("INFO", "High confidence trade detected", {
                trackedTradeSize,
                confidenceLevel,
                ourBetSize: orderValue,
                maxBetAmount,
              });
            } else if (trackedTradeSize <= LOW_CONFIDENCE_THRESHOLD_USD) {
              confidenceLevel = "LOW";
              orderValue = MIN_ORDER_VALUE_USD;
              orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;
              logToFile("INFO", "Low confidence trade detected", {
                trackedTradeSize,
                confidenceLevel,
                ourBetSize: orderValue,
              });
            } else {
              confidenceLevel = "MEDIUM";
              const maxBetAmount =
                MAX_BET_AMOUNT_PER_MARKET_USD > 0
                  ? MAX_BET_AMOUNT_PER_MARKET_USD
                  : MAX_ORDER_VALUE_USD;
              const scaleFactor =
                (trackedTradeSize - LOW_CONFIDENCE_THRESHOLD_USD) /
                (HIGH_CONFIDENCE_THRESHOLD_USD - LOW_CONFIDENCE_THRESHOLD_USD);
              orderValue = Math.min(
                MIN_ORDER_VALUE_USD +
                  scaleFactor * (maxBetAmount - MIN_ORDER_VALUE_USD),
                maxBetAmount
              );
              orderSize = orderPrice > 0 ? orderValue / orderPrice : 0;
              logToFile("INFO", "Medium confidence trade detected", {
                trackedTradeSize,
                confidenceLevel,
                scaleFactor,
                ourBetSize: orderValue,
              });
            }
          } else if (tradeSide === "SELL") {
            const currentPositionValue = await getPositionValueForToken(
              tokenId
            );
            const currentPositionShares =
              currentPositionValue > 0 && orderPrice > 0
                ? currentPositionValue / orderPrice
                : 0;

            if (currentPositionValue <= 0 || currentPositionShares <= 0) {
              logToFile("WARN", "Cannot auto-sell: No position to sell", {
                tokenId,
                trackedShareSize,
                trackedTradeSize,
              });
              await activeChannel.send({
                embeds: [
                  {
                    title: "⏸️ Auto-trade Skipped",
                    description:
                      "Cannot sell: You don't have a position in this market.",
                    color: 0xffaa00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              continue;
            }

            let trackedSellShares = 0;
            if (trackedShareSize > 0) {
              trackedSellShares = trackedShareSize;
            } else if (trackedTradeSize > 0 && orderPrice > 0) {
              trackedSellShares = trackedTradeSize / orderPrice;
            }

            if (trackedSellShares > 0) {
              const trackedWalletCurrentShares = await getTrackedWalletPosition(
                tokenId,
                currentWallet,
                orderPrice
              );

              const trackedWalletTotalShares =
                trackedWalletCurrentShares + trackedSellShares;

              if (trackedWalletTotalShares > 0) {
                const sellPercentage =
                  trackedSellShares / trackedWalletTotalShares;

                orderSize = currentPositionShares * sellPercentage;
                orderValue = orderSize * orderPrice;

                if (orderValue < MIN_ORDER_VALUE_USD && orderPrice > 0) {
                  orderSize = MIN_ORDER_VALUE_USD / orderPrice;
                  orderValue = MIN_ORDER_VALUE_USD;
                }

                orderSize = Math.min(orderSize, currentPositionShares);
                orderValue = orderSize * orderPrice;

                logToFile(
                  "INFO",
                  "SELL order: Calculating sell percentage from tracked wallet",
                  {
                    trackedWalletCurrentShares,
                    trackedWalletTotalShares,
                    trackedSellShares,
                    sellPercentage: sellPercentage * 100,
                    ourPositionShares: currentPositionShares,
                    ourPositionValue: currentPositionValue,
                    ourSellSize: orderSize,
                    ourSellValue: orderValue,
                    ourSellPercentage:
                      (orderSize / currentPositionShares) * 100,
                  }
                );
              } else {
                logToFile(
                  "WARN",
                  "SELL order: Could not determine tracked wallet total position",
                  {
                    trackedWalletCurrentShares,
                    trackedSellShares,
                    ourPositionShares: currentPositionShares,
                  }
                );
              }
            }

            if (orderSize === 0 && orderValue === 0) {
              if (trackedShareSize > 0) {
                orderSize = Math.min(trackedShareSize, currentPositionShares);
                orderValue = orderSize * orderPrice;
                logToFile(
                  "WARN",
                  "SELL order: Could not fetch tracked wallet position, copying sell size directly",
                  {
                    trackedShareSize,
                    ourPositionShares: currentPositionShares,
                    ourSellSize: orderSize,
                    ourSellValue: orderValue,
                  }
                );
              } else if (trackedTradeSize > 0 && orderPrice > 0) {
                orderSize = Math.min(
                  trackedTradeSize / orderPrice,
                  currentPositionShares
                );
                orderValue = orderSize * orderPrice;
              } else {
                orderValue = MIN_ORDER_VALUE_USD;
                orderSize = Math.min(
                  orderValue / orderPrice,
                  currentPositionShares
                );
                orderValue = orderSize * orderPrice;
              }
            }
          }

          if (
            tokenId &&
            tradeSide === "BUY" &&
            MAX_BET_AMOUNT_PER_MARKET_USD > 0
          ) {
            let currentPositionValue = 0;
            if (PAPER_TRADING_ENABLED) {
              const paperPos = paperTradingState.positions[tokenId];
              if (paperPos) {
                currentPositionValue = paperPos.entryValue || 0;
              }
            } else {
              currentPositionValue = await getPositionValueForToken(tokenId);
            }

            const maxBetAmount = MAX_BET_AMOUNT_PER_MARKET_USD;
            const remainingAmount = Math.max(
              0,
              maxBetAmount - currentPositionValue
            );

            if (remainingAmount === 0) {
              logToFile(
                "INFO",
                "Auto-trade skipped: Position already at max bet amount",
                {
                  conditionId,
                  tokenId,
                  market: title || slug,
                  currentPositionValue,
                  maxBetAmount,
                  orderValue,
                  orderSize,
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⏸️ Auto-trade Skipped",
                    description: `Market "${
                      title || slug
                    }" already at max bet amount per position.`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Current Position",
                        value: `$${currentPositionValue.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Max Bet Amount",
                        value: `$${maxBetAmount.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Proposed Trade",
                        value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                          2
                        )} shares)`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              continue;
            } else if (orderValue > remainingAmount) {
              const originalOrderSize = orderSize;
              const originalOrderValue = orderValue;
              orderSize = orderPrice > 0 ? remainingAmount / orderPrice : 0;
              orderValue = orderSize * orderPrice;
              logToFile(
                "INFO",
                "Auto-trade size capped to avoid exceeding max bet amount per position",
                {
                  conditionId,
                  tokenId,
                  market: title || slug,
                  currentPositionValue,
                  maxBetAmount,
                  originalOrderSize,
                  originalOrderValue,
                  cappedOrderSize: orderSize,
                  cappedOrderValue: orderValue,
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Trade Size Capped",
                    description: `Trade size reduced to avoid exceeding max bet amount per position.`,
                    color: 0xffaa00,
                    fields: [
                      {
                        name: "Current Position",
                        value: `$${currentPositionValue.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Max Bet Amount",
                        value: `$${maxBetAmount.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Original Trade",
                        value: `$${originalOrderValue.toFixed(
                          2
                        )} (${originalOrderSize.toFixed(2)} shares)`,
                        inline: false,
                      },
                      {
                        name: "Capped Trade",
                        value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                          2
                        )} shares)`,
                        inline: false,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
            }
          }

          if (orderValue < MIN_ORDER_VALUE_USD && orderPrice > 0) {
            const originalOrderSize = orderSize;
            orderSize = MIN_ORDER_VALUE_USD / orderPrice;
            orderValue = MIN_ORDER_VALUE_USD;
            logToFile("WARN", "Order value below minimum, increasing to $1", {
              originalOrderSize,
              originalOrderValue: originalOrderSize * orderPrice,
              adjustedOrderSize: orderSize,
              minValue: MIN_ORDER_VALUE_USD,
              orderPrice,
            });
            await activeChannel.send({
              embeds: [
                {
                  title: "⚠️ Order Value Adjusted",
                  description: `Order value was below minimum of $${MIN_ORDER_VALUE_USD}.`,
                  color: 0xffaa00,
                  fields: [
                    {
                      name: "Adjusted Order",
                      value: `$${orderValue.toFixed(2)} (${orderSize.toFixed(
                        2
                      )} shares)`,
                      inline: false,
                    },
                  ],
                  timestamp: new Date().toISOString(),
                },
              ],
            });
          }

          orderSize = Math.round(orderSize * 100) / 100;
          orderValue = orderSize * orderPrice;

          const proposedTradeValue = orderValue;

          const positionCheck = await checkPositionLimits(
            proposedTradeValue,
            tradeSide
          );
          if (!positionCheck.allowed) {
            logToFile("WARN", "Auto-trade skipped: Position limit reached", {
              conditionId,
              market: title || slug,
              reason: positionCheck.reason,
              ...positionCheck,
            });

            const limitEmbed = {
              title: "⏸️ Auto-trade Skipped",
              description: positionCheck.message,
              color: 0xffaa00,
              fields: [],
              timestamp: new Date().toISOString(),
            };

            if (positionCheck.reason === "position_count") {
              limitEmbed.fields.push(
                {
                  name: "Current Positions",
                  value: `${positionCheck.currentPositions}/${positionCheck.maxPositions}`,
                  inline: true,
                },
                {
                  name: "Proposed Trade",
                  value: `$${proposedTradeValue.toFixed(2)}`,
                  inline: true,
                }
              );
            } else if (positionCheck.reason === "total_exposure") {
              limitEmbed.fields.push(
                {
                  name: "Current Exposure",
                  value: `$${positionCheck.currentExposure.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Proposed Trade",
                  value: `$${proposedTradeValue.toFixed(2)}`,
                  inline: true,
                },
                {
                  name: "Would Exceed Limit",
                  value: `$${positionCheck.newTotalExposure.toFixed(
                    2
                  )} > $${positionCheck.maxExposure.toFixed(2)}`,
                  inline: false,
                }
              );
            }

            await activeChannel.send({
              embeds: [limitEmbed],
            });
            continue;
          }

          try {
            if (!price || price <= 0) {
              logToFile("WARN", "Cannot auto-trade: Invalid price", { price });
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Cannot Auto-trade",
                    description: `Invalid price (${price}). Skipping trade.`,
                    color: 0xffaa00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              return;
            }

            if (!tokenId) {
              logToFile(
                "WARN",
                "Cannot auto-trade: No tokenId (asset) in trade",
                {
                  conditionId,
                  asset,
                  tradeFields: Object.keys(trade),
                }
              );
              await activeChannel.send({
                embeds: [
                  {
                    title: "⚠️ Cannot Auto-trade",
                    description:
                      "No token ID found in trade data. Skipping trade.",
                    color: 0xffaa00,
                    timestamp: new Date().toISOString(),
                  },
                ],
              });
              return;
            }

            const useMarketOrder =
              AUTO_TRADE_USE_MARKET || detectedOrderType === "MARKET";

            const dynamicAmount = orderValue;

            if (useMarketOrder) {
              if (tradeSide === "BUY") {
                if (PAPER_TRADING_ENABLED) {
                  logToFile("INFO", "Paper trading: Attempting BUY", {
                    tokenId,
                    dynamicAmount,
                    orderPrice,
                    market: title || slug || "Unknown",
                    orderSize,
                    orderValue,
                  });

                  const paperResult = await paperBuy(
                    tokenId,
                    dynamicAmount,
                    orderPrice,
                    title || slug || "Unknown",
                    conditionId,
                    null,
                    outcome
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    trackedPositions.set(tokenId, {
                      usdcValue: orderValue,
                      timestamp: Date.now(),
                    });
                    const buyEmbed = {
                      title: "✅ Paper Trade: MARKET BUY",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares) @ market price`,
                      color: 0x00aa00,
                      fields: [
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "Confidence",
                          value: confidenceLevel,
                          inline: true,
                        },
                        {
                          name: "Tracked Trade",
                          value: `$${trackedTradeSize.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      buyEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${
                          positionCheck.currentPositions + 1
                        }/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [buyEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "BUY",
                      orderValue: dynamicAmount,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeMarketBuyOrder(
                  tokenId,
                  dynamicAmount,
                  orderPrice
                );

                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-trade FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Action Required",
                              value: `1. Fund your wallet with USDC on Polygon (at least $${orderValue.toFixed(
                                2
                              )})\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`,
                              inline: false,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  } else if (
                    errorMsg.includes("orderbook") &&
                    errorMsg.includes("does not exist")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "⚠️ Auto-trade SKIPPED",
                          description:
                            "Orderbook does not exist for this market. The market may be closed, expired, or inactive.",
                          color: 0xffaa00,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed MARKET BUY Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  trackedPositions.set(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const buyEmbed = {
                    title: "✅ Auto-placed MARKET BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price`,
                    color: 0x00aa00,
                    fields: [
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    buyEmbed.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      buyEmbed.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [buyEmbed],
                  });
                } else {
                  trackedPositions.set(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const buyEmbedNoStatus = {
                    title: "✅ Auto-placed MARKET BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price`,
                    color: 0x00aa00,
                    fields: [
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    buyEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      buyEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [buyEmbedNoStatus],
                  });
                }
              } else if (tradeSide === "SELL") {
                if (PAPER_TRADING_ENABLED) {
                  const paperResult = await paperSell(
                    tokenId,
                    orderSize,
                    orderPrice,
                    title || slug || "Unknown"
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    trackedPositions.delete(tokenId);
                    const sellEmbed = {
                      title: "✅ Paper Trade: MARKET SELL",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares) @ market price`,
                      color: 0xaa0000,
                      fields: [
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "PnL",
                          value: `$${
                            paperResult.pnl >= 0 ? "+" : ""
                          }${paperResult.pnl.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      const positionsAfter = Math.max(
                        0,
                        positionCheck.currentPositions - 1
                      );
                      sellEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${positionsAfter}/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [sellEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "SELL",
                      orderSize,
                      orderValue,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeMarketSellOrder(
                  tokenId,
                  orderSize,
                  orderPrice
                );

                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-trade SELL FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Note",
                              value:
                                "For SELL orders, you need to own the shares (tokens) you're trying to sell.\n\nYou don't have enough shares of this token to place a SELL order. Auto-trading SELL orders is skipped when you don't own the shares.",
                              inline: false,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    logToFile(
                      "WARN",
                      "Skipping SELL auto-trade - user doesn't own enough shares",
                      {
                        tokenId,
                        orderSize,
                        orderPrice,
                        error: errorMsg,
                      }
                    );
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed MARKET SELL Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  trackedPositions.delete(tokenId);
                  const sellEmbed = {
                    title: "✅ Auto-placed MARKET SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price`,
                    color: 0xaa0000,
                    fields: [
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    sellEmbed.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      sellEmbed.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [sellEmbed],
                  });
                } else {
                  trackedPositions.delete(tokenId);
                  const sellEmbedNoStatus = {
                    title: "✅ Auto-placed MARKET SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares) @ market price`,
                    color: 0xaa0000,
                    fields: [],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    sellEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      sellEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [sellEmbedNoStatus],
                  });
                }
              }
            } else {
              const MIN_ORDER_SIZE = 5;

              if (orderSize < MIN_ORDER_SIZE && orderPrice > 0) {
                const originalOrderSize = orderSize;
                const originalOrderValue = orderValue;
                orderSize = MIN_ORDER_SIZE;
                orderValue = orderSize * orderPrice;

                if (
                  tradeSide === "BUY" &&
                  MAX_BET_AMOUNT_PER_MARKET_USD > 0 &&
                  tokenId
                ) {
                  let currentPositionValue = 0;
                  if (PAPER_TRADING_ENABLED) {
                    const paperPos = paperTradingState.positions[tokenId];
                    if (paperPos) {
                      currentPositionValue = paperPos.entryValue || 0;
                    }
                  } else {
                    currentPositionValue = await getPositionValueForToken(
                      tokenId
                    );
                  }

                  const maxBetAmount = MAX_BET_AMOUNT_PER_MARKET_USD;
                  const remainingAmount = Math.max(
                    0,
                    maxBetAmount - currentPositionValue
                  );

                  if (orderValue > remainingAmount && remainingAmount > 0) {
                    orderSize =
                      orderPrice > 0
                        ? remainingAmount / orderPrice
                        : MIN_ORDER_SIZE;
                    orderValue = orderSize * orderPrice;
                    if (orderSize < MIN_ORDER_SIZE) {
                      logToFile(
                        "WARN",
                        "Cannot meet minimum 5 shares after max bet cap, skipping",
                        {
                          originalOrderSize,
                          originalOrderValue,
                          remainingAmount,
                          calculatedSize: orderSize,
                          minSize: MIN_ORDER_SIZE,
                        }
                      );
                      await activeChannel.send({
                        embeds: [
                          {
                            title: "⏸️ Auto-trade Skipped",
                            description: `Cannot meet Polymarket's minimum 5 shares after applying max bet per position limit.`,
                            color: 0xffaa00,
                            fields: [
                              {
                                name: "Remaining Amount",
                                value: `$${remainingAmount.toFixed(2)}`,
                                inline: true,
                              },
                              {
                                name: "Min Shares Required",
                                value: `${MIN_ORDER_SIZE} shares`,
                                inline: true,
                              },
                            ],
                            timestamp: new Date().toISOString(),
                          },
                        ],
                      });
                      continue;
                    }
                  } else if (remainingAmount === 0) {
                    continue;
                  }
                }

                logToFile(
                  "WARN",
                  "Order size below Polymarket minimum, increasing to 5 shares",
                  {
                    originalOrderSize,
                    originalOrderValue,
                    adjustedOrderSize: orderSize,
                    adjustedOrderValue: orderValue,
                    minSize: MIN_ORDER_SIZE,
                    orderPrice,
                  }
                );
                await activeChannel.send({
                  embeds: [
                    {
                      title: "⚠️ Order Size Adjusted",
                      description: `Order size below Polymarket's minimum of ${MIN_ORDER_SIZE} shares.`,
                      color: 0xffaa00,
                      fields: [
                        {
                          name: "Original",
                          value: `${originalOrderSize.toFixed(
                            2
                          )} shares ($${originalOrderValue.toFixed(2)})`,
                          inline: false,
                        },
                        {
                          name: "Adjusted",
                          value: `${orderSize.toFixed(
                            2
                          )} shares ($${orderValue.toFixed(2)})`,
                          inline: false,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    },
                  ],
                });
              }

              orderSize = Math.round(orderSize * 100) / 100;
              orderValue = orderSize * orderPrice;

              if (tradeSide === "BUY") {
                if (PAPER_TRADING_ENABLED) {
                  const paperResult = await paperBuy(
                    tokenId,
                    orderValue,
                    orderPrice,
                    title || slug || "Unknown",
                    conditionId,
                    null,
                    outcome
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    trackedPositions.set(tokenId, {
                      usdcValue: orderValue,
                      timestamp: Date.now(),
                    });
                    const limitBuyEmbed = {
                      title: "✅ Paper Trade: LIMIT BUY",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                      color: 0x00aa00,
                      fields: [
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "Confidence",
                          value: confidenceLevel,
                          inline: true,
                        },
                        {
                          name: "Tracked Trade",
                          value: `$${trackedTradeSize.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      limitBuyEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${
                          positionCheck.currentPositions + 1
                        }/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [limitBuyEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "BUY",
                      orderSize,
                      orderValue,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeBuyOrder(
                  tokenId,
                  orderPrice,
                  orderSize
                );
                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send(
                      `❌ Auto-trade FAILED: ${errorMsg}\n\n**Action Required:**\n1. Fund your wallet with USDC on Polygon (at least $${(
                        orderSize * orderPrice
                      ).toFixed(
                        2
                      )})\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`
                    );
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed LIMIT BUY Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  trackedPositions.set(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const limitBuyEmbedWithStatus = {
                    title: "✅ Auto-placed LIMIT BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0x00aa00,
                    fields: [
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    limitBuyEmbedWithStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      limitBuyEmbedWithStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitBuyEmbedWithStatus],
                  });
                } else {
                  trackedPositions.set(tokenId, {
                    usdcValue: orderValue,
                    timestamp: Date.now(),
                  });
                  const limitBuyEmbedNoStatus = {
                    title: "✅ Auto-placed LIMIT BUY Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0x00aa00,
                    fields: [
                      {
                        name: "Confidence",
                        value: confidenceLevel,
                        inline: true,
                      },
                      {
                        name: "Tracked Trade",
                        value: `$${trackedTradeSize.toFixed(2)}`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    limitBuyEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${
                        positionCheck.currentPositions + 1
                      }/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.newTotalExposure) {
                      limitBuyEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${positionCheck.newTotalExposure.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitBuyEmbedNoStatus],
                  });
                }
              } else if (tradeSide === "SELL") {
                if (PAPER_TRADING_ENABLED) {
                  const paperResult = await paperSell(
                    tokenId,
                    orderSize,
                    orderPrice,
                    title || slug || "Unknown"
                  );

                  if (paperResult && paperResult.error) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Paper Trade FAILED",
                          description: paperResult.error,
                          color: 0xaa0000,
                          fields: [
                            {
                              name: "Mode",
                              value: "📝 Paper Trading",
                              inline: true,
                            },
                          ],
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                    continue;
                  }

                  if (paperResult && paperResult.success) {
                    trackedPositions.delete(tokenId);
                    const limitSellEmbed = {
                      title: "✅ Paper Trade: LIMIT SELL",
                      description: `$${orderValue.toFixed(
                        2
                      )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                      color: 0xaa0000,
                      fields: [
                        {
                          name: "Mode",
                          value: "📝 Paper Trading",
                          inline: true,
                        },
                        {
                          name: "PnL",
                          value: `$${
                            paperResult.pnl >= 0 ? "+" : ""
                          }${paperResult.pnl.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Paper Balance",
                          value: `$${paperResult.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    };

                    if (
                      positionCheck.allowed &&
                      positionCheck.currentPositions !== undefined
                    ) {
                      const positionsAfter = Math.max(
                        0,
                        positionCheck.currentPositions - 1
                      );
                      limitSellEmbed.fields.push({
                        name: "Positions After Trade",
                        value: `${positionsAfter}/${MAX_POSITIONS}`,
                        inline: true,
                      });
                    }

                    await activeChannel.send({
                      embeds: [limitSellEmbed],
                    });
                    continue;
                  }
                }

                if (PAPER_TRADING_ENABLED) {
                  logToFile(
                    "ERROR",
                    "Attempted real trade while paper trading is enabled - this should not happen",
                    {
                      tokenId,
                      tradeSide: "SELL",
                      orderSize,
                      orderValue,
                    }
                  );
                  continue;
                }

                const orderResponse = await placeSellOrder(
                  tokenId,
                  orderPrice,
                  orderSize
                );
                if (orderResponse && orderResponse.error) {
                  const errorMsg = orderResponse.error;
                  if (
                    errorMsg.includes("balance") ||
                    errorMsg.includes("allowance")
                  ) {
                    await activeChannel.send(
                      `❌ Auto-trade FAILED: ${errorMsg}\n\n**Action Required:**\n1. Fund your wallet with USDC on Polygon\n2. If using a proxy wallet, approve the CLOB contract to spend USDC`
                    );
                  } else if (
                    errorMsg.includes("orderbook") &&
                    errorMsg.includes("does not exist")
                  ) {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "⚠️ Auto-trade SKIPPED",
                          description:
                            "Orderbook does not exist for this market. The market may be closed, expired, or inactive.",
                          color: 0xffaa00,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  } else {
                    await activeChannel.send({
                      embeds: [
                        {
                          title: "❌ Auto-placed LIMIT SELL Order FAILED",
                          description: errorMsg,
                          color: 0xaa0000,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    });
                  }
                } else if (orderResponse && orderResponse.success !== false) {
                  trackedPositions.delete(tokenId);
                  const limitSellEmbed = {
                    title: "✅ Auto-placed LIMIT SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0xaa0000,
                    fields: [
                      {
                        name: "Status",
                        value: "Success",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    limitSellEmbed.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      limitSellEmbed.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitSellEmbed],
                  });
                } else {
                  trackedPositions.delete(tokenId);
                  const limitSellEmbedNoStatus = {
                    title: "✅ Auto-placed LIMIT SELL Order",
                    description: `$${orderValue.toFixed(
                      2
                    )} (${orderSize.toFixed(2)} shares @ ${orderPrice})`,
                    color: 0xaa0000,
                    fields: [],
                    timestamp: new Date().toISOString(),
                  };

                  if (
                    positionCheck.allowed &&
                    positionCheck.currentPositions !== undefined
                  ) {
                    const positionsAfter = Math.max(
                      0,
                      positionCheck.currentPositions - 1
                    );
                    limitSellEmbedNoStatus.fields.push({
                      name: "Positions After Trade",
                      value: `${positionsAfter}/${MAX_POSITIONS}`,
                      inline: true,
                    });
                    if (positionCheck.currentExposure !== undefined) {
                      const exposureAfter = Math.max(
                        0,
                        positionCheck.currentExposure - orderValue
                      );
                      limitSellEmbedNoStatus.fields.push({
                        name: "Total Exposure",
                        value: `$${exposureAfter.toFixed(2)}${
                          MAX_TOTAL_EXPOSURE_USD > 0
                            ? ` / $${MAX_TOTAL_EXPOSURE_USD.toFixed(2)}`
                            : ""
                        }`,
                        inline: true,
                      });
                    }
                  }

                  await activeChannel.send({
                    embeds: [limitSellEmbedNoStatus],
                  });
                }
              }
            }
          } catch (tradeError) {
            logToFile("ERROR", "Auto-trade error", {
              error: tradeError.message,
              stack: tradeError.stack,
              tradeSide,
              tokenId: conditionId,
              price,
            });
            await activeChannel.send({
              embeds: [
                {
                  title: "⚠️ Auto-trade Failed",
                  description: tradeError.message,
                  color: 0xffaa00,
                  timestamp: new Date().toISOString(),
                },
              ],
            });
          }
        } else {
          const skipReason = !AUTO_TRADE_ENABLED
            ? "AUTO_TRADE_ENABLED is false"
            : !clobClient
            ? "CLOB client not initialized"
            : !clobClientReady
            ? "CLOB client not ready (API credentials not set)"
            : !conditionId
            ? "No conditionId in trade"
            : !matchesAutoTradeFilter(trade)
            ? `Trade does not match filter "${AUTO_TRADE_FILTER}"`
            : "Unknown reason";

          if (
            AUTO_TRADE_ENABLED &&
            clobClient &&
            clobClientReady &&
            conditionId &&
            !matchesAutoTradeFilter(trade)
          ) {
            console.log(
              `Auto-trade skipped: Trade does not match filter "${AUTO_TRADE_FILTER}"`
            );
          }
        }
      } catch (error) {
        console.error("Failed to send message to Discord", error);
      }
    }
  } catch (error) {
    console.error("Polling error:", error.message);
  }
}

async function runPollLoop() {
  await pollOnce();

  if (PAPER_TRADING_ENABLED && isPolling) {
    try {
      await checkAndSettleResolvedMarkets();
    } catch (error) {
      logToFile("ERROR", "Failed to check resolved markets", {
        error: error.message,
      });
    }
  }

  if (isPolling) {
    scheduleNextPoll();
  }
}

async function getCurrentPositions() {
  try {
    if (clobClient && clobClientReady) {
      try {
        if (typeof clobClient.getPositions === "function") {
          const positions = await clobClient.getPositions();
          if (Array.isArray(positions)) {
            logToFile("INFO", "Fetched positions from CLOB API", {
              count: positions.length,
            });
            return positions;
          }
        }
      } catch (error) {
        logToFile("WARN", "Could not fetch positions from CLOB API", {
          error: error.message,
        });
      }

      try {
        const walletAddress =
          POLYMARKET_FUNDER || signer?.address || currentWallet;
        if (walletAddress) {
          const positionsUrl = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
          const response = await fetch(positionsUrl, {
            headers: {
              accept: "application/json",
            },
          });

          if (response.ok) {
            const positions = await response.json();
            if (Array.isArray(positions)) {
              logToFile("INFO", "Fetched positions from Data API", {
                count: positions.length,
              });
              return positions;
            }
          }
        }
      } catch (error) {
        logToFile("WARN", "Could not fetch positions from Data API", {
          error: error.message,
        });
      }
    }

    const positions = [];
    for (const [tokenId, data] of trackedPositions.entries()) {
      positions.push({
        token_id: tokenId,
        usdc_value: data.usdcValue,
        timestamp: data.timestamp,
      });
    }
    logToFile("INFO", "Using tracked positions (fallback)", {
      count: positions.length,
    });
    return positions;
  } catch (error) {
    logToFile("ERROR", "Failed to get current positions", {
      error: error.message,
    });
    return [];
  }
}

async function getPositionValueForToken(tokenId) {
  try {
    const trackedPosition = trackedPositions.get(tokenId);
    if (trackedPosition) {
      return trackedPosition.usdcValue || 0;
    }

    const positions = await getCurrentPositions();
    for (const pos of positions) {
      const posTokenId = pos.token_id || pos.conditionId || pos.tokenID;
      if (posTokenId === tokenId) {
        const value =
          pos.usdc_value || pos.usdcValue || pos.value || pos.cost || 0;
        return typeof value === "number" && value > 0 ? value : 0;
      }
    }

    return 0;
  } catch (error) {
    logToFile("ERROR", "Failed to get position value for token", {
      tokenId,
      error: error.message,
    });
    return 0;
  }
}

async function getTrackedWalletPosition(tokenId, walletAddress, price) {
  try {
    const positionsUrl = `https://data-api.polymarket.com/positions?user=${walletAddress}`;
    const response = await fetch(positionsUrl, {
      headers: {
        accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (response.ok) {
      const positions = await response.json();
      if (Array.isArray(positions)) {
        for (const pos of positions) {
          const posTokenId =
            pos.token_id || pos.conditionId || pos.tokenID || pos.asset;
          if (posTokenId === tokenId) {
            let shares = pos.size || pos.qty || pos.quantity || 0;

            if (!shares || shares === 0) {
              const value =
                pos.usdc_value || pos.usdcValue || pos.value || pos.cost || 0;
              if (value > 0 && price > 0) {
                shares = value / price;
              }
            }

            logToFile("INFO", "Fetched tracked wallet position", {
              tokenId,
              walletAddress,
              shares,
              value: pos.usdc_value || pos.usdcValue || pos.value,
              price,
            });

            return shares;
          }
        }
      }
    }

    logToFile("WARN", "Could not find tracked wallet position", {
      tokenId,
      walletAddress,
      status: response.status,
    });
    return 0;
  } catch (error) {
    logToFile("ERROR", "Failed to get tracked wallet position", {
      tokenId,
      walletAddress,
      error: error.message,
    });
    return 0;
  }
}

async function checkPositionLimits(proposedTradeValue, tradeSide = "BUY") {
  if (PAPER_TRADING_ENABLED) {
    const paperBalance = getPaperTradingBalance();
    const positionCount = paperBalance.totalPositions;
    const totalExposure = paperBalance.totalExposure;

    const newTotalExposure =
      tradeSide === "SELL"
        ? Math.max(0, totalExposure - proposedTradeValue)
        : totalExposure + proposedTradeValue;

    if (tradeSide === "BUY" && positionCount >= MAX_POSITIONS) {
      return {
        allowed: false,
        reason: "position_count",
        currentPositions: positionCount,
        maxPositions: MAX_POSITIONS,
        message: `Maximum position limit reached: ${positionCount}/${MAX_POSITIONS} positions open (Paper Trading).`,
      };
    }

    if (MAX_TOTAL_EXPOSURE_USD > 0) {
      if (tradeSide === "BUY" && newTotalExposure > MAX_TOTAL_EXPOSURE_USD) {
        return {
          allowed: false,
          reason: "total_exposure",
          currentExposure: totalExposure,
          proposedTradeValue,
          newTotalExposure,
          maxExposure: MAX_TOTAL_EXPOSURE_USD,
          message: `Total exposure limit would be exceeded: $${newTotalExposure.toFixed(
            2
          )} > $${MAX_TOTAL_EXPOSURE_USD.toFixed(
            2
          )} (Current: $${totalExposure.toFixed(2)}). Paper Trading.`,
        };
      }
    }

    return {
      allowed: true,
      currentPositions: positionCount,
      currentExposure: totalExposure,
      newTotalExposure,
    };
  }

  const positions = await getCurrentPositions();

  const uniquePositions = new Set();
  let totalExposure = 0;

  for (const pos of positions) {
    const tokenId = pos.token_id || pos.conditionId || pos.tokenID;
    if (tokenId) {
      uniquePositions.add(tokenId);
      const value =
        pos.usdc_value ||
        pos.usdcValue ||
        pos.value ||
        pos.cost ||
        proposedTradeValue;
      if (typeof value === "number" && value > 0) {
        totalExposure += value;
      }
    }
  }

  const positionCount = uniquePositions.size;

  const newTotalExposure =
    tradeSide === "SELL"
      ? Math.max(0, totalExposure - proposedTradeValue)
      : totalExposure + proposedTradeValue;

  if (tradeSide === "BUY" && positionCount >= MAX_POSITIONS) {
    return {
      allowed: false,
      reason: "position_count",
      currentPositions: positionCount,
      maxPositions: MAX_POSITIONS,
      message: `Maximum position limit reached: ${positionCount}/${MAX_POSITIONS} positions open.`,
    };
  }

  if (MAX_TOTAL_EXPOSURE_USD > 0) {
    if (tradeSide === "BUY" && newTotalExposure > MAX_TOTAL_EXPOSURE_USD) {
      return {
        allowed: false,
        reason: "total_exposure",
        currentExposure: totalExposure,
        proposedTradeValue,
        newTotalExposure,
        maxExposure: MAX_TOTAL_EXPOSURE_USD,
        message: `Total exposure limit would be exceeded: $${newTotalExposure.toFixed(
          2
        )} > $${MAX_TOTAL_EXPOSURE_USD.toFixed(
          2
        )} (Current: $${totalExposure.toFixed(2)}).`,
      };
    }
  }

  return {
    allowed: true,
    currentPositions: positionCount,
    currentExposure: totalExposure,
    newTotalExposure,
  };
}

function isValidWalletAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

async function paperBuy(
  tokenId,
  amount,
  price,
  market,
  conditionId = null,
  endDate = null,
  outcome = null
) {
  if (!PAPER_TRADING_ENABLED) {
    return null;
  }

  let cost = amount;

  if (MAX_BET_AMOUNT_PER_MARKET_USD > 0) {
    const existingPos = paperTradingState.positions[tokenId];
    const currentPositionValue = existingPos ? existingPos.entryValue || 0 : 0;
    const maxBetAmount = MAX_BET_AMOUNT_PER_MARKET_USD;
    const remainingAmount = Math.max(0, maxBetAmount - currentPositionValue);

    if (remainingAmount === 0) {
      return {
        error: `Position already at max bet amount of $${maxBetAmount.toFixed(
          2
        )}. Cannot add more.`,
      };
    }

    if (cost > remainingAmount) {
      cost = remainingAmount;
      logToFile("INFO", "Paper trade capped to max bet amount", {
        tokenId,
        originalAmount: amount,
        cappedAmount: cost,
        currentPositionValue,
        maxBetAmount,
        remainingAmount,
      });
    }
  }

  const shares = price > 0 ? cost / price : 0;

  if (paperTradingState.balance < cost) {
    return {
      error: `Insufficient balance: $${cost.toFixed(
        2
      )} required, but only $${paperTradingState.balance.toFixed(
        2
      )} available.`,
    };
  }

  paperTradingState.balance -= cost;

  const pos = paperTradingState.positions[tokenId];
  if (pos) {
    const totalShares = pos.shares + shares;
    const totalCost = pos.entryValue + cost;
    pos.shares = totalShares;
    pos.avgPrice = totalCost / totalShares;
    pos.entryValue = totalCost;
    if (!pos.conditionId && conditionId) {
      pos.conditionId = conditionId;
    }
    if (!pos.endDate && endDate) {
      pos.endDate = endDate;
    }
    if (!pos.outcome && outcome) {
      pos.outcome = outcome;
    }
    pos.lastChecked = Date.now();
  } else {
    paperTradingState.positions[tokenId] = {
      shares,
      avgPrice: price,
      entryValue: cost,
      market: market || "Unknown",
      conditionId: conditionId || null,
      endDate: endDate || null,
      outcome: outcome || null,
      lastChecked: Date.now(),
    };
  }

  paperTradingState.tradeHistory.push({
    timestamp: Date.now(),
    side: "BUY",
    tokenId,
    shares,
    price,
    value: cost,
    market: market || "Unknown",
  });

  if (paperTradingState.tradeHistory.length > 1000) {
    paperTradingState.tradeHistory =
      paperTradingState.tradeHistory.slice(-1000);
  }

  savePaperTradingState();

  logToFile("INFO", "Paper BUY executed", {
    tokenId,
    shares,
    price,
    cost,
    balance: paperTradingState.balance,
  });

  return {
    success: true,
    shares,
    price,
    cost,
    balance: paperTradingState.balance,
  };
}

async function paperSell(tokenId, shares, price, market) {
  if (!PAPER_TRADING_ENABLED) {
    return null;
  }

  const position = paperTradingState.positions[tokenId];
  if (!position || position.shares <= 0) {
    return {
      error: `No position found for token ${tokenId}.`,
    };
  }

  const sharesToSell = Math.min(shares, position.shares);
  const proceeds = sharesToSell * price;

  const avgCost = position.avgPrice;
  const pnl = (price - avgCost) * sharesToSell;
  const realizedPnl = pnl;

  paperTradingState.balance += proceeds;

  position.shares -= sharesToSell;
  position.entryValue -= sharesToSell * avgCost;

  if (position.shares <= 0.001) {
    delete paperTradingState.positions[tokenId];
  }

  paperTradingState.realizedPnL += realizedPnl;

  paperTradingState.tradeHistory.push({
    timestamp: Date.now(),
    side: "SELL",
    tokenId,
    shares: sharesToSell,
    price,
    value: proceeds,
    pnl: realizedPnl,
    market: market || position.market || "Unknown",
  });

  if (paperTradingState.tradeHistory.length > 1000) {
    paperTradingState.tradeHistory =
      paperTradingState.tradeHistory.slice(-1000);
  }

  savePaperTradingState();

  logToFile("INFO", "Paper SELL executed", {
    tokenId,
    shares: sharesToSell,
    price,
    proceeds,
    pnl: realizedPnl,
    balance: paperTradingState.balance,
  });

  return {
    success: true,
    shares: sharesToSell,
    price,
    proceeds,
    pnl: realizedPnl,
    balance: paperTradingState.balance,
  };
}

function getPaperTradingBalance() {
  const totalPositions = Object.keys(paperTradingState.positions).length;
  let totalExposure = 0;
  for (const pos of Object.values(paperTradingState.positions)) {
    totalExposure += pos.entryValue;
  }

  return {
    balance: paperTradingState.balance,
    realizedPnL: paperTradingState.realizedPnL,
    totalPositions,
    totalExposure,
    positions: paperTradingState.positions,
    totalValue: paperTradingState.balance + totalExposure,
  };
}

function resetPaperTrading() {
  paperTradingState = {
    balance: PAPER_TRADING_INITIAL_BALANCE,
    positions: {},
    tradeHistory: [],
    totalPnL: 0,
    realizedPnL: 0,
  };
  savePaperTradingState();
  logToFile("INFO", "Paper trading state reset", {
    newBalance: PAPER_TRADING_INITIAL_BALANCE,
  });
}

async function getTokenIdForOutcome(conditionId, outcome) {
  if (!conditionId || !outcome) {
    return null;
  }

  try {
    const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${conditionId}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(marketUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const markets = await response.json();
      if (Array.isArray(markets) && markets.length > 0) {
        const market = markets[0];

        logToFile("INFO", "Market data retrieved for tokenId lookup", {
          conditionId,
          outcome,
          hasTokens: !!(market.tokens && Array.isArray(market.tokens)),
          hasOutcomes: !!(market.outcomes && Array.isArray(market.outcomes)),
          tokensCount: market.tokens?.length || 0,
          outcomesCount: market.outcomes?.length || 0,
          marketKeys: Object.keys(market),
        });

        if (market.tokens && Array.isArray(market.tokens)) {
          for (const token of market.tokens) {
            const tokenOutcome =
              token.outcome || token.title || token.name || token.label;
            const tokenId = String(
              token.token_id || token.asset_id || token.id || ""
            );

            logToFile("INFO", "Checking token for outcome match", {
              conditionId,
              targetOutcome: outcome,
              tokenOutcome,
              tokenId: tokenId.substring(0, 10) + "...",
              tokenKeys: Object.keys(token),
            });

            if (
              tokenOutcome &&
              tokenOutcome.toLowerCase() === outcome.toLowerCase()
            ) {
              if (tokenId) {
                logToFile("INFO", "Found correct tokenId for outcome", {
                  conditionId,
                  outcome,
                  tokenId: tokenId.substring(0, 10) + "...",
                  fullTokenId: tokenId,
                  source: "tokens array",
                });
                return tokenId;
              }
            }
          }
        }

        if (market.outcomes && Array.isArray(market.outcomes)) {
          for (const outcomeOption of market.outcomes) {
            const outcomeTitle =
              outcomeOption.title ||
              outcomeOption.name ||
              outcomeOption.outcome ||
              outcomeOption.label;
            const tokenId = String(
              outcomeOption.token_id ||
                outcomeOption.asset_id ||
                outcomeOption.id ||
                ""
            );

            logToFile("INFO", "Checking outcome option for match", {
              conditionId,
              targetOutcome: outcome,
              outcomeTitle,
              tokenId: tokenId.substring(0, 10) + "...",
              outcomeKeys: Object.keys(outcomeOption),
            });

            if (
              outcomeTitle &&
              outcomeTitle.toLowerCase() === outcome.toLowerCase()
            ) {
              if (tokenId) {
                logToFile("INFO", "Found correct tokenId from outcomes array", {
                  conditionId,
                  outcome,
                  tokenId: tokenId.substring(0, 10) + "...",
                  fullTokenId: tokenId,
                  source: "outcomes array",
                });
                return tokenId;
              }
            }
          }
        }

        logToFile("WARN", "Could not find matching tokenId for outcome", {
          conditionId,
          targetOutcome: outcome,
          availableTokens:
            market.tokens?.map((t) => ({
              outcome: t.outcome || t.title || t.name || t.label,
              tokenId:
                String(t.token_id || t.asset_id || t.id || "").substring(
                  0,
                  10
                ) + "...",
            })) || [],
          availableOutcomes:
            market.outcomes?.map((o) => ({
              title: o.title || o.name || o.outcome || o.label,
              tokenId:
                String(o.token_id || o.asset_id || o.id || "").substring(
                  0,
                  10
                ) + "...",
            })) || [],
        });
      }
    } else {
      logToFile("WARN", "Market API returned non-OK status", {
        conditionId,
        outcome,
        status: response.status,
        statusText: response.statusText,
      });
    }
  } catch (error) {
    logToFile("WARN", "Failed to fetch market data for tokenId lookup", {
      conditionId,
      outcome,
      error: error.message,
    });
  }

  return null;
}

async function getCurrentMarketPrice(tokenId) {
  try {
    let orderBook = null;
    let orderBookSource = "none";

    if (orderbookWS && orderbookWS.isConnected) {
      orderbookWS.subscribe(tokenId);
      const wsOrderbook = orderbookWS.getOrderbook(tokenId);
      if (wsOrderbook && Date.now() - wsOrderbook.timestamp < 5000) {
        orderBook = {
          asks: wsOrderbook.asks,
          bids: wsOrderbook.bids,
        };
        orderBookSource = "websocket";
      }
    }

    if (!orderBook && clobClient && clobClientReady) {
      try {
        orderBook = await clobClient.getOrderBook(tokenId);
        orderBookSource = "rest";
      } catch (error) {
        logToFile("WARN", "Failed to get orderbook via REST", {
          tokenId: tokenId.substring(0, 10) + "...",
          error: error.message,
        });
      }
    }

    if (orderBook) {
      const hasBids = orderBook.bids && orderBook.bids.length > 0;
      const hasAsks = orderBook.asks && orderBook.asks.length > 0;
      logToFile("INFO", "Orderbook retrieved", {
        tokenId: tokenId.substring(0, 10) + "...",
        source: orderBookSource,
        hasBids,
        hasAsks,
        bidCount: orderBook.bids?.length || 0,
        askCount: orderBook.asks?.length || 0,
      });
    } else {
      logToFile("WARN", "No orderbook available", {
        tokenId: tokenId.substring(0, 10) + "...",
      });
      return null;
    }

    return null;

    if (orderBook && orderBook.bids && orderBook.bids.length > 0) {
      const bestBid = orderBook.bids[0];
      if (bestBid && bestBid.price) {
        const price = parseFloat(bestBid.price);
        if (!isNaN(price) && price >= 0 && price <= 1) {
          logToFile("INFO", "Using best bid price", {
            tokenId: tokenId.substring(0, 10) + "...",
            fullTokenId: tokenId,
            price,
            bestBidPrice: bestBid.price,
            bestBidSize: bestBid.size,
            totalBids: orderBook.bids.length,
            source: orderBookSource,
            top3Bids: orderBook.bids
              .slice(0, 3)
              .map((b) => ({ price: b.price, size: b.size })),
          });
          return { price, bestBidSize: parseFloat(bestBid.size) || 0 };
        } else {
          logToFile("WARN", "Best bid price is invalid", {
            tokenId: tokenId.substring(0, 10) + "...",
            price,
            bestBid,
          });
        }
      }
    }

    if (orderBook && orderBook.asks && orderBook.asks.length > 0) {
      const bestAsk = orderBook.asks[0];
      if (bestAsk && bestAsk.price) {
        const price = parseFloat(bestAsk.price);
        if (!isNaN(price) && price >= 0 && price <= 1) {
          logToFile("WARN", "Using ask price (no bids available)", {
            tokenId: tokenId.substring(0, 10) + "...",
            price,
            source: orderBookSource,
            note: "This may not reflect sellable price accurately",
          });
          return { price, bestBidSize: 0 };
        }
      }
    }

    if (
      orderBook &&
      orderBook.bids &&
      orderBook.asks &&
      orderBook.bids.length > 0 &&
      orderBook.asks.length > 0
    ) {
      const bestBid = parseFloat(orderBook.bids[0].price);
      const bestAsk = parseFloat(orderBook.asks[0].price);
      if (!isNaN(bestBid) && !isNaN(bestAsk) && bestBid >= 0 && bestAsk <= 1) {
        const midPrice = (bestBid + bestAsk) / 2;
        logToFile("INFO", "Using mid price", {
          tokenId: tokenId.substring(0, 10) + "...",
          midPrice,
          bestBid,
          bestAsk,
          source: orderBookSource,
        });
        const bestBidSize = parseFloat(orderBook.bids[0].size) || 0;
        return { price: midPrice, bestBidSize };
      }
    }

    logToFile("WARN", "Orderbook exists but no valid prices found", {
      tokenId: tokenId.substring(0, 10) + "...",
      hasBids: !!(orderBook && orderBook.bids && orderBook.bids.length > 0),
      hasAsks: !!(orderBook && orderBook.asks && orderBook.asks.length > 0),
    });
  } catch (error) {
    logToFile("WARN", "Error getting market price", {
      tokenId: tokenId.substring(0, 10) + "...",
      error: error.message,
    });
  }

  return null;
}

async function checkAndSettleResolvedMarkets() {
  if (!PAPER_TRADING_ENABLED || !activeChannel) {
    return;
  }

  const now = Date.now();
  const positionsToCheck = Object.entries(paperTradingState.positions);
  const HIGH_PRICE_THRESHOLD = 0.999;
  const LOW_PRICE_THRESHOLD = 0.001;

  for (const [tokenId, position] of positionsToCheck) {
    if (position.lastChecked && now - position.lastChecked < 300000) {
      continue;
    }

    try {
      let tokenIdToCheck = tokenId;

      if (position.conditionId && position.outcome) {
        logToFile("INFO", "Verifying tokenId for auto-close check", {
          storedTokenId: tokenId.substring(0, 10) + "...",
          conditionId: position.conditionId,
          outcome: position.outcome,
        });

        const correctTokenId = await getTokenIdForOutcome(
          position.conditionId,
          position.outcome
        );

        if (correctTokenId && correctTokenId !== tokenId) {
          logToFile(
            "WARN",
            "TokenId mismatch detected - using correct tokenId for orderbook",
            {
              storedTokenId: tokenId.substring(0, 10) + "...",
              correctTokenId: correctTokenId.substring(0, 10) + "...",
              market: position.market,
              outcome: position.outcome,
              note: "Stored tokenId doesn't match outcome, using correct tokenId from market data for orderbook query",
            }
          );
          tokenIdToCheck = correctTokenId;
        } else if (correctTokenId === tokenId) {
          logToFile("INFO", "TokenId verified - matches outcome", {
            tokenId: tokenId.substring(0, 10) + "...",
            outcome: position.outcome,
          });
        } else if (!correctTokenId) {
          logToFile("WARN", "Could not find correct tokenId for outcome", {
            tokenId: tokenId.substring(0, 10) + "...",
            conditionId: position.conditionId,
            outcome: position.outcome,
            note: "Will use stored tokenId, but price may be incorrect if it's the wrong token",
          });
        }
      } else {
        logToFile(
          "WARN",
          "Missing conditionId or outcome for tokenId verification",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            hasConditionId: !!position.conditionId,
            hasOutcome: !!position.outcome,
            note: "Cannot verify tokenId - position may have been created before outcome tracking was added",
          }
        );
      }

      logToFile("INFO", "Checking price for paper position", {
        tokenId: tokenIdToCheck.substring(0, 10) + "...",
        fullTokenId: tokenIdToCheck,
        market: position.market,
        outcome: position.outcome,
        entryPrice: position.avgPrice,
      });

      const priceResult = await getCurrentMarketPrice(tokenIdToCheck);

      if (
        priceResult !== null &&
        priceResult.price !== undefined &&
        !isNaN(priceResult.price) &&
        priceResult.price >= 0 &&
        priceResult.price <= 1
      ) {
        const currentPrice = priceResult.price;
        const bestBidSize = priceResult.bestBidSize || 0;
        logToFile("INFO", "Checking position price for auto-close", {
          tokenId: tokenId.substring(0, 10) + "...",
          market: position.market,
          outcome: position.outcome,
          currentPrice,
          bestBidSize,
          entryPrice: position.avgPrice,
          highThreshold: HIGH_PRICE_THRESHOLD,
          lowThreshold: LOW_PRICE_THRESHOLD,
        });

        const entryPrice = position.avgPrice || 0;
        const priceSum = entryPrice + currentPrice;
        const priceChange = Math.abs(currentPrice - entryPrice);

        const isInverted =
          (priceSum > 0.95 && priceSum < 1.05 && priceChange > 0.3) ||
          (entryPrice > 0.5 && currentPrice < 0.1) ||
          (entryPrice < 0.1 && currentPrice > 0.9) ||
          (entryPrice > 0.5 && currentPrice < 0.1 && bestBidSize > 1000);

        let correctedPrice = currentPrice;

        if (isInverted) {
          correctedPrice = 1.0 - currentPrice;
          logToFile(
            "WARN",
            "Price inversion detected - correcting to opposite token price",
            {
              tokenId: tokenId.substring(0, 10) + "...",
              fullTokenId: tokenId,
              market: position.market,
              outcome: position.outcome,
              entryPrice,
              originalPrice: currentPrice,
              correctedPrice,
              priceSum,
              bestBidSize,
              note: "Detected price inversion - using inverse price (1 - original) as we likely got the opposite token's orderbook. Many shares at low price when entry was high confirms wrong token.",
            }
          );
        }

        position.lastChecked = now;

        const priceToCheck = correctedPrice;

        if (priceToCheck >= HIGH_PRICE_THRESHOLD) {
          const settlementPrice = 1.0;
          const pnl = position.shares * (settlementPrice - position.avgPrice);
          const proceeds = position.shares * settlementPrice;

          paperTradingState.balance += proceeds;
          paperTradingState.realizedPnL += pnl;

          paperTradingState.tradeHistory.push({
            timestamp: Date.now(),
            side: "AUTO_CLOSE_WIN",
            tokenId,
            shares: position.shares,
            price: settlementPrice,
            currentPrice: currentPrice,
            value: proceeds,
            pnl: pnl,
            market: position.market,
          });

          await activeChannel.send({
            embeds: [
              {
                title: "✅ Position Auto-Closed (Win)",
                description: `Market "${position.market}" reached ${(
                  priceToCheck * 100
                ).toFixed(1)}¢ - position automatically closed as win.`,
                color: 0x00aa00,
                fields: [
                  {
                    name: "Shares",
                    value: `${position.shares.toFixed(2)}`,
                    inline: true,
                  },
                  {
                    name: "Entry Price",
                    value: `$${position.avgPrice.toFixed(4)}`,
                    inline: true,
                  },
                  {
                    name: "Current Price",
                    value: `$${priceToCheck.toFixed(4)} (${(
                      priceToCheck * 100
                    ).toFixed(1)}¢)`,
                    inline: true,
                  },
                  {
                    name: "Settlement Price",
                    value: `$${settlementPrice.toFixed(4)}`,
                    inline: true,
                  },
                  {
                    name: "Proceeds",
                    value: `$${proceeds.toFixed(2)}`,
                    inline: true,
                  },
                  {
                    name: "PnL",
                    value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                    inline: true,
                  },
                  {
                    name: "New Balance",
                    value: `$${paperTradingState.balance.toFixed(2)}`,
                    inline: true,
                  },
                ],
                timestamp: new Date().toISOString(),
              },
            ],
          });

          logToFile("INFO", "Paper position auto-closed (win)", {
            tokenId,
            market: position.market,
            shares: position.shares,
            entryPrice: position.avgPrice,
            currentPrice: priceToCheck,
            originalPrice: currentPrice,
            settlementPrice,
            pnl,
            proceeds,
          });

          delete paperTradingState.positions[tokenId];
          savePaperTradingState();
          continue;
        } else if (priceToCheck <= LOW_PRICE_THRESHOLD) {
          const settlementPrice = 0.0;
          const pnl = position.shares * (settlementPrice - position.avgPrice);
          const proceeds = position.shares * settlementPrice;

          paperTradingState.balance += proceeds;
          paperTradingState.realizedPnL += pnl;

          paperTradingState.tradeHistory.push({
            timestamp: Date.now(),
            side: "AUTO_CLOSE_LOSS",
            tokenId,
            shares: position.shares,
            price: settlementPrice,
            currentPrice: currentPrice,
            value: proceeds,
            pnl: pnl,
            market: position.market,
          });

          await activeChannel.send({
            embeds: [
              {
                title: "❌ Position Auto-Closed (Loss)",
                description: `Market "${position.market}" dropped to ${(
                  currentPrice * 100
                ).toFixed(2)}¢ - position automatically closed as loss.`,
                color: 0xaa0000,
                fields: [
                  {
                    name: "Shares",
                    value: `${position.shares.toFixed(2)}`,
                    inline: true,
                  },
                  {
                    name: "Entry Price",
                    value: `$${position.avgPrice.toFixed(4)}`,
                    inline: true,
                  },
                  {
                    name: "Current Price",
                    value: `$${currentPrice.toFixed(4)} (${(
                      currentPrice * 100
                    ).toFixed(2)}¢)`,
                    inline: true,
                  },
                  {
                    name: "Settlement Price",
                    value: `$${settlementPrice.toFixed(4)}`,
                    inline: true,
                  },
                  {
                    name: "Proceeds",
                    value: `$${proceeds.toFixed(2)}`,
                    inline: true,
                  },
                  {
                    name: "PnL",
                    value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                    inline: true,
                  },
                  {
                    name: "New Balance",
                    value: `$${paperTradingState.balance.toFixed(2)}`,
                    inline: true,
                  },
                ],
                timestamp: new Date().toISOString(),
              },
            ],
          });

          logToFile("INFO", "Paper position auto-closed (loss)", {
            tokenId,
            market: position.market,
            shares: position.shares,
            entryPrice: position.avgPrice,
            currentPrice,
            settlementPrice,
            pnl,
            proceeds,
          });

          delete paperTradingState.positions[tokenId];
          savePaperTradingState();
          continue;
        }
      }
    } catch (error) {
      logToFile("WARN", "Failed to check orderbook price", {
        tokenId,
        error: error.message,
      });
    }

    if (position.conditionId) {
      try {
        const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${position.conditionId}`;
        const response = await fetch(marketUrl, {
          headers: {
            accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
        });

        if (response.ok) {
          const markets = await response.json();
          if (Array.isArray(markets) && markets.length > 0) {
            const market = markets[0];
            const resolved =
              market.resolved ||
              market.status === "Resolved" ||
              market.status === "Closed";
            const finalPrice =
              market.outcomePrices?.[0] || market.resolvedPrice || null;

            position.lastChecked = now;

            if (resolved && finalPrice !== null && finalPrice !== undefined) {
              const settlementPrice =
                typeof finalPrice === "number"
                  ? finalPrice
                  : parseFloat(finalPrice);
              if (
                !isNaN(settlementPrice) &&
                settlementPrice >= 0 &&
                settlementPrice <= 1
              ) {
                const pnl =
                  position.shares * (settlementPrice - position.avgPrice);
                const proceeds = position.shares * settlementPrice;

                paperTradingState.balance += proceeds;
                paperTradingState.realizedPnL += pnl;

                paperTradingState.tradeHistory.push({
                  timestamp: Date.now(),
                  side: "SETTLEMENT",
                  tokenId,
                  shares: position.shares,
                  price: settlementPrice,
                  value: proceeds,
                  pnl: pnl,
                  market: position.market,
                });

                await activeChannel.send({
                  embeds: [
                    {
                      title: "✅ Market Resolved - Paper Position Settled",
                      description: `Market "${position.market}" has been resolved and position settled automatically.`,
                      color: pnl >= 0 ? 0x00aa00 : 0xaa0000,
                      fields: [
                        {
                          name: "Shares",
                          value: `${position.shares.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "Entry Price",
                          value: `$${position.avgPrice.toFixed(4)}`,
                          inline: true,
                        },
                        {
                          name: "Settlement Price",
                          value: `$${settlementPrice.toFixed(4)}`,
                          inline: true,
                        },
                        {
                          name: "Proceeds",
                          value: `$${proceeds.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "PnL",
                          value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                          inline: true,
                        },
                        {
                          name: "New Balance",
                          value: `$${paperTradingState.balance.toFixed(2)}`,
                          inline: true,
                        },
                      ],
                      timestamp: new Date().toISOString(),
                    },
                  ],
                });

                logToFile(
                  "INFO",
                  "Paper position settled due to market resolution",
                  {
                    tokenId,
                    market: position.market,
                    shares: position.shares,
                    entryPrice: position.avgPrice,
                    settlementPrice,
                    pnl,
                    proceeds,
                  }
                );

                delete paperTradingState.positions[tokenId];
                savePaperTradingState();
              }
            }
          }
        }
      } catch (error) {
        logToFile("WARN", "Failed to check market resolution status", {
          tokenId,
          conditionId: position.conditionId,
          error: error.message,
        });
      }
    }
  }
}

function matchesAutoTradeFilter(trade) {
  if (!AUTO_TRADE_FILTER) {
    return true;
  }

  const keywords = AUTO_TRADE_FILTER.split(",")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);

  const searchText = [trade.title, trade.slug, trade.eventSlug, trade.outcome]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const matched = keywords.some((keyword) => {
    const directMatch = searchText.includes(keyword);
    let extendedMatch = false;

    if (keyword === "eth") {
      extendedMatch = searchText.includes("ethereum");
    } else if (keyword === "btc") {
      extendedMatch = searchText.includes("bitcoin");
    }

    return directMatch || extendedMatch;
  });

  return matched;
}

function isCloudflareBlock(response) {
  if (!response) return false;
  if (typeof response === "string") {
    return (
      response.includes("Cloudflare") || response.includes("Attention Required")
    );
  }
  if (typeof response === "object") {
    const responseStr = JSON.stringify(response);
    return (
      responseStr.includes("Cloudflare") ||
      responseStr.includes("Attention Required")
    );
  }
  return false;
}

async function placeBuyOrder(tokenId, price, size, orderType = OrderType.GTC) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeBuyOrder failed", { error, tokenId, price, size });
    throw new Error(error);
  }

  try {
    let response;
    let lastError = null;
    let order = null;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying buy order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId,
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        order = await clobClient.createOrder({
          tokenID: tokenId,
          price: price,
          side: Side.BUY,
          size: size,
          feeRateBps: 0,
          nonce: orderNonce,
        });

        response = await clobClient.postOrder(order, orderType);

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry with fresh nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: price,
              side: Side.BUY,
              size: size,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (response && response.error) {
          throw new Error(response.error);
        }

        break;
      } catch (postError) {
        lastError = postError;
        const errorMsg = postError?.message || String(postError);
        const responseError =
          postError?.response?.error || postError?.error || errorMsg;

        if (
          responseError &&
          (responseError.includes("invalid nonce") ||
            errorMsg.includes("invalid nonce"))
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected, incrementing nonce (attempt ${attempt})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: price,
              side: Side.BUY,
              size: size,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. Please restart the bot.`
            );
          }
        }

        if (
          postError &&
          postError.message &&
          isCloudflareBlock(postError.message)
        ) {
          logToFile(
            "WARN",
            `Cloudflare block detected (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              price,
              size,
              attempt,
              errorMessage: postError.message.substring(0, 200),
            }
          );

          if (attempt === MAX_CLOUDFLARE_RETRIES) {
            const errorMsg =
              "Cloudflare is blocking CLOB API requests. Your server IP may be flagged. The Data API works, but order placement is blocked. Please contact Polymarket support or try from a different network.";
            logToFile("ERROR", "Cloudflare block - max retries reached", {
              tokenId,
              price,
              size,
            });
            throw new Error(errorMsg);
          }
          continue;
        }
        throw postError;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        price,
        size,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        price,
        size,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place buy order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      price,
      size,
    });
    throw new Error(`Failed to place buy order: ${error.message}`);
  }
}

async function placeSellOrder(tokenId, price, size, orderType = OrderType.GTC) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeSellOrder failed", {
      error,
      tokenId,
      price,
      size,
    });
    throw new Error(error);
  }

  try {
    orderNonce = orderNonce + 1;
    const order = await clobClient.createOrder({
      tokenID: tokenId,
      price: price,
      side: Side.SELL,
      size: size,
      feeRateBps: 0,
      nonce: orderNonce,
    });

    let response;
    try {
      response = await clobClient.postOrder(order, orderType);
    } catch (postError) {
      if (
        postError &&
        postError.message &&
        isCloudflareBlock(postError.message)
      ) {
        const errorMsg =
          "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
        logToFile("ERROR", "Cloudflare block detected (from error)", {
          tokenId,
          price,
          size,
          errorMessage: postError.message.substring(0, 200),
        });
        throw new Error(errorMsg);
      }
      throw postError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        price,
        size,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        price,
        size,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place sell order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      price,
      size,
    });
    throw new Error(`Failed to place sell order: ${error.message}`);
  }
}

async function placeMarketBuyOrder(tokenId, amount, estimatedPrice) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeMarketBuyOrder failed", {
      error,
      tokenId,
      amount,
      estimatedPrice,
    });
    throw new Error(error);
  }

  try {
    const MIN_ORDER_VALUE_USD = 1;

    let orderAmount = Math.max(amount, MIN_ORDER_VALUE_USD);
    orderAmount = Math.min(orderAmount, MAX_ORDER_VALUE_USD);
    orderAmount = parseFloat(orderAmount.toFixed(2));

    let marketPrice = estimatedPrice
      ? parseFloat(estimatedPrice.toFixed(2))
      : undefined;

    let response;
    let lastError = null;
    let order = null;
    const LIQUIDITY_BUFFER = 1.3;
    let priceIndex = 0;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying market buy order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId,
              priceIndex,
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        let currentOrderAmount = orderAmount;
        let currentMarketPrice = marketPrice;

        let orderBook = null;
        let orderBookSource = "REST";

        try {
          if (orderbookWS && orderbookWS.isConnected) {
            orderbookWS.subscribe(tokenId);
            const wsOrderbook = orderbookWS.getOrderbook(tokenId);
            if (wsOrderbook && Date.now() - wsOrderbook.timestamp < 5000) {
              orderBook = {
                asks: wsOrderbook.asks,
                bids: wsOrderbook.bids,
              };
              orderBookSource = "WebSocket";
            }
          }

          if (!orderBook) {
            orderBook = await clobClient.getOrderBook(tokenId);
            orderBookSource = "REST";
          }

          if (!orderBook.asks || orderBook.asks.length === 0) {
            logToFile("WARN", "No asks found in orderbook, skipping order", {
              tokenId,
              currentOrderAmount,
              attempt,
            });
            throw new Error(
              "No asks found in orderbook. Cannot place market buy order."
            );
          }

          const sortedAsks = orderBook.asks
            .map((ask) => ({
              price: parseFloat(ask.price),
              size: parseFloat(ask.size),
            }))
            .sort((a, b) => a.price - b.price);

          if (priceIndex >= sortedAsks.length) {
            logToFile("WARN", "No more prices to try in orderbook", {
              tokenId,
              priceIndex,
              totalAsks: sortedAsks.length,
              attempt,
            });
            throw new Error(
              "Exhausted all available prices in orderbook. Cannot place order."
            );
          }

          const selectedPrice = sortedAsks[priceIndex].price;
          let cumulativeLiquidity = 0;
          let asksChecked = 0;

          for (let i = priceIndex; i < sortedAsks.length; i++) {
            const ask = sortedAsks[i];
            const askLiquidity = ask.size * ask.price;
            cumulativeLiquidity += askLiquidity;
            asksChecked++;
            if (cumulativeLiquidity >= currentOrderAmount * LIQUIDITY_BUFFER) {
              break;
            }
          }

          const requiredLiquidity = currentOrderAmount * LIQUIDITY_BUFFER;

          if (cumulativeLiquidity < MIN_ORDER_VALUE_USD) {
            logToFile(
              "WARN",
              "Insufficient cumulative liquidity for minimum order",
              {
                tokenId,
                cumulativeLiquidity,
                minRequired: MIN_ORDER_VALUE_USD,
                attempt,
                priceIndex,
              }
            );
            if (priceIndex < sortedAsks.length - 1) {
              priceIndex++;
              continue;
            }
            throw new Error(
              `Insufficient liquidity: ${cumulativeLiquidity.toFixed(
                2
              )} available, minimum ${MIN_ORDER_VALUE_USD} required`
            );
          }

          if (cumulativeLiquidity < requiredLiquidity) {
            logToFile(
              "WARN",
              "Insufficient liquidity buffer, adjusting order amount",
              {
                tokenId,
                requestedAmount: currentOrderAmount,
                cumulativeLiquidity,
                requiredLiquidity,
                adjustedAmount: cumulativeLiquidity / LIQUIDITY_BUFFER,
                attempt,
                priceIndex,
              }
            );
            currentOrderAmount = Math.max(
              MIN_ORDER_VALUE_USD,
              Math.min(
                cumulativeLiquidity / LIQUIDITY_BUFFER,
                MAX_ORDER_VALUE_USD
              )
            );
            currentOrderAmount = parseFloat(currentOrderAmount.toFixed(2));
          }

          currentMarketPrice = selectedPrice;
        } catch (orderBookError) {
          if (
            orderBookError.message &&
            (orderBookError.message.includes("No asks") ||
              orderBookError.message.includes("Insufficient liquidity") ||
              orderBookError.message.includes("Exhausted all available prices"))
          ) {
            throw orderBookError;
          }
          logToFile(
            "WARN",
            "Failed to fetch orderbook, proceeding with order",
            {
              tokenId,
              error: orderBookError.message,
              attempt,
            }
          );
        }

        const orderParams = {
          tokenID: tokenId,
          amount: currentOrderAmount,
        };
        if (currentMarketPrice) {
          orderParams.price = currentMarketPrice;
        }

        order = await clobClient.createMarketBuyOrder(orderParams);

        response = await clobClient.postOrder(order, OrderType.FOK);

        if (
          response &&
          response.error &&
          (response.error.includes("order couldn't be fully filled") ||
            response.error.includes("FOK orders are fully filled or killed"))
        ) {
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            logToFile(
              "WARN",
              "Order couldn't be filled at current price, trying next price",
              {
                tokenId,
                currentPrice: currentMarketPrice,
                currentAmount: currentOrderAmount,
                attempt,
                priceIndex,
              }
            );
            priceIndex++;
            continue;
          } else {
            throw new Error(
              `Order couldn't be fully filled after trying ${
                priceIndex + 1
              } price levels. Market may have insufficient liquidity.`
            );
          }
        }

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry with fresh nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            const orderParams = {
              tokenID: tokenId,
              amount: currentOrderAmount,
            };
            if (currentMarketPrice) {
              orderParams.price = currentMarketPrice;
            }
            order = await clobClient.createMarketBuyOrder(orderParams);
            response = await clobClient.postOrder(order, OrderType.FOK);
            if (
              response &&
              response.error &&
              response.error.includes("invalid nonce")
            ) {
              continue;
            }
            if (response && response.error) {
              throw new Error(response.error);
            }
            break;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (response && response.error) {
          throw new Error(response.error);
        }

        break;
      } catch (postError) {
        lastError = postError;
        const errorMsg = postError?.message || String(postError);
        const responseError =
          postError?.response?.error || postError?.error || errorMsg;

        if (
          responseError &&
          (responseError.includes("order couldn't be fully filled") ||
            responseError.includes("FOK orders are fully filled or killed") ||
            errorMsg.includes("order couldn't be fully filled") ||
            errorMsg.includes("FOK orders are fully filled or killed"))
        ) {
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            logToFile(
              "WARN",
              "Order couldn't be filled at current price (from exception), trying next price",
              {
                tokenId,
                currentPrice: currentMarketPrice,
                currentAmount: currentOrderAmount,
                attempt,
                priceIndex,
              }
            );
            priceIndex++;
            continue;
          } else {
            throw new Error(
              `Order couldn't be fully filled after trying ${
                priceIndex + 1
              } price levels. Market may have insufficient liquidity.`
            );
          }
        }

        if (
          responseError &&
          (responseError.includes("invalid nonce") ||
            errorMsg.includes("invalid nonce"))
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected in exception, incrementing nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            const orderParams = {
              tokenID: tokenId,
              amount: currentOrderAmount,
            };
            if (currentMarketPrice) {
              orderParams.price = currentMarketPrice;
            }
            order = await clobClient.createMarketBuyOrder(orderParams);
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (
          postError &&
          postError.message &&
          isCloudflareBlock(postError.message)
        ) {
          logToFile(
            "WARN",
            `Cloudflare block detected (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              amount: orderAmount,
              attempt,
              errorMessage: postError.message.substring(0, 200),
            }
          );

          if (attempt === MAX_CLOUDFLARE_RETRIES) {
            const errorMsg =
              "Cloudflare is blocking CLOB API requests. Your server IP may be flagged. The Data API works, but order placement is blocked. Please contact Polymarket support or try from a different network.";
            logToFile("ERROR", "Cloudflare block - max retries reached", {
              tokenId,
              amount: orderAmount,
            });
            throw new Error(errorMsg);
          }
          continue;
        }
        throw postError;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        amount: orderAmount,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        amount,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place market buy order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      amount,
      estimatedPrice,
    });
    throw new Error(`Failed to place market buy order: ${error.message}`);
  }
}

async function placeMarketSellOrder(tokenId, amount, price) {
  if (!clobClient || !clobClientReady) {
    const error =
      "CLOB client not initialized or API credentials not set. Please wait for initialization to complete.";
    logToFile("ERROR", "placeMarketSellOrder failed", {
      error,
      tokenId,
      amount,
      price,
    });
    throw new Error(error);
  }

  try {
    const MIN_ORDER_VALUE_USD = 1;
    let orderSize = amount;
    let marketPrice = price ? parseFloat(price.toFixed(2)) : undefined;

    if (provider && signer) {
      try {
        const tokenContract = new Contract(
          tokenId,
          ["function balanceOf(address owner) view returns (uint256)"],
          provider
        );
        const walletAddress = POLYMARKET_FUNDER || signer.address;
        const tokenBalance = await tokenContract.balanceOf(walletAddress);
        const tokenBalanceFormatted = parseFloat(
          (Number(tokenBalance) / 1e18).toFixed(4)
        );

        if (tokenBalanceFormatted < orderSize) {
          logToFile(
            "WARN",
            "Insufficient token balance for sell order, skipping",
            {
              tokenId,
              tokenBalance: tokenBalanceFormatted,
              requestedSize: orderSize,
              shortfall: orderSize - tokenBalanceFormatted,
            }
          );
          throw new Error(
            `Insufficient token balance: You have ${tokenBalanceFormatted} tokens, but need ${orderSize} to sell. You must own the tokens before you can sell them.`
          );
        }
      } catch (balanceError) {
        if (
          balanceError.message &&
          balanceError.message.includes("Insufficient token balance")
        ) {
          throw balanceError;
        }
        logToFile("WARN", "Failed to check token balance, proceeding", {
          tokenId,
          error: balanceError.message,
        });
      }
    }

    let response;
    let lastError = null;
    let order = null;
    const LIQUIDITY_BUFFER = 1.3;
    let priceIndex = 0;

    for (let attempt = 1; attempt <= MAX_CLOUDFLARE_RETRIES; attempt++) {
      try {
        if (attempt > 1) {
          const delay = CLOUDFLARE_RETRY_DELAY_MS * attempt;
          logToFile(
            "INFO",
            `Retrying market sell order (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              delayMs: delay,
              tokenId,
              priceIndex,
            }
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        let currentOrderSize = orderSize;
        let currentMarketPrice = marketPrice;

        let orderBook = null;
        let orderBookSource = "REST";

        try {
          if (orderbookWS && orderbookWS.isConnected) {
            orderbookWS.subscribe(tokenId);
            const wsOrderbook = orderbookWS.getOrderbook(tokenId);
            if (wsOrderbook && Date.now() - wsOrderbook.timestamp < 5000) {
              orderBook = {
                asks: wsOrderbook.asks,
                bids: wsOrderbook.bids,
              };
              orderBookSource = "WebSocket";
            }
          }

          if (!orderBook) {
            orderBook = await clobClient.getOrderBook(tokenId);
            orderBookSource = "REST";
          }

          if (!orderBook.bids || orderBook.bids.length === 0) {
            logToFile("WARN", "No bids found in orderbook, skipping order", {
              tokenId,
              currentOrderSize,
              attempt,
            });
            throw new Error(
              "No bids found in orderbook. Cannot place market sell order."
            );
          }

          const sortedBids = orderBook.bids
            .map((bid) => ({
              price: parseFloat(bid.price),
              size: parseFloat(bid.size),
            }))
            .sort((a, b) => b.price - a.price);

          if (priceIndex >= sortedBids.length) {
            logToFile("WARN", "No more prices to try in orderbook", {
              tokenId,
              priceIndex,
              totalBids: sortedBids.length,
              attempt,
            });
            throw new Error(
              "Exhausted all available prices in orderbook. Cannot place order."
            );
          }

          const selectedPrice = sortedBids[priceIndex].price;
          let cumulativeLiquidity = 0;
          let bidsChecked = 0;

          for (let i = priceIndex; i < sortedBids.length; i++) {
            const bid = sortedBids[i];
            const bidLiquidity = bid.size * bid.price;
            cumulativeLiquidity += bidLiquidity;
            bidsChecked++;
            if (
              cumulativeLiquidity >=
              currentOrderSize * selectedPrice * LIQUIDITY_BUFFER
            ) {
              break;
            }
          }

          const requiredLiquidity =
            currentOrderSize * selectedPrice * LIQUIDITY_BUFFER;

          const orderValue = currentOrderSize * selectedPrice;
          if (orderValue < MIN_ORDER_VALUE_USD) {
            const requiredSize =
              Math.ceil((MIN_ORDER_VALUE_USD / selectedPrice) * 10000) / 10000;
            currentOrderSize = Math.floor(requiredSize * 10000) / 10000;
          }

          if (orderValue > MAX_ORDER_VALUE_USD) {
            const maxSize =
              Math.floor((MAX_ORDER_VALUE_USD / selectedPrice) * 10000) / 10000;
            currentOrderSize = Math.floor(maxSize * 10000) / 10000;
          }

          if (cumulativeLiquidity < currentOrderSize * selectedPrice) {
            if (priceIndex < sortedBids.length - 1) {
              priceIndex++;
              continue;
            }
            throw new Error(
              `Insufficient liquidity: ${cumulativeLiquidity.toFixed(
                2
              )} available, need ${(currentOrderSize * selectedPrice).toFixed(
                2
              )}`
            );
          }

          currentMarketPrice = selectedPrice;
        } catch (orderBookError) {
          if (
            orderBookError.message &&
            (orderBookError.message.includes("No bids") ||
              orderBookError.message.includes("Insufficient liquidity") ||
              orderBookError.message.includes("Exhausted all available prices"))
          ) {
            throw orderBookError;
          }
          logToFile(
            "WARN",
            "Failed to fetch orderbook, proceeding with order",
            {
              tokenId,
              error: orderBookError.message,
              attempt,
            }
          );
        }

        order = await clobClient.createOrder({
          tokenID: tokenId,
          price: currentMarketPrice,
          side: Side.SELL,
          size: currentOrderSize,
          feeRateBps: 0,
          nonce: orderNonce,
        });

        response = await clobClient.postOrder(order, OrderType.FOK);

        if (
          response &&
          response.error &&
          response.error.includes("invalid nonce")
        ) {
          logToFile(
            "WARN",
            `Invalid nonce in response, will retry with fresh nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            const newNonce = Date.now() * 1000;
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: marketPrice,
              side: Side.SELL,
              size: orderSize,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            response = await clobClient.postOrder(order, OrderType.FOK);
            if (
              response &&
              response.error &&
              response.error.includes("invalid nonce")
            ) {
              continue;
            }
            if (response && response.error) {
              throw new Error(response.error);
            }
            break;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (response && response.error) {
          if (
            response.error.includes("not enough balance") ||
            response.error.includes("not enough allowance")
          ) {
            logToFile(
              "WARN",
              "Insufficient token balance/allowance for sell order",
              {
                tokenId,
                orderSize,
                error: response.error,
              }
            );
            throw new Error(
              `Cannot sell: You don't own enough tokens. You need to buy tokens first before you can sell them. Error: ${response.error}`
            );
          }
          throw new Error(response.error);
        }

        break;
      } catch (postError) {
        lastError = postError;
        const errorMsg = postError?.message || String(postError);
        const responseError =
          postError?.response?.error || postError?.error || errorMsg;

        if (
          responseError &&
          (responseError.includes("not enough balance") ||
            responseError.includes("not enough allowance") ||
            errorMsg.includes("not enough balance") ||
            errorMsg.includes("not enough allowance"))
        ) {
          logToFile(
            "WARN",
            "Insufficient token balance/allowance detected, skipping sell order",
            {
              tokenId,
              orderSize,
              error: errorMsg,
            }
          );
          throw new Error(
            `Cannot sell: You don't own enough tokens. You need to buy tokens first before you can sell them.`
          );
        }

        if (
          responseError &&
          (responseError.includes("invalid nonce") ||
            errorMsg.includes("invalid nonce"))
        ) {
          logToFile(
            "WARN",
            `Invalid nonce detected in exception, incrementing nonce (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              failedNonce: orderNonce,
              attempt,
            }
          );
          if (attempt < MAX_CLOUDFLARE_RETRIES) {
            order = await clobClient.createOrder({
              tokenID: tokenId,
              price: marketPrice,
              side: Side.SELL,
              size: orderSize,
              feeRateBps: 0,
              nonce: orderNonce,
            });
            continue;
          } else {
            throw new Error(
              `Invalid nonce after ${MAX_CLOUDFLARE_RETRIES} attempts. The API may be rejecting all nonces. Please check your API credentials or contact Polymarket support.`
            );
          }
        }

        if (
          postError &&
          postError.message &&
          isCloudflareBlock(postError.message)
        ) {
          logToFile(
            "WARN",
            `Cloudflare block detected (attempt ${attempt}/${MAX_CLOUDFLARE_RETRIES})`,
            {
              tokenId,
              amount: orderAmount,
              attempt,
              errorMessage: postError.message.substring(0, 200),
            }
          );

          if (attempt === MAX_CLOUDFLARE_RETRIES) {
            const errorMsg =
              "Cloudflare is blocking CLOB API requests. Your server IP may be flagged. The Data API works, but order placement is blocked. Please contact Polymarket support or try from a different network.";
            logToFile("ERROR", "Cloudflare block - max retries reached", {
              tokenId,
              amount: orderAmount,
            });
            throw new Error(errorMsg);
          }
          continue;
        }
        throw postError;
      }
    }

    if (!response && lastError) {
      throw lastError;
    }

    if (isCloudflareBlock(response)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from response)", {
        tokenId,
        amount: orderAmount,
        responseType: typeof response,
        responsePreview:
          typeof response === "string"
            ? response.substring(0, 200)
            : JSON.stringify(response).substring(0, 200),
      });
      throw new Error(errorMsg);
    }

    return response;
  } catch (error) {
    if (error.message && error.message.includes("Cloudflare")) {
      throw error;
    }
    if (error.message && isCloudflareBlock(error.message)) {
      const errorMsg =
        "Cloudflare is blocking requests. Your server IP may be flagged. Please try again later or contact Polymarket support.";
      logToFile("ERROR", "Cloudflare block detected (from catch)", {
        tokenId,
        amount,
        errorMessage: error.message.substring(0, 200),
      });
      throw new Error(errorMsg);
    }
    logToFile("ERROR", "Failed to place market sell order", {
      error: error.message,
      stack: error.stack,
      tokenId,
      amount,
      price,
    });
    throw new Error(`Failed to place market sell order: ${error.message}`);
  }
}

async function startPolling(channel, walletAddress = null) {
  if (isPolling) {
    if (activeChannel?.id === channel.id) {
      await channel.send("Polling is already running in this channel.");
      return;
    }

    const previousChannelId = activeChannel?.id;
    await channel.send(
      previousChannelId
        ? `Switching monitoring from <#${previousChannelId}> to this channel.`
        : "Switching monitoring to this channel."
    );
  }

  if (!channel.isTextBased()) {
    await channel.send("Cannot start monitoring: channel is not text-based.");
    return;
  }

  const walletToUse = walletAddress || DEFAULT_WALLET;

  if (!isValidWalletAddress(walletToUse)) {
    await channel.send(
      `Invalid wallet address: ${walletToUse}. Please provide a valid Ethereum address (0x followed by 40 hex characters).`
    );
    return;
  }

  currentWallet = walletToUse;
  activeChannel = channel;
  isPolling = true;
  isInitialized = false;

  const walletDisplay =
    walletToUse === DEFAULT_WALLET
      ? `default wallet (${DEFAULT_WALLET})`
      : walletToUse;

  await channel.send(
    `Starting Polymarket monitoring for ${walletDisplay} with interval ${
      POLL_INTERVAL_MS / 1000
    }s.`
  );

  await pollOnce();
  scheduleNextPoll();
}

async function stopPolling(channel) {
  if (!isPolling) {
    await channel.send("Polling is not currently running.");
    return;
  }

  if (activeChannel?.id && activeChannel.id !== channel.id) {
    await channel.send(
      `Monitoring is currently active in <#${activeChannel?.id}>. Run ${STOP_COMMAND} there or use ${START_COMMAND} here to move it.`
    );
    return;
  }

  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }

  isPolling = false;
  activeChannel = null;
  await channel.send("Stopped Polymarket monitoring.");
}

client.once("ready", async () => {
  logToFile("INFO", "Discord bot ready", { botTag: client.user.tag });
  console.log(`Logged in as ${client.user.tag}`);
  console.log(
    `Ready for commands. Type ${START_COMMAND} in any text channel the bot can access to begin monitoring.`
  );
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) {
    return;
  }

  const content = message.content.trim();
  const contentLower = content.toLowerCase();

  if (contentLower.startsWith(START_COMMAND.toLowerCase())) {
    const parts = content.split(/\s+/);
    const walletAddress = parts.length > 1 ? parts[1] : null;
    await startPolling(message.channel, walletAddress);
  } else if (contentLower === STOP_COMMAND.toLowerCase()) {
    await stopPolling(message.channel);
  } else if (contentLower.startsWith(BUY_COMMAND.toLowerCase())) {
    const parts = content.split(/\s+/);
    if (parts.length < 4) {
      await message.channel.send(
        `Usage: ${BUY_COMMAND} <tokenId> <price> <size> [orderType]\n` +
          `Example: ${BUY_COMMAND} 71321045679252212594626385532706912750332728571942532289631379312455583992563 0.5 100 GTC\n` +
          `Order types: GTC (Good-Til-Cancelled), GTD (Good-Til-Date), FOK (Fill-Or-Kill)`
      );
      return;
    }

    const tokenId = parts[1];
    const price = parseFloat(parts[2]);
    const size = parseFloat(parts[3]);
    const orderType = parts[4]?.toUpperCase() || "GTC";

    if (isNaN(price) || isNaN(size) || price <= 0 || size <= 0) {
      await message.channel.send(
        "Invalid price or size. Both must be positive numbers."
      );
      return;
    }

    const validOrderTypes = ["GTC", "GTD", "FOK"];
    if (!validOrderTypes.includes(orderType)) {
      await message.channel.send(
        `Invalid order type. Use: ${validOrderTypes.join(", ")}`
      );
      return;
    }

    try {
      await message.channel.send(
        `Placing BUY order for ${size} shares at ${price}...`
      );
      const orderTypeEnum = OrderType[orderType];
      const response = await placeBuyOrder(tokenId, price, size, orderTypeEnum);

      if (response.success) {
        await message.channel.send(
          `✅ BUY order placed successfully!\n` +
            `Order ID: ${response.orderId}\n` +
            `Status: ${response.status || "unknown"}\n` +
            (response.orderHashes?.length > 0
              ? `Matched: ${response.orderHashes.length} order(s)`
              : "")
        );
      } else {
        await message.channel.send(
          `❌ Order failed: ${response.errorMsg || "Unknown error"}`
        );
      }
    } catch (error) {
      await message.channel.send(`❌ Error: ${error.message}`);
    }
  } else if (contentLower.startsWith(SELL_COMMAND.toLowerCase())) {
    const parts = content.split(/\s+/);
    if (parts.length < 4) {
      await message.channel.send(
        `Usage: ${SELL_COMMAND} <tokenId> <price> <size> [orderType]\n` +
          `Example: ${SELL_COMMAND} 71321045679252212594626385532706912750332728571942532289631379312455583992563 0.5 100 GTC\n` +
          `Order types: GTC (Good-Til-Cancelled), GTD (Good-Til-Date), FOK (Fill-Or-Kill)`
      );
      return;
    }

    const tokenId = parts[1];
    const price = parseFloat(parts[2]);
    const size = parseFloat(parts[3]);
    const orderType = parts[4]?.toUpperCase() || "GTC";

    if (isNaN(price) || isNaN(size) || price <= 0 || size <= 0) {
      await message.channel.send(
        "Invalid price or size. Both must be positive numbers."
      );
      return;
    }

    const validOrderTypes = ["GTC", "GTD", "FOK"];
    if (!validOrderTypes.includes(orderType)) {
      await message.channel.send(
        `Invalid order type. Use: ${validOrderTypes.join(", ")}`
      );
      return;
    }

    try {
      await message.channel.send(
        `Placing SELL order for ${size} shares at ${price}...`
      );
      const orderTypeEnum = OrderType[orderType];
      const response = await placeSellOrder(
        tokenId,
        price,
        size,
        orderTypeEnum
      );

      if (response.success) {
        await message.channel.send(
          `✅ SELL order placed successfully!\n` +
            `Order ID: ${response.orderId}\n` +
            `Status: ${response.status || "unknown"}\n` +
            (response.orderHashes?.length > 0
              ? `Matched: ${response.orderHashes.length} order(s)`
              : "")
        );
      } else {
        await message.channel.send(
          `❌ Order failed: ${response.errorMsg || "Unknown error"}`
        );
      }
    } catch (error) {
      await message.channel.send(`❌ Error: ${error.message}`);
    }
  } else if (contentLower === BALANCE_COMMAND.toLowerCase()) {
    if (!POLYMARKET_PRIVATE_KEY || !provider || !signer) {
      await message.channel.send(
        "❌ CLOB client not configured. POLYMARKET_PRIVATE_KEY is required."
      );
      return;
    }

    try {
      await message.channel.send("Checking balance and allowance...");
      const walletAddress = POLYMARKET_FUNDER || signer.address;
      const usdcContract = new Contract(USDC_ADDRESS, USDC_ABI, provider);
      const decimals = await usdcContract.decimals();
      const balance = await usdcContract.balanceOf(walletAddress);
      const allowance = await usdcContract.allowance(
        walletAddress,
        CLOB_EXCHANGE_ADDRESS
      );

      const balanceFormatted = (Number(balance) / 10 ** decimals).toFixed(2);
      let allowanceFormatted;
      if (Number(allowance) > 1e20) {
        allowanceFormatted = "Unlimited (Max Approval)";
      } else {
        allowanceFormatted = (Number(allowance) / 10 ** decimals).toFixed(2);
      }

      let messageText = `💰 **Balance & Allowance Check**\n\n`;

      messageText += `**EOA Address** (derived from your private key):\n\`${signer.address}\`\n`;
      const eoaBalance = await usdcContract.balanceOf(signer.address);
      const eoaBalanceFormatted = (Number(eoaBalance) / 10 ** decimals).toFixed(
        2
      );
      messageText += `- USDC Balance: $${eoaBalanceFormatted}\n`;
      const eoaAllowance = await usdcContract.allowance(
        signer.address,
        CLOB_EXCHANGE_ADDRESS
      );
      let eoaAllowanceFormatted;
      if (Number(eoaAllowance) > 1e20) {
        eoaAllowanceFormatted = "Unlimited";
      } else {
        eoaAllowanceFormatted = (Number(eoaAllowance) / 10 ** decimals).toFixed(
          2
        );
      }
      messageText += `- Allowance (CLOB): $${eoaAllowanceFormatted}\n\n`;

      if (POLYMARKET_FUNDER) {
        messageText += `**Proxy Wallet** (POLYMARKET_FUNDER - shown on your Polymarket profile):\n\`${POLYMARKET_FUNDER}\`\n`;
        messageText += `- USDC Balance: $${balanceFormatted}\n`;
        messageText += `- Allowance (CLOB): $${allowanceFormatted}\n\n`;
        messageText += `ℹ️ **Why addresses are different:**\n`;
        messageText += `- Your private key controls the EOA: \`${signer.address}\`\n`;
        messageText += `- Polymarket uses a proxy wallet: \`${POLYMARKET_FUNDER}\`\n`;
        messageText += `- Your Polymarket profile shows the proxy wallet address\n`;
        messageText += `- Trading happens through the proxy wallet (this is where your $253.50 is)\n`;
        messageText += `- This is normal and expected when using email/magic link login\n\n`;
      } else {
        messageText += `ℹ️ **Direct EOA Trading**\n`;
        messageText += `No proxy wallet configured. Using EOA directly.\n\n`;
      }

      if (Number(allowance) === 0) {
        messageText += `❌ **NO ALLOWANCE SET**\n`;
        messageText += `You need to approve the CLOB contract to spend USDC.\n\n`;
        messageText += `**To approve:**\n`;
        messageText += `1. Go to https://polymarket.com\n`;
        messageText += `2. Connect your wallet\n`;
        messageText += `3. Place a test order (this will trigger approval)\n`;
        messageText += `OR use a tool like MetaMask to approve:\n`;
        messageText += `- Token: USDC (${USDC_ADDRESS})\n`;
        messageText += `- Spender: ${CLOB_EXCHANGE_ADDRESS}\n`;
        messageText += `- Amount: Max (or a large amount like 1000000)\n`;
      } else if (Number(allowance) < Number(balance)) {
        messageText += `⚠️ **Allowance is less than balance**\n`;
        messageText += `You may need to increase your allowance.\n`;
      } else {
        messageText += `✅ **Allowance is sufficient**\n`;
      }

      if (Number(balance) === 0) {
        messageText += `\n❌ **NO USDC BALANCE**\n`;
        messageText += `Fund your wallet with USDC on Polygon.\n`;
      }

      await message.channel.send(messageText);
      logToFile("INFO", "Balance check completed", {
        walletAddress,
        balance: balanceFormatted,
        allowance: allowanceFormatted,
        hasFunder: !!POLYMARKET_FUNDER,
      });
    } catch (error) {
      logToFile("ERROR", "Balance check failed", {
        error: error.message,
        stack: error.stack,
      });
      await message.channel.send(`❌ Error checking balance: ${error.message}`);
    }
  } else if (contentLower === PAPER_BALANCE_COMMAND.toLowerCase()) {
    if (!PAPER_TRADING_ENABLED) {
      await message.channel.send(
        "❌ Paper trading is not enabled. Set `PAPER_TRADING_ENABLED=true` in your `.env` file."
      );
      return;
    }

    try {
      const balance = getPaperTradingBalance();

      const positionsWithLinks = [];
      const positionEntries = Object.entries(balance.positions);

      for (let i = 0; i < positionEntries.length; i++) {
        const [tokenId, pos] = positionEntries[i];

        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        try {
          const shortTokenId =
            tokenId.length > 20
              ? tokenId.substring(0, 10) +
                "..." +
                tokenId.substring(tokenId.length - 6)
              : tokenId;

          let marketLink = null;
          let marketTitle = pos.market || "Unknown";

          try {
            const identifier = pos.conditionId || tokenId;
            if (identifier) {
              if (pos.conditionId) {
                const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${pos.conditionId}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(marketUrl, {
                  headers: { Accept: "application/json" },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);

                if (response.ok) {
                  const markets = await response.json();
                  if (Array.isArray(markets) && markets.length > 0) {
                    const market = markets[0];
                    if (!pos.outcome) {
                      logToFile(
                        "INFO",
                        "Market API response - checking for outcome",
                        {
                          tokenId: shortTokenId,
                          marketKeys: Object.keys(market),
                          hasTokens: !!market.tokens,
                          hasOutcomes: !!market.outcomes,
                          tokensType: Array.isArray(market.tokens)
                            ? "array"
                            : typeof market.tokens,
                          outcomesType: Array.isArray(market.outcomes)
                            ? "array"
                            : typeof market.outcomes,
                        }
                      );
                    }

                    const eventSlug = market.eventSlug;
                    const slug = market.slug || market.id;
                    if (eventSlug) {
                      marketLink = `https://polymarket.com/event/${eventSlug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    } else if (slug) {
                      marketLink = `https://polymarket.com/market/${slug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    } else {
                      logToFile("WARN", "No slug found in market response", {
                        tokenId: shortTokenId,
                        marketFields: Object.keys(market),
                      });
                    }

                    if (!pos.outcome) {
                      if (market.tokens && Array.isArray(market.tokens)) {
                        for (const token of market.tokens) {
                          const tokenIdStr = String(
                            token.token_id || token.asset_id || token.id || ""
                          );
                          if (tokenIdStr === String(tokenId)) {
                            pos.outcome =
                              token.outcome ||
                              token.title ||
                              token.name ||
                              token.label;
                            if (pos.outcome) {
                              paperTradingState.positions[tokenId].outcome =
                                pos.outcome;
                              savePaperTradingState();
                              logToFile(
                                "INFO",
                                "Found outcome from tokens array",
                                {
                                  tokenId: shortTokenId,
                                  outcome: pos.outcome,
                                }
                              );
                              break;
                            }
                          }
                        }
                      }

                      if (
                        !pos.outcome &&
                        market.outcomes &&
                        Array.isArray(market.outcomes)
                      ) {
                        for (const outcomeOption of market.outcomes) {
                          const outcomeTokenId = String(
                            outcomeOption.token_id ||
                              outcomeOption.asset_id ||
                              outcomeOption.id ||
                              ""
                          );
                          if (outcomeTokenId === String(tokenId)) {
                            pos.outcome =
                              outcomeOption.title ||
                              outcomeOption.name ||
                              outcomeOption.outcome ||
                              outcomeOption.label;
                            if (pos.outcome) {
                              paperTradingState.positions[tokenId].outcome =
                                pos.outcome;
                              savePaperTradingState();
                              logToFile(
                                "INFO",
                                "Found outcome from outcomes array",
                                {
                                  tokenId: shortTokenId,
                                  outcome: pos.outcome,
                                }
                              );
                              break;
                            }
                          }
                        }
                      }

                      if (!pos.outcome && clobClient && clobClientReady) {
                        try {
                          const tokenInfo = await clobClient.getTokenInfo(
                            tokenId
                          );
                          if (tokenInfo && tokenInfo.outcome) {
                            pos.outcome = tokenInfo.outcome;
                            paperTradingState.positions[tokenId].outcome =
                              pos.outcome;
                            savePaperTradingState();
                            logToFile("INFO", "Found outcome from CLOB API", {
                              tokenId: shortTokenId,
                              outcome: pos.outcome,
                            });
                          }
                        } catch (error) {}
                      }
                    }
                  }
                }
              }

              if (!marketLink) {
                const assetUrl = `https://data-api.polymarket.com/markets?tokenId=${tokenId}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const assetResponse = await fetch(assetUrl, {
                  headers: { Accept: "application/json" },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);

                if (assetResponse.ok) {
                  const assetMarkets = await assetResponse.json();
                  if (Array.isArray(assetMarkets) && assetMarkets.length > 0) {
                    const market = assetMarkets[0];
                    const eventSlug = market.eventSlug;
                    const slug = market.slug || market.id;
                    if (eventSlug) {
                      marketLink = `https://polymarket.com/event/${eventSlug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    } else if (slug) {
                      marketLink = `https://polymarket.com/market/${slug}`;
                      marketTitle =
                        market.question ||
                        market.title ||
                        market.market ||
                        marketTitle;
                    }

                    if (
                      !pos.outcome &&
                      market.outcomes &&
                      Array.isArray(market.outcomes)
                    ) {
                      for (const outcomeOption of market.outcomes) {
                        if (
                          outcomeOption.token_id === tokenId ||
                          outcomeOption.asset_id === tokenId
                        ) {
                          pos.outcome =
                            outcomeOption.title ||
                            outcomeOption.name ||
                            outcomeOption.outcome;
                          paperTradingState.positions[tokenId].outcome =
                            pos.outcome;
                          savePaperTradingState();
                          break;
                        }
                      }
                    }

                    if (
                      !pos.outcome &&
                      market.tokens &&
                      Array.isArray(market.tokens)
                    ) {
                      for (const token of market.tokens) {
                        if (
                          token.token_id === tokenId ||
                          token.asset_id === tokenId
                        ) {
                          pos.outcome =
                            token.outcome || token.title || token.name;
                          if (pos.outcome) {
                            paperTradingState.positions[tokenId].outcome =
                              pos.outcome;
                            savePaperTradingState();
                          }
                          break;
                        }
                      }
                    }
                  }
                }
              }

              if (!marketLink) {
                const searchTitle = encodeURIComponent(marketTitle);
                marketLink = `https://polymarket.com/search?q=${searchTitle}`;
              }
            }
          } catch (error) {
            logToFile("WARN", "Failed to fetch market info for position", {
              tokenId,
              conditionId: pos.conditionId,
              error: error.message,
            });
            if (!marketLink) {
              const searchTitle = encodeURIComponent(marketTitle);
              marketLink = `https://polymarket.com/search?q=${searchTitle}`;
            }
          }

          const outcomeText = pos.outcome ? ` - ${pos.outcome}` : "";
          const positionText = `${pos.shares.toFixed(
            2
          )} shares @ $${pos.avgPrice.toFixed(4)} ($${pos.entryValue.toFixed(
            2
          )})${outcomeText}`;

          let finalLink = marketLink;
          if (!finalLink) {
            const searchTitle = encodeURIComponent(marketTitle);
            finalLink = `https://polymarket.com/search?q=${searchTitle}`;
          }

          const result = {
            shortTokenId,
            positionText,
            link: finalLink,
            title: marketTitle,
            fullTokenId: tokenId,
            outcome: pos.outcome,
          };

          positionsWithLinks.push(result);
        } catch (error) {
          logToFile("WARN", "Failed to process position", {
            tokenId: tokenId.substring(0, 10) + "...",
            error: error.message,
          });

          const shortTokenId =
            tokenId.length > 20
              ? tokenId.substring(0, 10) +
                "..." +
                tokenId.substring(tokenId.length - 6)
              : tokenId;

          const outcomeText = pos.outcome ? ` - ${pos.outcome}` : "";
          const positionText = `${pos.shares.toFixed(
            2
          )} shares @ $${pos.avgPrice.toFixed(4)} ($${pos.entryValue.toFixed(
            2
          )})${outcomeText}`;

          positionsWithLinks.push({
            shortTokenId,
            positionText,
            link: null,
            title: pos.market || "Unknown",
            fullTokenId: tokenId,
            outcome: pos.outcome,
          });
        }
      }

      const positionsList = positionsWithLinks
        .map((pos) => {
          const marketDisplay = pos.link
            ? `[${pos.title}](${pos.link})`
            : pos.title;
          return `**${pos.shortTokenId}**: ${pos.positionText} - ${marketDisplay}`;
        })
        .join("\n");

      const closedTrades = paperTradingState.tradeHistory.filter(
        (trade) => trade.side === "MANUAL_CLOSE" && trade.pnl !== undefined
      );
      const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
      const losses = closedTrades.filter((trade) => trade.pnl < 0).length;
      const totalClosed = wins + losses;
      const winrate =
        totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(2) : "0.00";

      const embed = {
        title: "📝 Paper Trading Balance",
        color: 0x0099ff,
        fields: [
          {
            name: "💰 Available Balance",
            value: `$${balance.balance.toFixed(2)}`,
            inline: true,
          },
          {
            name: "📊 Total Positions",
            value: `${balance.totalPositions}`,
            inline: true,
          },
          {
            name: "💵 Total Exposure",
            value: `$${balance.totalExposure.toFixed(2)}`,
            inline: true,
          },
          {
            name: "📈 Total Value",
            value: `$${balance.totalValue.toFixed(2)}`,
            inline: true,
          },
          {
            name: "💚 Realized PnL",
            value: `$${
              balance.realizedPnL >= 0 ? "+" : ""
            }${balance.realizedPnL.toFixed(2)}`,
            inline: true,
          },
          {
            name: "📊 Return %",
            value: `${(
              ((balance.totalValue - PAPER_TRADING_INITIAL_BALANCE) /
                PAPER_TRADING_INITIAL_BALANCE) *
              100
            ).toFixed(2)}%`,
            inline: true,
          },
          {
            name: "🎯 Winrate",
            value: `${winrate}% (${wins}W/${losses}L)`,
            inline: true,
          },
        ],
        timestamp: new Date().toISOString(),
      };

      if (positionsList) {
        const MAX_FIELD_LENGTH = 1024;
        let positionsValue = positionsList;
        let displayedCount = positionsWithLinks.length;

        if (positionsList.length > MAX_FIELD_LENGTH) {
          const truncationMessage = `\n\n*... and X more position(s)*`;
          const maxLength = MAX_FIELD_LENGTH - truncationMessage.length;

          let truncated = positionsList.substring(0, maxLength);
          const lastNewline = truncated.lastIndexOf("\n");
          if (lastNewline > 0) {
            truncated = truncated.substring(0, lastNewline);
            displayedCount = (truncated.match(/\*\*/g) || []).length / 2;
          }

          const remainingCount = balance.totalPositions - displayedCount;
          positionsValue =
            truncated + `\n\n*... and ${remainingCount} more position(s)*`;
        }

        embed.fields.push({
          name: "📋 Open Positions",
          value: positionsValue || "None",
          inline: false,
        });
      }

      let retries = 3;
      let sent = false;

      while (retries > 0 && !sent) {
        try {
          await Promise.race([
            message.channel.send({ embeds: [embed] }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Discord send timeout")), 10000)
            ),
          ]);
          sent = true;
        } catch (error) {
          retries--;
          if (retries === 0) {
            logToFile(
              "ERROR",
              "Failed to send paper balance message after retries",
              {
                error: error.message,
                code: error.code,
              }
            );
            try {
              const closedTrades = paperTradingState.tradeHistory.filter(
                (trade) =>
                  trade.side === "MANUAL_CLOSE" && trade.pnl !== undefined
              );
              const wins = closedTrades.filter((trade) => trade.pnl > 0).length;
              const losses = closedTrades.filter(
                (trade) => trade.pnl < 0
              ).length;
              const totalClosed = wins + losses;
              const winrate =
                totalClosed > 0
                  ? ((wins / totalClosed) * 100).toFixed(2)
                  : "0.00";

              await message.channel.send(
                `📝 Paper Trading Balance\n` +
                  `💰 Balance: $${balance.balance.toFixed(2)}\n` +
                  `📊 Positions: ${balance.totalPositions}\n` +
                  `💵 Exposure: $${balance.totalExposure.toFixed(2)}\n` +
                  `💚 PnL: $${
                    balance.realizedPnL >= 0 ? "+" : ""
                  }${balance.realizedPnL.toFixed(2)}\n` +
                  `🎯 Winrate: ${winrate}% (${wins}W/${losses}L)\n` +
                  `\n*Full details unavailable due to connection timeout*`
              );
            } catch (fallbackError) {
              logToFile("ERROR", "Failed to send fallback message", {
                error: fallbackError.message,
              });
            }
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }

      logToFile("INFO", "Paper balance check completed", {
        balance: balance.balance,
        positions: balance.totalPositions,
        realizedPnL: balance.realizedPnL,
      });
    } catch (error) {
      logToFile("ERROR", "Paper balance check failed", {
        error: error.message,
        stack: error.stack,
      });
      await message.channel.send(
        `❌ Error checking paper balance: ${error.message}`
      );
    }
  } else if (contentLower === PAPER_RESET_COMMAND.toLowerCase()) {
    if (!PAPER_TRADING_ENABLED) {
      await message.channel.send(
        "❌ Paper trading is not enabled. Set `PAPER_TRADING_ENABLED=true` in your `.env` file."
      );
      return;
    }

    try {
      resetPaperTrading();
      await message.channel.send({
        embeds: [
          {
            title: "🔄 Paper Trading Reset",
            description: `Paper trading state has been reset to initial balance of $${PAPER_TRADING_INITIAL_BALANCE}.`,
            color: 0x00aa00,
            fields: [
              {
                name: "New Balance",
                value: `$${PAPER_TRADING_INITIAL_BALANCE.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Positions",
                value: "0",
                inline: true,
              },
              {
                name: "Realized PnL",
                value: "$0.00",
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });

      logToFile("INFO", "Paper trading reset by user", {
        newBalance: PAPER_TRADING_INITIAL_BALANCE,
      });
    } catch (error) {
      logToFile("ERROR", "Paper trading reset failed", {
        error: error.message,
        stack: error.stack,
      });
      await message.channel.send(
        `❌ Error resetting paper trading: ${error.message}`
      );
    }
  } else if (contentLower.startsWith(PAPER_CLOSE_COMMAND.toLowerCase())) {
    if (!PAPER_TRADING_ENABLED) {
      await message.channel.send(
        "❌ Paper trading is not enabled. Set `PAPER_TRADING_ENABLED=true` in your `.env` file."
      );
      return;
    }

    const parts = content.split(/\s+/);
    if (parts.length < 2) {
      await message.channel.send(
        `Usage: ${PAPER_CLOSE_COMMAND} <tokenId> [win|loss]\n` +
          `Example: ${PAPER_CLOSE_COMMAND} 8938294144631453...\n` +
          `Example: ${PAPER_CLOSE_COMMAND} 8938294144631453... win\n` +
          `Example: ${PAPER_CLOSE_COMMAND} 8938294144631453... loss\n` +
          `You can use the shortened tokenId from !paperbalance\n` +
          `If market price can't be retrieved, specify "win" (settle at $1.00) or "loss" (settle at $0.00)`
      );
      return;
    }

    const identifier = parts[1];
    const outcomeOverride = parts[2]?.toLowerCase();

    try {
      let positionEntry = null;
      let fullTokenId = null;

      if (paperTradingState.positions[identifier]) {
        positionEntry = [identifier, paperTradingState.positions[identifier]];
        fullTokenId = identifier;
      } else {
        for (const [tokenId, pos] of Object.entries(
          paperTradingState.positions
        )) {
          const shortTokenId =
            tokenId.length > 20
              ? tokenId.substring(0, 10) +
                "..." +
                tokenId.substring(tokenId.length - 6)
              : tokenId;

          if (
            tokenId.includes(identifier) ||
            shortTokenId.includes(identifier)
          ) {
            positionEntry = [tokenId, pos];
            fullTokenId = tokenId;
            break;
          }
        }
      }

      if (!positionEntry) {
        await message.channel.send(
          `❌ Position not found. Use \`${PAPER_BALANCE_COMMAND}\` to see your open positions.`
        );
        return;
      }

      const [tokenId, position] = positionEntry;

      let tokenIdToCheck = tokenId;

      if (position.conditionId && position.outcome) {
        logToFile("INFO", "Verifying tokenId for manual close", {
          storedTokenId: tokenId.substring(0, 10) + "...",
          conditionId: position.conditionId,
          outcome: position.outcome,
        });

        const correctTokenId = await getTokenIdForOutcome(
          position.conditionId,
          position.outcome
        );

        if (correctTokenId && correctTokenId !== tokenId) {
          logToFile(
            "WARN",
            "TokenId mismatch in manual close - using correct tokenId",
            {
              storedTokenId: tokenId.substring(0, 10) + "...",
              correctTokenId: correctTokenId.substring(0, 10) + "...",
              market: position.market,
              outcome: position.outcome,
            }
          );
          tokenIdToCheck = correctTokenId;
        } else if (correctTokenId === tokenId) {
          logToFile("INFO", "TokenId verified for manual close", {
            tokenId: tokenId.substring(0, 10) + "...",
            outcome: position.outcome,
          });
        } else if (!correctTokenId) {
          logToFile("WARN", "Could not verify tokenId - using stored tokenId", {
            tokenId: tokenId.substring(0, 10) + "...",
            conditionId: position.conditionId,
            outcome: position.outcome,
          });
        }
      } else {
        logToFile(
          "WARN",
          "Missing conditionId or outcome for tokenId verification",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            hasConditionId: !!position.conditionId,
            hasOutcome: !!position.outcome,
          }
        );
      }

      await message.channel.send(
        `🔍 Getting current market price for position...`
      );

      const priceResult = await getCurrentMarketPrice(tokenIdToCheck);

      let settlementPrice = null;
      let priceSource = "market";

      if (
        priceResult === null ||
        priceResult.price === undefined ||
        isNaN(priceResult.price)
      ) {
        if (outcomeOverride === "win") {
          settlementPrice = 1.0;
          priceSource = "manual (win)";
          logToFile("INFO", "Using manual win settlement", {
            tokenId: tokenId.substring(0, 10) + "...",
            market: position.market,
            outcome: position.outcome,
          });
        } else if (outcomeOverride === "loss") {
          settlementPrice = 0.0;
          priceSource = "manual (loss)";
          logToFile("INFO", "Using manual loss settlement", {
            tokenId: tokenId.substring(0, 10) + "...",
            market: position.market,
            outcome: position.outcome,
          });
        } else {
          await message.channel.send(
            `❌ Could not get current market price. The market may be closed or inactive.\n` +
              `💡 Tip: You can manually close as win or loss:\n` +
              `   ${PAPER_CLOSE_COMMAND} ${identifier} win  (settles at $1.00)\n` +
              `   ${PAPER_CLOSE_COMMAND} ${identifier} loss (settles at $0.00)`
          );
          return;
        }
      } else {
        const currentPrice = priceResult.price;
        const bestBidSize = priceResult.bestBidSize || 0;

        const entryPrice = position.avgPrice || 0;
        const priceSum = entryPrice + currentPrice;
        const priceChange = Math.abs(currentPrice - entryPrice);

        const isInverted =
          (priceSum > 0.95 && priceSum < 1.05 && priceChange > 0.3) ||
          (entryPrice > 0.5 && currentPrice < 0.1) ||
          (entryPrice < 0.1 && currentPrice > 0.9) ||
          (entryPrice > 0.5 && currentPrice < 0.1 && bestBidSize > 1000);

        settlementPrice = currentPrice;

        if (isInverted) {
          settlementPrice = 1.0 - currentPrice;
          priceSource = "market (inverted)";
          logToFile(
            "WARN",
            "Price inversion detected in manual close - using inverse price",
            {
              tokenId: tokenId.substring(0, 10) + "...",
              outcome: position.outcome,
              entryPrice,
              originalPrice: currentPrice,
              correctedPrice: settlementPrice,
              priceSum,
              priceChange,
              bestBidSize,
              note: "Detected price inversion - using inverse price (1 - original) as we likely got the opposite token's orderbook. Many shares at low price when entry was high confirms wrong token.",
            }
          );
        }
      }
      const pnl = position.shares * (settlementPrice - position.avgPrice);
      const proceeds = position.shares * settlementPrice;

      paperTradingState.balance += proceeds;
      paperTradingState.realizedPnL += pnl;

      paperTradingState.tradeHistory.push({
        timestamp: Date.now(),
        side: "MANUAL_CLOSE",
        tokenId,
        shares: position.shares,
        price: settlementPrice,
        value: proceeds,
        pnl: pnl,
        market: position.market,
      });

      delete paperTradingState.positions[tokenId];
      savePaperTradingState();

      await message.channel.send({
        embeds: [
          {
            title: "✅ Position Manually Closed",
            description: priceSource.includes("manual")
              ? `Position in "${position.market}" has been closed as ${
                  outcomeOverride === "win" ? "WIN" : "LOSS"
                }.`
              : `Position in "${position.market}" has been closed at current market price.`,
            color: pnl >= 0 ? 0x00aa00 : 0xaa0000,
            fields: [
              {
                name: "Shares",
                value: `${position.shares.toFixed(2)}`,
                inline: true,
              },
              {
                name: "Entry Price",
                value: `$${position.avgPrice.toFixed(4)}`,
                inline: true,
              },
              {
                name: "Close Price",
                value: `$${settlementPrice.toFixed(4)} (${(
                  settlementPrice * 100
                ).toFixed(2)}¢)\n*${priceSource}*`,
                inline: true,
              },
              {
                name: "Proceeds",
                value: `$${proceeds.toFixed(2)}`,
                inline: true,
              },
              {
                name: "PnL",
                value: `$${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`,
                inline: true,
              },
              {
                name: "New Balance",
                value: `$${paperTradingState.balance.toFixed(2)}`,
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      });

      logToFile("INFO", "Paper position manually closed", {
        tokenId,
        market: position.market,
        shares: position.shares,
        entryPrice: position.avgPrice,
        closePrice: settlementPrice,
        pnl,
        proceeds,
      });
    } catch (error) {
      logToFile("ERROR", "Failed to close paper position", {
        error: error.message,
        stack: error.stack,
        identifier,
      });
      await message.channel.send(`❌ Error closing position: ${error.message}`);
    }
  }
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(DISCORD_TOKEN);
