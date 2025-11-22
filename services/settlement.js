const fetch = require("node-fetch");
const { PAPER_TRADING_ENABLED } = require("../config");
const { logToFile } = require("../utils/logger");
const {
  getPaperTradingState,
  setPaperTradingState,
} = require("./paperTrading");
const { getTokenIdForOutcome, getCurrentMarketPrice } = require("./marketData");

async function checkAndSettleResolvedMarkets(
  activeChannel,
  orderbookWS,
  clobClient,
  clobClientReady
) {
  if (!PAPER_TRADING_ENABLED || !activeChannel) {
    return;
  }

  const paperTradingState = getPaperTradingState();
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

      const priceResult = await getCurrentMarketPrice(
        tokenIdToCheck,
        orderbookWS,
        clobClient,
        clobClientReady
      );

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
          (priceSum > 0.9 && priceSum < 1.1 && priceChange > 0.3) ||
          (entryPrice > 0.5 && currentPrice < 0.1) ||
          (entryPrice < 0.1 && currentPrice > 0.9) ||
          (entryPrice > 0.5 && currentPrice < 0.1 && bestBidSize > 1000) ||
          (entryPrice > 0.5 && currentPrice > 0.9 && priceChange > 0.3);

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
          setPaperTradingState(paperTradingState);
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
          setPaperTradingState(paperTradingState);
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
                setPaperTradingState(paperTradingState);
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

module.exports = {
  checkAndSettleResolvedMarkets,
};
