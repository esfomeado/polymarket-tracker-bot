# Polymarket Discord Bot

Discord bot that tracks Polymarket wallet activity and can automatically copy trades. Monitors wallet addresses via the Polymarket Data API and sends Discord notifications for new trades. Supports auto-trading, paper trading, and position management.

## Features

- **Wallet Tracking**: Monitor any Polymarket wallet address for BUY/SELL trades
- **Copy Trading**: Automatically copy trades from tracked wallets with configurable filters
- **Paper Trading**: Test strategies without real money
- **Position Management**: Track positions, set per-market limits, and total exposure caps
- **Dynamic Sizing**: Adjusts bet sizes based on tracked wallet trade size and confidence levels
- **WebSocket Support**: Real-time orderbook data for faster execution
- **Stop-Loss Protection**: Automatic stop-loss execution via WebSocket orderbook monitoring for real-time price tracking and instant execution
- **Analysis Tools**: Scripts for win rate analysis and growth projections (see `analysis/` folder)

## Quick Start

1. **Install dependencies**:

   ```bash
   npm install
   ```

2. **Create `.env` file** by copying `env.example`:

   ```bash
   cp env.example .env
   ```

   Then edit `.env` and fill in your configuration values (see `env.example` for full list of options).

3. **Start the bot**:

   ```bash
   npm start
   ```

4. **In Discord**, type `!start` (or `!start <wallet_address>`) to begin monitoring

## Commands

- `!start` - Start monitoring default wallet
- `!start <address>` - Monitor specific wallet
- `!stop` - Stop monitoring
- `!buy <tokenId> <price> <size>` - Place buy order
- `!sell <tokenId> <price> <size>` - Place sell order
- `!balance` - Check USDC balance
- `!paperbalance` - Check paper trading balance
- `!paperreset` - Reset paper trading state

## Configuration

### Core Settings

- `AUTO_TRADE_ENABLED` - Enable auto-trading (default: `false`)
- `COPY_TRADE_ENABLED` - Enable copy trading (default: `true`)
- `AUTO_TRADE_FILTER` - Comma-separated keywords to filter markets (e.g., `BTC,ETH`)
- `AUTO_TRADE_AMOUNT_USD` - Base bet size for small trades (default: `1`)
- `MAX_ORDER_VALUE_USD` - Max bet size when copying large trades (default: `10`)
- `MAX_BET_AMOUNT_PER_MARKET_USD` - Per-market position limit (default: `0` = unlimited)
- `MAX_POSITIONS` - Maximum number of concurrent positions (default: `20`)
- `MAX_TOTAL_EXPOSURE_USD` - Total exposure limit across all positions (default: `0` = unlimited)

### Trading Strategy

- `OPTIMAL_CONFIDENCE_MIN` - Minimum entry price for optimal range (default: `0.6`)
- `OPTIMAL_CONFIDENCE_MAX` - Maximum entry price for optimal range (default: `0.7`)
- `USE_OPTIMAL_CONFIDENCE_FILTER` - Filter trades below optimal minimum (default: `false`)
- `OPTIMAL_CONFIDENCE_BET_MULTIPLIER` - Bet multiplier for optimal range trades (default: `1.5`)
- `ADD_HIGH_CONFIDENCE_ENABLED` - Enable high-confidence adds (80-90%+) (default: `false`)
- `ADD_HIGH_CONFIDENCE_SIZE_USD` - Additional bet size for high-confidence adds (default: `2`)

### Paper Trading

- `PAPER_TRADING_ENABLED` - Enable paper trading mode (default: `false`)
- `PAPER_TRADING_INITIAL_BALANCE` - Starting balance for paper trading (default: `200`)

### WebSocket (Optional but Recommended for Stop-Loss)

- `POLY_WS_API_KEY` - WebSocket API key
- `POLY_WS_API_SECRET` - WebSocket API secret
- `POLY_WS_API_PASSPHRASE` - WebSocket API passphrase

**Note**: WebSocket is required for stop-loss functionality. Stop-loss uses real-time orderbook price updates via WebSocket for instant execution when stop-loss thresholds are reached.

### Stop-Loss Configuration

- `STOP_LOSS_ENABLED` - Enable stop-loss protection (default: `false`)
- `STOP_LOSS_PERCENTAGE` - Stop-loss threshold as percentage loss (e.g., `10` for 10% loss)
- `STOP_LOSS_MIN_TIME_SINCE_ENTRY_MS` - Minimum time in milliseconds before stop-loss can trigger (default: `60000` = 1 minute)
- `STOP_LOSS_WEBSOCKET_MARKET_FILTER` - Optional array of market keywords or condition IDs to monitor (empty array = monitor all positions)

