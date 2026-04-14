# Ethereum Key Generator + Balance Checker

## Overview
A Node.js command-line tool that generates random Ethereum private keys, derives their corresponding public addresses, and checks those addresses for ETH balance across multiple RPC endpoints. If a funded wallet is found, it logs the credentials to `funded.txt` and optionally sends a Telegram notification.

## Architecture
- **`index.js`**: Main entry point. Spawns worker processes and displays a real-time dashboard showing uptime, check rate, and funded wallets.
- **`worker.js`**: Worker process logic. Generates wallets in batches, checks balances via JSON-RPC, and reports results back to the master process.
- **`check-balances.js`**: Standalone utility to check balances of addresses from `hits.txt`.

## Running
```bash
node index.js
# or with custom worker count:
node index.js -c 4
```

## Dependencies
- `ethereum-cryptography` - secp256k1 key generation and keccak256 hashing
- `ethers` - ETH value formatting
- `commander` - CLI argument parsing
- `colors` - Colorized terminal output
- `log-update` - Live dashboard rendering

## Optional Environment Variables
- `TELEGRAM_BOT_TOKEN` - Telegram bot token for funded wallet notifications
- `TELEGRAM_CHAT_ID` - Telegram chat ID for notifications

## Output Files
- `funded.txt` - Stores address, private key, and balance of any found wallets
- `hits.txt` - Input for `check-balances.js`

## Workflow
- **Start application**: `node index.js` (console output)
