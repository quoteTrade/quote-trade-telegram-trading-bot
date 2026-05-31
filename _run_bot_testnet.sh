#!/bin/bash

#pm2 start dist/bot.js --name "qt-telegram-bot"
echo "🔄 Pulling latest changes..."
git pull

echo "📦 Installing dependencies..."
npm i

echo "🛠️ Building project..."
npm run build

echo "🚀 Restarting bot..."
pm2 restart "qt-telegram-bot" --update-env

# Check if the last command failed
if [ $? -ne 0 ]; then
  echo "⚠️ Bot not found, starting new instance..."
  pm2 start "dist/bot.js" --name "qt-telegram-bot"
else
  echo "✅ Bot restarted successfully!"
fi

echo "✅ Done!"