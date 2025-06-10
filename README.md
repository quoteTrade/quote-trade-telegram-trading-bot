# Quote Trade Telegram Bot With Client API
This is a **Node.js & TypeScript** Telegram bot that allows users to trade directly from Telegram.

## 🚀 Features

- Place trade orders using simple commands.
- Get real-time price updates.
- Fetch a list of supported trading symbols.

## 📌 Prerequisites

- Install **Node.js** (v18+ recommended)
- Install **npm** or **yarn**
- Get a **Telegram Bot Token** from [BotFather](https://t.me/BotFather)

## 🔧 Installation

Clone the repository and install dependencies:

```sh
git clone https://github.com/quoteTrade/quote-trade-telegram-trading-bot.git
cd quote-trade-telegram-trading-bot
npm install
```

## Installation
```sh
npm install
```

## ⚙️ Configuration

Create a `.env` file from `sample.env` and add your bot token:

```sh
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
API_BASE_URL=https://your-api-url.com
LIQUIDITY_WS_URL=wss://your-api-url.com
```

## 🚀 Running the Bot

To build and start the bot, use:

```sh
npm run build
npm start
```

## 🎮 Quick Demo

Start using the bot on Telegram: 👉 [Development Bot](https://t.me/Quote_Trade_bot) 
## 📝 Commands

- **Start Bot:** `/start`

## 🤖 WebSocket Price Feed

This bot fetches real-time price updates from the backend WebSocket. When a user requests a price, it subscribes to the WebSocket and sends the latest price back to the user.

## 📌 Notes

- Maximum **10 symbols** per request for `/symbols`.
- Make sure your backend API is running and accessible.

## 🛠️ Development

For development mode with hot-reloading:

```sh
npm run dev
```

## 📄 License

This project is licensed under the MIT License.
