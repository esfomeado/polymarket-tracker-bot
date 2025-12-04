const {
  POLL_INTERVAL_MS,
  DEFAULT_WALLET,
  SEND_TRADES_ONLY,
  SEND_ACTIVITY_HISTORY,
  ALERT_ROLE_ID,
  AUTO_TRADE_ENABLED,
  COPY_TRADE_ENABLED,
  COPY_SELL_ORDERS,
  AUTO_TRADE_FILTER,
  PAPER_TRADING_ENABLED,
  MIN_TRACKED_TRADE_SIZE_USD,
  MIN_TRACKED_CONFIDENCE_LEVEL,
  OPTIMAL_CONFIDENCE_MIN,
  OPTIMAL_CONFIDENCE_MAX,
  USE_OPTIMAL_CONFIDENCE_FILTER,
  MAX_BET_AMOUNT_PER_MARKET_USD,
} = require("../config");
const { logToFile } = require("../utils/logger");
const { matchesAutoTradeFilter } = require("../utils/helpers");
const { fetchLatestActivity } = require("./marketData");
const { recordBuyTrade } = require("./positions");
const { getPaperTradingState } = require("./paperTrading");
const { STOP_LOSS_ENABLED } = require("../config");
const { checkAndSettleResolvedMarkets } = require("./settlement");
const { getCurrentPositions } = require("./positions");
const { handleWebSocketStopLoss } = require("./websocketStopLoss");

const pollingState = require("./polling/state");
const discordEmbeds = require("./polling/discordEmbeds");
const tradeProcessor = require("./polling/tradeProcessor");
const cleanup = require("./polling/cleanup");
const autoTrader = require("./polling/autoTrader");

