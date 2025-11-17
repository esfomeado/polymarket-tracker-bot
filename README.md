# Polymarket Wallet Activity Discord Bot

This bot polls the Polymarket Data API for wallet addresses and posts notifications in Discord whenever new **BUY** or **SELL** trades are detected. The polling cadence stays well under the documented rate limit of 200 requests per 10 seconds (1,200 requests per minute) for the public Data API ([Polymarket docs](https://docs.polymarket.com/quickstart/introduction/rate-limits?utm_source=openai)).

## Setup

1. Create a Discord bot in the [Discord Developer Portal](https://discord.com/developers/applications), add it to your server, and copy the bot token.
2. Clone or copy this project and install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the project root:
   ```bash
   DISCORD_TOKEN=your-bot-token
   POLL_INTERVAL_MS=15000
   COMMAND_PREFIX=!
   POLYMARKET_PRIVATE_KEY=your-private-key
   POLYMARKET_FUNDER=your-proxy-address
   POLYMARKET_SIGNATURE_TYPE=1
   AUTO_TRADE_ENABLED=false
   AUTO_TRADE_FILTER=NBA
   AUTO_TRADE_AMOUNT_USD=1
   AUTO_TRADE_USE_MARKET=false
   ```
   - `POLL_INTERVAL_MS` defaults to 15000 (15 seconds) if omitted. Do not set it below 5000 to avoid spamming the API.
   - `COMMAND_PREFIX` defaults to `!` if omitted.
   - `POLYMARKET_PRIVATE_KEY` (optional): Your Ethereum private key for placing orders via CLOB API. Required for order placement features.
   - `POLYMARKET_FUNDER` (optional): Your Polymarket Proxy address if using email/magic or browser wallet login. Leave empty for direct EOA trading.
   - `POLYMARKET_SIGNATURE_TYPE` (optional): `1` for email/magic login, `2` for browser wallet. Defaults to `1`.
   - `AUTO_TRADE_ENABLED` (optional): Set to `true` to automatically place orders when tracking wallet trades. Defaults to `false`.
   - `AUTO_TRADE_FILTER` (optional): Comma-separated keywords to filter which markets to auto-trade. Only trades matching these keywords will trigger auto-trading. Example: `NBA,NFL` or `NBA`. Leave empty to auto-trade all markets.
   - `AUTO_TRADE_AMOUNT_USD` (optional): Dollar amount per auto-trade position. Defaults to `1` ($1 per position).
   - `AUTO_TRADE_USE_MARKET` (optional): Set to `true` to use market orders (immediate execution). Defaults to `false` (uses limit orders at exact entry price).
   - In the Discord Developer Portal, enable the **Message Content Intent** so the bot can detect channel commands.
4. Start the bot:
   ```bash
   npm start
   ```

## How It Works

- The bot polls `https://data-api.polymarket.com/activity` for the specified wallet and filters entries with `type === "TRADE"` and `side === "BUY"` or `side === "SELL"`.
- Post `!start` (or your configured prefix) in any text channel the bot can read to begin polling with the default wallet address.
- Post `!start <wallet_address>` to monitor a specific wallet address (e.g., `!start 0x2005d16a84ceefa912d4e380cd32e7ff827875ea`).
- Post `!stop` to pause polling. Only one channel is monitored at a time, and new `!start` commands will move it.
- Trade hashes are cached in-memory so each Discord notification is only sent once per process run.
- Markets are cached by `conditionId` to prevent duplicate notifications for the same market, even if there are multiple trades.
- On the first poll after starting, the cache is seeded but no messages are emitted; only _new_ trades trigger messages.
- Each message includes the trade type (BUY/SELL), market title, selected outcome, price, notional size in shares and USDC, timestamp, Polygonscan link, and Polymarket market link.

## Commands

### Wallet Tracking

- `!start` - Starts monitoring with the default wallet address (`0x0f37cb80dee49d55b5f6d9e595d52591d6371410`)
- `!start <wallet_address>` - Starts monitoring for a specific wallet address (must be a valid Ethereum address)
- `!stop` - Stops monitoring

### Order Placement (requires POLYMARKET_PRIVATE_KEY)

- `!buy <tokenId> <price> <size> [orderType]` - Places a buy order
  - Example: `!buy 71321045679252212594626385532706912750332728571942532289631379312455583992563 0.5 100 GTC`
  - Order types: `GTC` (Good-Til-Cancelled), `GTD` (Good-Til-Date), `FOK` (Fill-Or-Kill)
- `!sell <tokenId> <price> <size> [orderType]` - Places a sell order
  - Example: `!sell 71321045679252212594626385532706912750332728571942532289631379312455583992563 0.5 100 GTC`
  - Order types: `GTC` (Good-Til-Cancelled), `GTD` (Good-Til-Date), `FOK` (Fill-Or-Kill)

**Note:** To find token IDs, use the [Polymarket Markets API](https://docs.polymarket.com/developers/gamma-markets-api/get-markets) or check the market page URL.

## Order Placement Features

The bot supports placing buy and sell orders on Polymarket using the [CLOB API](https://docs.polymarket.com/developers/CLOB/orders/create-order).

### Setup for Order Placement

1. **Get your private key**: Export from [reveal.polymarket.com](https://reveal.polymarket.com) or your Web3 wallet
2. **Set environment variables**:
   - `POLYMARKET_PRIVATE_KEY`: Your Ethereum private key (required)
   - `POLYMARKET_FUNDER`: Your Polymarket Proxy address (if using email/magic or browser wallet)
   - `POLYMARKET_SIGNATURE_TYPE`: `1` for email/magic, `2` for browser wallet (default: `1`)
3. **Auto-trading**: Set `AUTO_TRADE_ENABLED=true` to automatically place orders when tracking wallet trades

### Auto-Trading

When `AUTO_TRADE_ENABLED=true` and a tracked wallet makes a trade, the bot will automatically place a matching order:

- If the tracked wallet **BUYs**, the bot places a **BUY** order
- If the tracked wallet **SELLs**, the bot places a **SELL** order

**Filtering**: Use `AUTO_TRADE_FILTER` to only auto-trade specific markets:

- `AUTO_TRADE_FILTER=NBA` - Only auto-trade NBA markets
- `AUTO_TRADE_FILTER=NBA,NFL` - Auto-trade NBA or NFL markets
- Leave empty to auto-trade all markets

The filter checks market title, slug, event slug, and outcome for the specified keywords (case-insensitive).

**Position Size**: Use `AUTO_TRADE_AMOUNT_USD` to set the dollar amount per position:

- `AUTO_TRADE_AMOUNT_USD=1` - Trade $1 per position (default)
- `AUTO_TRADE_AMOUNT_USD=5` - Trade $5 per position
- The bot calculates shares as: `shares = USD / price`

**Order Type**:

- **Limit Orders (default)**: Uses the **exact entry price** from the tracked wallet trade. Your order will be placed at the same price the tracked wallet entered at.
  - Set `AUTO_TRADE_USE_MARKET=false` or leave it unset
  - Example: If tracked wallet buys at 0.45, your order is placed at 0.45
- **Market Orders**: Executes immediately at current market price (may differ from tracked wallet's entry price)
  - Set `AUTO_TRADE_USE_MARKET=true`
  - Faster execution but price may vary

**⚠️ Warning**: Auto-trading can result in financial losses. Use with caution and ensure you have sufficient balance.

## Notes

- Restarting the bot will reset the in-memory cache. During startup it suppresses notifications for the most recent 25 activities (the API response size) to prevent duplicate alerts.
- The bot prevents duplicate notifications for the same market by caching market `conditionId` values. If multiple trades occur for the same market, only the first one will trigger a notification.
- For longer history or persistence across restarts, extend the bot to store transaction hashes in a database or file.
- Consider running the bot with a process manager like `pm2` or `systemd` for reliability.
- Order placement requires sufficient USDC balance in your Polymarket account.