## Project Structure

```
├── services/
│   ├── polling.js          # Main polling loop
│   ├── polling/            # Refactored polling modules
│   │   ├── state.js        # State management
│   │   ├── tradeProcessor.js  # Trade filtering/validation
│   │   ├── autoTrader.js   # Auto-trading logic
│   │   ├── discordEmbeds.js   # Discord message formatting
│   │   └── cleanup.js      # Cleanup tasks
│   ├── marketData.js      # Market data fetching
│   ├── orders.js          # Order placement
│   ├── positions.js       # Position tracking
│   ├── paperTrading.js    # Paper trading logic
│   └── websocketStopLoss.js  # Stop-loss execution via WebSocket
├── websocket/
│   └── orderbookWS.js     # WebSocket orderbook manager for real-time price updates
├── analysis/              # Analysis scripts
│   ├── analyze-wallet.js  # Wallet analysis (configurable)
│   └── compute-growth.js  # Growth projections
└── utils/                 # Utilities
```

## Stop-Loss Functionality

**Stop-loss is now fully operational with WebSocket orderbook monitoring:**

- **Real-time Monitoring**: Uses WebSocket orderbook to monitor price changes in real-time
- **Instant Execution**: Automatically executes market sell orders when stop-loss threshold is reached
- **Position Tracking**: Tracks positions and calculates stop-loss prices based on entry price and configured percentage
- **Market Filtering**: Optional market filter to monitor only specific markets (leave empty to monitor all positions)
- **Automatic Cleanup**: Removes stop-loss monitoring when positions are closed or no longer match filters

**How it works:**

1. When a buy order is executed, a stop-loss position is created with the entry price and stop-loss threshold
2. The bot subscribes to WebSocket orderbook updates for that token
3. When real-time price updates drop below the stop-loss price, a market sell order is automatically executed
4. Stop-loss monitoring is automatically cleaned up after execution or when positions are closed

**Important Note on Exit Price:**

- Stop-loss executes **market orders** which fill at the current best available price
- Due to fast-moving orderbooks and market volatility, the **actual exit price may differ from your stop-loss percentage**
- If the orderbook moves quickly (e.g., during high volatility or low liquidity), you may exit at a worse price than the stop-loss threshold
- The stop-loss triggers when the price reaches your threshold, but actual execution price depends on current market conditions
- Consider this when setting stop-loss percentages, especially for volatile or low-liquidity markets

**Requirements:**

- WebSocket API credentials must be configured (`POLY_WS_API_KEY`, `POLY_WS_API_SECRET`, `POLY_WS_API_PASSPHRASE`)
- `STOP_LOSS_ENABLED` must be set to `true`
- Paper trading mode disables stop-loss (only works with real trading)

### Cloudflare Blocking (Cloud Deployment)

⚠️ **Some cloud hosting providers may experience Cloudflare blocking:**

- Certain cloud providers (Heroku, Railway, some AWS regions, etc.) may have IP addresses that are flagged by Cloudflare
- API requests to Polymarket endpoints may be blocked or rate-limited
- This can cause the bot to fail to fetch market data or place orders

**Note**: **AWS EC2 Europe region** has been tested and works without Cloudflare blocking issues.

**Recommendation**:

- **AWS EC2 Europe(Ireland) region** is recommended for cloud deployment (tested and working)
- **Use the bot on a local machine** to avoid Cloudflare blocking issues entirely
- Consider using a proxy service or VPN for API requests if using other cloud providers
- Monitor API response codes and implement retry logic with exponential backoff

### Dynamic Sizing

⚠️ **Dynamic sizing may still be faulty and is currently for testing:**

- Bet size adjustments based on tracked wallet trade size may not work correctly
- Confidence-based sizing multipliers may not be applied as expected
- Use with caution and verify bet sizes before enabling in production

**Recommendation**: Test dynamic sizing thoroughly in paper trading mode before using with real funds.

### Other Issues

- Limit orders in auto-trading are not fully implemented (only market orders work)
- Some edge cases in position limit checking may allow exceeding limits
- Paper trading balance may drift due to rounding errors over time

## Development

The codebase has been refactored to improve modularity:

- `polling.js` was split into focused modules in `services/polling/`
- Analysis scripts consolidated into configurable tools

## License

ISC
