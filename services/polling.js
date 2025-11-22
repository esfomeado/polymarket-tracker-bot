const {
  POLL_INTERVAL_MS,
  DEFAULT_WALLET,
  SEND_TRADES_ONLY,
  ALERT_ROLE_ID,
  AUTO_TRADE_ENABLED,
  AUTO_TRADE_FILTER,
  AUTO_TRADE_USE_MARKET,
  PAPER_TRADING_ENABLED,
  MIN_TRACKED_TRADE_SIZE_USD,
  MIN_TRACKED_CONFIDENCE_LEVEL,
  HIGH_CONFIDENCE_THRESHOLD_USD,
  LOW_CONFIDENCE_THRESHOLD_USD,
  MAX_BET_AMOUNT_PER_MARKET_USD,
  MAX_ORDER_VALUE_USD,
  MAX_POSITIONS,
  MAX_TOTAL_EXPOSURE_USD,
  START_COMMAND,
  STOP_COMMAND,
} = require("../config");
const { logToFile } = require("../utils/logger");
const {
  isValidWalletAddress,
  matchesAutoTradeFilter,
} = require("../utils/helpers");
const {
  fetchLatestActivity,
  getTrackedWalletPosition,
} = require("./marketData");
const {
  getPositionValueForToken,
  checkPositionLimits,
  setTrackedPosition,
  deleteTrackedPosition,
} = require("./positions");
const { paperBuy, paperSell, getPaperTradingState } = require("./paperTrading");
const {
  placeBuyOrder,
  placeSellOrder,
  placeMarketBuyOrder,
  placeMarketSellOrder,
} = require("./orders");
const { checkAndSettleResolvedMarkets } = require("./settlement");

let isPolling = false;
let pollTimeout = null;
let activeChannel = null;
let currentWallet = null;
let isInitialized = false;
const seenHashes = new Set();

function getPollingState() {
  return {
    isPolling,
    pollTimeout,
    activeChannel,
    currentWallet,
    isInitialized,
    seenHashes: new Set(seenHashes),
  };
}

function setPollingState(state) {
  isPolling = state.isPolling;
  pollTimeout = state.pollTimeout;
  activeChannel = state.activeChannel;
  currentWallet = state.currentWallet;
  isInitialized = state.isInitialized;
  if (state.seenHashes) {
    seenHashes.clear();
    state.seenHashes.forEach((hash) => seenHashes.add(hash));
  }
}

function clearPollTimeout() {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}

function setPollTimeout(timeout) {
  pollTimeout = timeout;
}

async function pollOnce(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions
) {
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

    const paperTradingState = getPaperTradingState();

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
                    setTrackedPosition(tokenId, {
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
                  orderPrice,
                  clobClient,
                  clobClientReady,
                  orderbookWS
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
                  setTrackedPosition(tokenId, {
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
                  setTrackedPosition(tokenId, {
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
                    deleteTrackedPosition(tokenId);
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
                  orderPrice,
                  clobClient,
                  clobClientReady,
                  orderbookWS,
                  null,
                  null
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
                  deleteTrackedPosition(tokenId);
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
                  deleteTrackedPosition(tokenId);
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
                    setTrackedPosition(tokenId, {
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
                  orderSize,
                  require("@polymarket/clob-client").OrderType.GTC,
                  clobClient,
                  clobClientReady
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
                  setTrackedPosition(tokenId, {
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
                  setTrackedPosition(tokenId, {
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
                    deleteTrackedPosition(tokenId);
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
                  orderSize,
                  require("@polymarket/clob-client").OrderType.GTC,
                  clobClient,
                  clobClientReady
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
                  deleteTrackedPosition(tokenId);
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
                  deleteTrackedPosition(tokenId);
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

async function runPollLoop(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
  await pollOnce(clobClient, clobClientReady, orderbookWS, trackedPositions);

  if (PAPER_TRADING_ENABLED && isPolling) {
    try {
      await checkAndSettleResolvedMarkets(
        activeChannel,
        orderbookWS,
        clobClient,
        clobClientReady
      );
    } catch (error) {
      logToFile("ERROR", "Failed to check resolved markets", {
        error: error.message,
      });
    }
  }

  if (isPolling) {
    scheduleNextPoll(
      clobClient,
      clobClientReady,
      orderbookWS,
      trackedPositions,
      provider,
      signer
    );
  }
}

function scheduleNextPoll(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
  pollTimeout = setTimeout(
    () =>
      runPollLoop(
        clobClient,
        clobClientReady,
        orderbookWS,
        trackedPositions,
        provider,
        signer
      ),
    POLL_INTERVAL_MS
  );
}

async function startPolling(
  channel,
  walletAddress,
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
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
  seenHashes.clear();

  const walletDisplay =
    walletToUse === DEFAULT_WALLET
      ? `default wallet (${DEFAULT_WALLET})`
      : walletToUse;

  await channel.send(
    `Starting Polymarket monitoring for ${walletDisplay} with interval ${
      POLL_INTERVAL_MS / 1000
    }s.`
  );

  await pollOnce(clobClient, clobClientReady, orderbookWS, trackedPositions);
  scheduleNextPoll(
    clobClient,
    clobClientReady,
    orderbookWS,
    trackedPositions,
    provider,
    signer
  );
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

  clearPollTimeout();
  isPolling = false;
  activeChannel = null;
  await channel.send("Stopped Polymarket monitoring.");
}

function getActiveChannel() {
  return activeChannel;
}

function getCurrentWallet() {
  return currentWallet;
}

function getIsPolling() {
  return isPolling;
}

module.exports = {
  pollOnce,
  runPollLoop,
  scheduleNextPoll,
  startPolling,
  stopPolling,
  getPollingState,
  setPollingState,
  clearPollTimeout,
  setPollTimeout,
  getActiveChannel,
  getCurrentWallet,
  getIsPolling,
};
