# Ethereum Key Generator + Balance Checker

## Overview
Node.js command-line tool that generates random Ethereum private keys, derives public addresses, and checks those addresses for ETH balance across multiple RPC endpoints. If a funded wallet is found, it logs credentials to `funded.txt` and sends a Telegram notification.

## File Structure

| File | Fungsi |
|---|---|
| `index.js` | Master process — spawn workers, dashboard, all-time stats |
| `worker.js` | Worker process — generate wallet + check balance loop |
| `rpc-manager.js` | Shared RPC pool management |
| `check-balances.js` | Standalone tool — cek balance dari `hits.txt` |

## Running

```bash
# Default (2 workers)
node index.js

# Custom worker count
node index.js -c 4

# Check balances from hits.txt
node check-balances.js
node check-balances.js -c 500   # batch size
```

## Generated Files (Runtime)

| File | Isi |
|---|---|
| `funded.txt` | Wallet dengan balance ditemukan |
| `session.log` | Log lengkap semua sesi (tanpa warna ANSI) |
| `checker_stats.json` | Statistik all-time (total dicek, jumlah sesi) |
| `rpc_state.json` | State pool RPC (latency) — persist antar restart |
| `dead_rpcs.json` | RPC yang dihapus permanen — tidak akan dicoba lagi |

## RPC Manager Features
- **Smart scoring** — RPC diurutkan berdasarkan latency + error count
- **Permanent removal** — RPC dengan 8+ error berturut-turut dihapus permanen dan disimpan ke `dead_rpcs.json`
- **State persistence** — Latency pool disimpan ke `rpc_state.json` setiap 60 detik
- **Auto-discovery** — Setiap 5 menit probe 20 endpoint publik Ethereum baru
- **Auto-recovery** — Setiap 2 jam coba lagi RPC yang sudah mati permanen
- **Concurrent-safe benchmark** — Mutex flag mencegah double-benchmark

## Monitoring (index.js)
- Stats line setiap 5 detik: uptime, checked, rate instan, avg rate, RPC alive/dead, funded
- Extended summary setiap 50 detik: all-time total, session count
- Worker error dan exit dilaporkan ke log
- Semua output juga ditulis ke `session.log` (tanpa warna)
- Graceful shutdown (SIGTERM/SIGINT) simpan stats sebelum keluar

## Optional Environment Variables
- `TELEGRAM_BOT_TOKEN` — Token bot Telegram
- `TELEGRAM_CHAT_ID` — Chat ID untuk notifikasi wallet funded

## Dependencies
- `ethereum-cryptography` — secp256k1 + keccak256
- `ethers` v6 — format ETH value
- `commander` — CLI argument parsing
- `colors` — colorized output
