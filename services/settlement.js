const fetch = require("node-fetch");
const {
  PAPER_TRADING_ENABLED,
  STOP_LOSS_ENABLED,
  STOP_LOSS_PERCENTAGE,
  STOP_LOSS_CHECK_INTERVAL_MS,
} = require("../config");
const { logToFile } = require("../utils/logger");
const {
  getPaperTradingState,
  setPaperTradingState,
  paperSell,
} = require("./paperTrading");
const { getTokenIdForOutcome, getCurrentMarketPrice } = require("./marketData");

async function checkStopLossForRealPositions(
  activeChannel,
  orderbookWS,
  clobClient,
  clobClientReady,
  getCurrentPositions,
  placeMarketSellOrder,
  provider,
  signer
) {
  if (!STOP_LOSS_ENABLED || !clobClient || !clobClientReady || !activeChannel) {
    return;
  }

  try {
    const positions = await getCurrentPositions();
    if (!Array.isArray(positions) || positions.length === 0) {
      return;
    }

    const now = Date.now();
    const stopLossThreshold = STOP_LOSS_PERCENTAGE / 100;

    for (const pos of positions) {
      const tokenId = pos.token_id || pos.conditionId || pos.tokenID;
      if (!tokenId) continue;

      const lastChecked = pos.lastChecked || 0;
      const checkInterval = Math.min(STOP_LOSS_CHECK_INTERVAL_MS, 300000);
      if (now - lastChecked < checkInterval) {
        continue;
      }

      try {
        const priceResult = await getCurrentMarketPrice(
          tokenId,
          orderbookWS,
          clobClient,
          clobClientReady
        );

        if (
          !priceResult ||
          priceResult.price === undefined ||
          isNaN(priceResult.price) ||
          priceResult.price < 0 ||
          priceResult.price > 1
        ) {
          continue;
        }

        const currentPrice = priceResult.price;
        const entryPrice =
          pos.avgPrice || pos.price || pos.cost / (pos.shares || 1);
        const shares = pos.shares || pos.size || 0;

        if (entryPrice <= 0 || shares <= 0) {
          continue;
        }

        const lossPercentage = ((entryPrice - currentPrice) / entryPrice) * 100;
        const stopLossPrice = entryPrice * (1 - stopLossThreshold);

        if (
          currentPrice <= stopLossPrice &&
          lossPercentage >= STOP_LOSS_PERCENTAGE
        ) {
          logToFile("WARN", "Stop-loss triggered for real position", {
            tokenId: tokenId.substring(0, 10) + "...",
            entryPrice,
            currentPrice,
            lossPercentage: lossPercentage.toFixed(2),
            shares,
            stopLossThreshold: STOP_LOSS_PERCENTAGE,
          });

          try {
            const stopLossPrice = entryPrice * (1 - stopLossThreshold);

            const { placeSellOrder } = require("./orders");
            const sellResult = await placeSellOrder(
              tokenId,
              stopLossPrice,
              shares,
              "GTC",
              clobClient,
              clobClientReady
            );

            if (sellResult && !sellResult.error) {
              await activeChannel.send({
                embeds: [
                  {
                    title: "🛑 Stop-Loss Triggered (Real Trading)",
                    description: `Position hit stop-loss threshold (${lossPercentage.toFixed(
                      1
                    )}% loss). Limit order placed at stop-loss price.`,
                    color: 0xff6600,
                    fields: [
                      {
                        name: "Shares Sold",
                        value: `${shares.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Entry Price",
                        value: `$${entryPrice.toFixed(4)} (${(
                          entryPrice * 100
                        ).toFixed(1)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Stop-Loss Price",
                        value: `$${stopLossPrice.toFixed(4)} (${(
                          stopLossPrice * 100
                        ).toFixed(2)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Current Market",
                        value: `$${currentPrice.toFixed(4)} (${(
                          currentPrice * 100
                        ).toFixed(2)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Loss %",
                        value: `${lossPercentage.toFixed(1)}%`,
                        inline: true,
                      },
                      {
                        name: "Order Type",
                        value: "Limit Order",
                        inline: true,
                      },
                      {
                        name: "Order ID",
                        value: sellResult.orderId || "Pending",
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });

              logToFile("INFO", "Real position stop-loss executed", {
                tokenId,
                entryPrice,
                exitPrice: stopLossPrice,
                lossPercentage,
                shares,
                orderId: sellResult.orderId,
              });
            } else {
              logToFile(
                "ERROR",
                "Failed to execute stop-loss sell for real position",
                {
                  tokenId,
                  error: sellResult?.error || "Unknown error",
                }
              );
            }
          } catch (sellError) {
            logToFile("ERROR", "Exception executing stop-loss sell", {
              tokenId,
              error: sellError.message,
            });
          }
        }
      } catch (error) {
        logToFile("WARN", "Failed to check stop-loss for position", {
          tokenId,
          error: error.message,
        });
      }
    }
  } catch (error) {
    logToFile("ERROR", "Failed to check stop-loss for real positions", {
      error: error.message,
    });
  }
}

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

  const checkInterval = STOP_LOSS_ENABLED
    ? Math.min(STOP_LOSS_CHECK_INTERVAL_MS, 300000)
    : 300000;

  for (const [tokenId, position] of positionsToCheck) {
    if (position.lastChecked && now - position.lastChecked < checkInterval) {
      continue;
    }

    try {
      let tokenIdToCheck = tokenId;
      let correctTokenId = null;
      let tokenIdVerified = false;

      if (position.conditionId && position.outcome) {
        logToFile("INFO", "Verifying tokenId for auto-close check", {
          storedTokenId: tokenId.substring(0, 10) + "...",
          conditionId: position.conditionId,
          outcome: position.outcome,
        });

        correctTokenId = await getTokenIdForOutcome(
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
          tokenIdVerified = true;
        } else if (correctTokenId === tokenId) {
          logToFile("INFO", "TokenId verified - matches outcome", {
            tokenId: tokenId.substring(0, 10) + "...",
            outcome: position.outcome,
          });
          tokenIdVerified = true;
        } else if (!correctTokenId) {
          logToFile("WARN", "Could not find correct tokenId for outcome", {
            tokenId: tokenId.substring(0, 10) + "...",
            conditionId: position.conditionId,
            outcome: position.outcome,
            note: "Cannot verify tokenId - will skip stop-loss check to avoid checking wrong token.",
          });
          tokenIdVerified = false;
        }
      } else {
        logToFile(
          "WARN",
          "Missing conditionId or outcome for tokenId verification",
          {
            tokenId: tokenId.substring(0, 10) + "...",
            hasConditionId: !!position.conditionId,
            hasOutcome: !!position.outcome,
            note: "Cannot verify tokenId - will skip stop-loss check to avoid checking wrong token",
          }
        );
        tokenIdVerified = false;
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
        logToFile("INFO", "Checking position price", {
          tokenId: tokenId.substring(0, 10) + "...",
          market: position.market,
          outcome: position.outcome,
          currentPrice,
          bestBidSize,
          entryPrice: position.avgPrice,
        });

        const entryPrice = position.avgPrice || 0;

        position.lastChecked = now;

        const mightBeWrongToken =
          (entryPrice > 0.5 && currentPrice < 0.05) ||
          (entryPrice < 0.1 && currentPrice > 0.9);

        const lossPercentage =
          entryPrice > 0 ? ((entryPrice - currentPrice) / entryPrice) * 100 : 0;

        const indicatesClearLoss =
          entryPrice > 0.3 && currentPrice < 0.1 && lossPercentage > 50;
        const indicatesExtremeLoss =
          entryPrice > 0.3 && currentPrice < 0.1 && lossPercentage > 80;

        const canCheckStopLoss =
          tokenIdVerified ||
          indicatesExtremeLoss ||
          (indicatesClearLoss && !mightBeWrongToken) ||
          (!mightBeWrongToken && currentPrice > 0.05 && currentPrice < 0.95);

        if (
          STOP_LOSS_ENABLED &&
          entryPrice > 0 &&
          !position.stopLossPending &&
          canCheckStopLoss
        ) {
          const priceToCheck = currentPrice;
          const lossPercentage =
            ((entryPrice - priceToCheck) / entryPrice) * 100;
          const stopLossThreshold = STOP_LOSS_PERCENTAGE;

          const isWinning = priceToCheck > 0.9 || priceToCheck >= entryPrice;

          const requiredThreshold = tokenIdVerified
            ? stopLossThreshold
            : stopLossThreshold * 1.5;

          const isSignificantLoss =
            priceToCheck < entryPrice && lossPercentage >= requiredThreshold;

          logToFile("INFO", "Checking stop-loss for position", {
            tokenId: tokenId.substring(0, 10) + "...",
            tokenIdToCheck:
              tokenIdToCheck !== tokenId
                ? tokenIdToCheck.substring(0, 10) + "..."
                : tokenId.substring(0, 10) + "...",
            market: position.market,
            outcome: position.outcome,
            entryPrice,
            currentPrice: priceToCheck,
            lossPercentage: lossPercentage.toFixed(2),
            stopLossThreshold,
            requiredThreshold,
            tokenIdVerified,
            mightBeWrongToken,
            indicatesClearLoss,
            isWinning,
            isSignificantLoss,
            willTrigger: isSignificantLoss && !isWinning,
          });

          if (isSignificantLoss && !isWinning) {
            position.stopLossPending = true;
            setPaperTradingState(paperTradingState);

            const stopLossPrice = entryPrice * (1 - stopLossThreshold / 100);
            const actualSellPrice = stopLossPrice;

            logToFile("WARN", "Stop-loss triggered for paper position", {
              tokenId: tokenId.substring(0, 10) + "...",
              market: position.market,
              outcome: position.outcome,
              entryPrice,
              currentPrice: priceToCheck,
              stopLossPrice,
              actualSellPrice,
              orderType: "LIMIT (at stop-loss price)",
              lossPercentage: lossPercentage.toFixed(2),
              stopLossThreshold,
              note: "Placing limit order at stop-loss price",
            });
            const sharesBeforeSell = position.shares;

            const sellResult = await paperSell(
              tokenId,
              sharesBeforeSell,
              actualSellPrice,
              position.market
            );

            if (sellResult && !sellResult.error) {
              const sharesSold = sellResult.shares || sharesBeforeSell;
              const proceeds =
                sellResult.proceeds || sharesSold * actualSellPrice;
              const pnl =
                sellResult.pnl || (actualSellPrice - entryPrice) * sharesSold;

              const tradeHistory = paperTradingState.tradeHistory;
              const lastTrade = tradeHistory[tradeHistory.length - 1];
              if (
                lastTrade &&
                lastTrade.tokenId === tokenId &&
                lastTrade.side === "SELL"
              ) {
                lastTrade.side = "STOP_LOSS";
                lastTrade.stopLossTriggered = true;
                lastTrade.lossPercentage = lossPercentage;
              }

              await activeChannel.send({
                embeds: [
                  {
                    title: "🛑 Stop-Loss Triggered",
                    description: `Position in "${
                      position.market
                    }" hit stop-loss threshold (${lossPercentage.toFixed(
                      1
                    )}% loss). Position automatically sold at stop-loss price.`,
                    color: 0xff6600,
                    fields: [
                      {
                        name: "Shares Sold",
                        value: `${sharesSold.toFixed(2)}`,
                        inline: true,
                      },
                      {
                        name: "Entry Price",
                        value: `$${entryPrice.toFixed(4)} (${(
                          entryPrice * 100
                        ).toFixed(1)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Exit Price",
                        value: `$${actualSellPrice.toFixed(4)} (${(
                          actualSellPrice * 100
                        ).toFixed(2)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Stop-Loss Price",
                        value: `$${stopLossPrice.toFixed(4)} (${(
                          stopLossPrice * 100
                        ).toFixed(2)}¢)`,
                        inline: true,
                      },
                      {
                        name: "Order Type",
                        value: "Limit Order",
                        inline: true,
                      },
                      {
                        name: "Loss %",
                        value: `${lossPercentage.toFixed(1)}%`,
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
                        value: `$${
                          sellResult.balance ||
                          paperTradingState.balance.toFixed(2)
                        }`,
                        inline: true,
                      },
                    ],
                    timestamp: new Date().toISOString(),
                  },
                ],
              });

              logToFile("INFO", "Paper position stop-loss executed", {
                tokenId,
                market: position.market,
                shares: position.shares,
                entryPrice,
                exitPrice: stopLossPrice,
                lossPercentage,
                pnl,
                proceeds,
              });

              delete paperTradingState.positions[tokenId];
              setPaperTradingState(paperTradingState);
              continue;
            } else {
              logToFile("ERROR", "Failed to execute stop-loss sell", {
                tokenId,
                error: sellResult?.error || "Unknown error",
              });
            }
          }
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
  checkStopLossForRealPositions,
};
