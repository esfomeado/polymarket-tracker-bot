require("dotenv").config();
const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("@ethersproject/wallet");

const POLYMARKET_PRIVATE_KEY = process.env.POLYMARKET_PRIVATE_KEY;
const POLYMARKET_FUNDER = process.env.POLYMARKET_FUNDER;
const POLYMARKET_SIGNATURE_TYPE = Number(
  process.env.POLYMARKET_SIGNATURE_TYPE ?? 1
);

if (!POLYMARKET_PRIVATE_KEY) {
  console.error("❌ POLYMARKET_PRIVATE_KEY not set in .env file");
  process.exit(1);
}

(async () => {
  try {
    console.log("🔍 Testing Polymarket CLOB API access...");
    console.log("📍 Network: Your current network (home/local)");
    console.log("");

    const host = "https://clob.polymarket.com";
    const chainId = 137;
    const signer = new Wallet(POLYMARKET_PRIVATE_KEY);

    console.log("1. Creating CLOB client...");
    const tempClient = new ClobClient(host, chainId, signer);

    console.log("2. Deriving API credentials...");
    const rawCreds = await tempClient.deriveApiKey();

    const creds = {
      key: rawCreds.apiKey || rawCreds.key,
      secret: rawCreds.secret,
      passphrase: rawCreds.passphrase,
    };

    console.log("3. Initializing CLOB client with credentials...");
    const clobClient = POLYMARKET_FUNDER
      ? new ClobClient(
          host,
          chainId,
          signer,
          creds,
          POLYMARKET_SIGNATURE_TYPE,
          POLYMARKET_FUNDER
        )
      : new ClobClient(host, chainId, signer, creds, 0);

    console.log("4. Testing API access (getting markets)...");
    const markets = await clobClient.getMarkets();

    console.log("");
    console.log("✅ SUCCESS! API is accessible from this network");
    console.log(`   Found ${markets.length} markets`);
    console.log("");
    console.log("📊 Result: This is likely IP-based blocking");
    console.log("   → GCP IPs are being flagged by Cloudflare");
    console.log("   → Your API credentials are working fine");
    console.log("   → Solution: Contact Polymarket to whitelist your GCP IP");
    console.log("              OR use a residential proxy/VPN");
  } catch (error) {
    console.log("");
    console.log("❌ ERROR detected");
    console.log("");

    const errorMsg = error.message || String(error);
    const isCloudflare =
      errorMsg.includes("Cloudflare") ||
      errorMsg.includes("Attention Required") ||
      errorMsg.includes("ERR_HTTP_INVALID_HEADER_VALUE");

    if (isCloudflare) {
      console.log("🚫 Cloudflare block detected!");
      console.log("");
      console.log("📊 Result: Could be either:");
      console.log("   1. IP-based: Your local IP is also flagged");
      console.log("   2. Account-level: Your API key/account is flagged");
      console.log("");
      console.log("💡 To determine which:");
      console.log("   - Try from a mobile hotspot (different IP)");
      console.log("   - Try from the Polymarket website (same account)");
      console.log("   - Contact Polymarket support with your API key");
      console.log("");
      console.log("Error details:");
      console.log(errorMsg.substring(0, 300));
    } else {
      console.log("❌ Other error (not Cloudflare):");
      console.log(errorMsg);
      console.log("");
      console.log("📊 Result: API credentials or network issue");
    }
  }
})();