async function pollOnce(
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions
) {
  try {
    if (!pollingState.getActiveChannel()) {
      return;
    }

    if (STOP_LOSS_ENABLED && !PAPER_TRADING_ENABLED && orderbookWS) {
      const {
        getAllStopLossPositions,
        deleteStopLossPosition,
      } = require("./positions");
      await cleanup.cleanupHourlyEvents(
        orderbookWS,
        pollingState.getCurrentWallet(),
        getAllStopLossPositions,
        deleteStopLossPosition
      );
    }

    const activities = await fetchLatestActivity(
      pollingState.getCurrentWallet()
    );

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

    if (!pollingState.getIsInitialized()) {
      trades.forEach((trade) => {
        pollingState.addSeenHash(trade.transactionHash);
      });
      pollingState.setIsInitialized(true);
      return;
    }

    const newTrades = trades.filter(
      (trade) => !pollingState.hasSeenHash(trade.transactionHash)
    );

    if (newTrades.length === 0) {
      return;
    }

    const activeChannel = pollingState.getActiveChannel();
    if (!activeChannel?.isTextBased()) {
      console.error("Active channel is missing or not text-based.");
      return;
    }

    const paperTradingState = getPaperTradingState();

    for (const trade of newTrades.reverse()) {
      pollingState.addSeenHash(trade.transactionHash);

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
        if (SEND_ACTIVITY_HISTORY) {
          await activeChannel.send({
            content: mention || undefined,
            embeds: [embed],
          });
        }

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

        if (
          tradeSide === "BUY" &&
          conditionId &&
          asset &&
          outcome &&
          PAPER_TRADING_ENABLED
        ) {
          recordBuyTrade(conditionId, asset, outcome, price);
        }

        const trackedTradeSize = usdcSize || 0;
        const tradePrice = price || 0;
        const meetsMinTradeSize =
          MIN_TRACKED_TRADE_SIZE_USD === 0 ||
          trackedTradeSize >= MIN_TRACKED_TRADE_SIZE_USD;

        const isOptimalConfidenceRange =
          tradePrice >= OPTIMAL_CONFIDENCE_MIN &&
          tradePrice <= OPTIMAL_CONFIDENCE_MAX;
        const meetsOptimalConfidenceFilter =
          !USE_OPTIMAL_CONFIDENCE_FILTER ||
          tradePrice >= OPTIMAL_CONFIDENCE_MIN;

        let effectiveMinConfidence = MIN_TRACKED_CONFIDENCE_LEVEL;
        if (USE_OPTIMAL_CONFIDENCE_FILTER) {
          effectiveMinConfidence = 0;
        }
        const meetsMinConfidence =
          effectiveMinConfidence === 0 || tradePrice >= effectiveMinConfidence;

        const canCopySellOrder = tradeSide !== "SELL" || COPY_SELL_ORDERS;

        const canAutoTrade =
          AUTO_TRADE_ENABLED &&
          COPY_TRADE_ENABLED &&
          conditionId &&
          canCopySellOrder &&
          matchesAutoTradeFilter(trade) &&
          meetsMinTradeSize &&
          meetsMinConfidence &&
          meetsOptimalConfidenceFilter &&
          (PAPER_TRADING_ENABLED || (clobClient && clobClientReady));

        if (!canAutoTrade && AUTO_TRADE_ENABLED && conditionId) {
          const skipReasons = [];
          if (!COPY_TRADE_ENABLED) {
            skipReasons.push(
              "copy trading disabled (COPY_TRADE_ENABLED=false)"
            );
          }
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
          if (!meetsMinConfidence && !USE_OPTIMAL_CONFIDENCE_FILTER) {
            skipReasons.push(
              `confidence ${(tradePrice * 100).toFixed(1)}% < min ${(
                effectiveMinConfidence * 100
              ).toFixed(1)}%`
            );
          }
          if (!canCopySellOrder) {
            skipReasons.push("SELL orders disabled (COPY_SELL_ORDERS=false)");
          }
          if (!meetsOptimalConfidenceFilter) {
            skipReasons.push(
              `confidence ${(tradePrice * 100).toFixed(
                1
              )}% below optimal minimum ${(
                OPTIMAL_CONFIDENCE_MIN * 100
              ).toFixed(0)}% (trades above ${(
                OPTIMAL_CONFIDENCE_MAX * 100
              ).toFixed(0)}% are still traded)`
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
          try {
            await autoTrader.processAutoTrade(
              trade,
              clobClient,
              clobClientReady,
              orderbookWS,
              pollingState.getActiveChannel(),
              pollingState.getCurrentWallet()
            );
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
                discordEmbeds.createErrorEmbed(
                  "⚠️ Auto-trade Failed",
                  tradeError.message,
                  []
                ),
              ],
            });
          }
          continue;
        } else {
          const skipReason = tradeProcessor.getSkipReasonMessage(
            trade,
            clobClient,
            clobClientReady
          );

          if (
            AUTO_TRADE_ENABLED &&
            clobClient &&
            clobClientReady &&
            conditionId &&
            !tradeProcessor.canAutoTrade(trade, clobClient, clobClientReady)
          ) {
            const skipReasons = tradeProcessor.getSkipReasons(
              trade,
              clobClient,
              clobClientReady
            );
            if (
              skipReasons.length > 0 &&
              skipReasons.includes("filter mismatch")
            ) {
              console.log(
                `Auto-trade skipped: Trade does not match filter "${AUTO_TRADE_FILTER}"`
              );
            }
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

  if (orderbookWS && !PAPER_TRADING_ENABLED) {
    try {
      const {
        getAllStopLossPositions,
        deleteStopLossPosition,
      } = require("./positions");
      const stopLossPositions = getAllStopLossPositions();

      for (const [tokenId, position] of stopLossPositions.entries()) {
        if (!position.conditionId) continue;

        try {
          const marketUrl = `https://data-api.polymarket.com/markets?conditionId=${position.conditionId}`;
          const marketResponse = await fetch(marketUrl, {
            headers: {
              Accept: "application/json",
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            },
          });

          if (marketResponse.ok) {
            const markets = await marketResponse.json();
            if (Array.isArray(markets) && markets.length > 0) {
              const market = markets[0];
              const isResolved =
                market.resolved === true ||
                market.status === "Resolved" ||
                market.status === "Closed" ||
                market.active === false ||
                (market.endDate_iso &&
                  new Date(market.endDate_iso) < new Date());

              if (isResolved) {
                logToFile(
                  "INFO",
                  "Cleaning up resolved market from stop-loss monitoring",
                  {
                    tokenId: tokenId.substring(0, 10) + "...",
                    conditionId: position.conditionId.substring(0, 10) + "...",
                    market: position.market,
                  }
                );
                orderbookWS.unsubscribe(tokenId);
                deleteStopLossPosition(tokenId);
              }
            }
          }
        } catch (marketError) {
          logToFile("WARN", "Error checking market resolution for cleanup", {
            error: marketError.message,
            tokenId: tokenId.substring(0, 10) + "...",
          });
        }
      }
    } catch (cleanupError) {
      logToFile("ERROR", "Error during stop-loss cleanup", {
        error: cleanupError.message,
      });
    }
  }

  if (PAPER_TRADING_ENABLED && pollingState.getIsPolling()) {
    try {
      await checkAndSettleResolvedMarkets(
        clobClient,
        clobClientReady,
        orderbookWS,
        trackedPositions,
        provider,
        signer
      );
    } catch (error) {
      logToFile("ERROR", "Error checking resolved markets", {
        error: error.message,
      });
    }
  }

  if (pollingState.getIsPolling()) {
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
  const timeout = setTimeout(
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
  pollingState.setPollTimeout(timeout);
}

async function startPolling(
  channel,
  walletToUse,
  clobClient,
  clobClientReady,
  orderbookWS,
  trackedPositions,
  provider,
  signer
) {
  if (pollingState.getIsPolling()) {
    const activeChannel = pollingState.getActiveChannel();
    if (activeChannel?.id === channel.id) {
      await channel.send("Polling is already running in this channel.");
      return;
    } else {
      await channel.send(
        "Polling is already running in another channel. Please stop it first."
      );
      return;
    }
  }

  pollingState.setCurrentWallet(walletToUse);
  pollingState.setActiveChannel(channel);
  pollingState.setIsPolling(true);
  pollingState.setIsInitialized(false);
  pollingState.clearSeenHashes();

  if (orderbookWS && STOP_LOSS_ENABLED && !PAPER_TRADING_ENABLED) {
    const { getClobClient } = require("./positions");
    orderbookWS.setStopLossCallback((tokenId, currentPrice, side) => {
      const {
        clobClient: currentClobClient,
        clobClientReady: currentClobClientReady,
      } = getClobClient();
      handleWebSocketStopLoss(
        tokenId,
        currentPrice,
        side,
        currentClobClient,
        currentClobClientReady,
        pollingState.getActiveChannel(),
        orderbookWS
      );
    });
    logToFile("INFO", "WebSocket stop-loss callback registered", {});
  }

  const walletDisplay =
    walletToUse.substring(0, 6) + "..." + walletToUse.substring(38);
  await channel.send(
    `Started monitoring wallet: \`${walletDisplay}\`\nPolling interval: ${POLL_INTERVAL_MS}ms`
  );

  if (MAX_BET_AMOUNT_PER_MARKET_USD > 0 && clobClientReady) {
    try {
      const positions = await getCurrentPositions();
      const positionsByToken = new Map();

      for (const pos of positions) {
        const tokenId = pos.token_id || pos.conditionId || pos.tokenID;
        if (!tokenId) continue;

        const value =
          pos.usdcValue ||
          pos.value ||
          (pos.size && pos.price ? pos.size * pos.price : 0);

        if (positionsByToken.has(tokenId)) {
          positionsByToken.set(
            tokenId,
            positionsByToken.get(tokenId) +
              (typeof value === "number" ? value : 0)
          );
        } else {
          positionsByToken.set(tokenId, typeof value === "number" ? value : 0);
        }
      }

      const cappedPositions = [];
      for (const [tokenId, totalValue] of positionsByToken.entries()) {
        if (totalValue > MAX_BET_AMOUNT_PER_MARKET_USD) {
          cappedPositions.push({
            tokenId: tokenId.substring(0, 10) + "...",
            totalValue: totalValue.toFixed(2),
            maxBetAmount: MAX_BET_AMOUNT_PER_MARKET_USD.toFixed(2),
          });
        }
      }

      if (cappedPositions.length > 0) {
        await channel.send({
          embeds: [
            {
              title: "⚠️ Some Positions Exceed Max Bet Amount",
              description:
                "The following positions exceed the configured max bet amount per market:",
              color: 0xffaa00,
              fields: cappedPositions.map((pos) => ({
                name: `Token: ${pos.tokenId}`,
                value: `$${pos.totalValue} / $${pos.maxBetAmount} max`,
                inline: false,
              })),
              timestamp: new Date().toISOString(),
            },
          ],
        });
      }
    } catch (error) {
      logToFile("ERROR", "Error checking positions on startup", {
        error: error.message,
      });
    }
  }

  await runPollLoop(
    clobClient,
    clobClientReady,
    orderbookWS,
    trackedPositions,
    provider,
    signer
  );
}

async function stopPolling(channel) {
  if (!pollingState.getIsPolling()) {
    await channel.send("Polling is not currently running.");
    return;
  }

  const activeChannel = pollingState.getActiveChannel();
  if (activeChannel?.id && activeChannel.id !== channel.id) {
    await channel.send(
      "Polling is running in a different channel. Please stop it from that channel."
    );
    return;
  }

  pollingState.clearPollTimeout();
  pollingState.setIsPolling(false);
  pollingState.setActiveChannel(null);
  await channel.send("Stopped Polymarket monitoring.");
}

module.exports = {
  pollOnce,
  runPollLoop,
  scheduleNextPoll,
  startPolling,
  stopPolling,
  getPollingState: pollingState.getPollingState,
  setPollingState: pollingState.setPollingState,
  clearPollTimeout: pollingState.clearPollTimeout,
  setPollTimeout: pollingState.setPollTimeout,
  getActiveChannel: pollingState.getActiveChannel,
  getCurrentWallet: pollingState.getCurrentWallet,
  getIsPolling: pollingState.getIsPolling,
};
