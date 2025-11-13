module.exports = {
  apps: [
    {
      name: "polymarket-discord-bot",
      script: "index.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
