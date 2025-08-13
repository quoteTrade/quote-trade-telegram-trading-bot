import {fCurrency} from "./utils/format-number";

require('dotenv').config();

import {
  CommandSetAuthKeys,
  ExampleSetAuthKeys,
  inline_keyboard_for_main_menu,
  inline_keyboard_for_back_main_menu,
  inline_keyboard_for_main_menu_after_success_auth,
  inline_keyboard_for_set_trade_keys_wizard,
  TipSetAuthKeys,
  CommandLogin,
  ExampleLogin,
  TipLogin,
  inline_keyboard_for_set_login_wallet_wizard,
  inline_keyboard_for_login_wallet,
  inline_keyboard_for_set_deposit_funds_wizard,
  TipDeposit,
  CommandDeposit,
  ExampleDeposit,
  inline_keyboard_get_positions,
  inline_keyboard_for_set_trade_keys,
  inline_keyboard_price_trade,
  inline_keyboard_exit_wizard,
  inline_keyboard_stake_unstake,
  TipWithdraw,
  inline_keyboard_for_withdraw_funds_wizard,
  CommandWithdraw,
  ExampleWithdraw,
} from "./constant/messageV2";

import {BotSvc} from './bot.service';
import {NetworkMap} from "./constant/block-chain-info";
import {DepositToken, StakingOptionsMap, WithdrawToken} from "./constant/utils";
import {deleteUserState, setUserState} from "./utils/user-states.service";
import {deleteAuth, getAuth, setAuth} from "./utils/auth.service";

export function escapeMarkdownV2(text: string) {
  return text.replace(/[[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

export function escapeAllMarkdownV2(text: string) {
  return text.replace(/[[\]()~`>#+\-=|{}.!*_]/g, '\\$&');
}

export function removeAuthorization(chatId: any) {
  deleteAuth(chatId);
}

export async function sendProcessingMessage(bot: any, chatId: any) {
  const loadingTexts = [
    '⏳ Please wait...',
    '🔄 Processing Your Request...',
    '🛠️ Working on it...',
    '🚀 Almost there...'
  ];

  bot.sendMessage(chatId, `${loadingTexts[0]}`, { parse_mode: "Markdown" }).then();
}

export async function sendUnauthorizedMessage(bot: any, chatId: any) {
  const MessagesArray = [
    `🚫 *Access denied: You must be authorized to \\[Quote\\.Trade Bot\\]\\!*`,
    `\n\n`,
    `🔓 *__To gain access, follow one of the methods below:__*\n\n`,
    `🔐 *Set Trade API Keys* \\(Recommended for Trading Accounts\\)\n`,
    `🔑 *Log In with Your Wallet* \\(Authenticate using your wallet credentials\\. This is only needed if you are using the Bot to auto\\-deposit\\)\n\n`,
    `Try it now\\! 🚀`,
  ];

  await bot.sendMessage(
      chatId,
      `${MessagesArray.join(``)}`, {
        reply_markup: {
          inline_keyboard: [
            [inline_keyboard_for_set_trade_keys, inline_keyboard_for_login_wallet],
            [inline_keyboard_for_back_main_menu]
          ]
        },
        parse_mode: "MarkdownV2",
      },
  );
}

export async function sendAuthorizedMessage(bot: any, chatId: any) {
  const MessagesArray = [
    `✅ *Successfully authenticated to \\[Quote\\.Trade\\] Bot\\!* 🔓`,
  ];

  await bot.sendMessage(chatId, `${MessagesArray.join(``)}`, { parse_mode: "MarkdownV2" });
}

export async function sendErrorMessage(bot: any, chatId: any, message: string) {
  await bot.sendMessage(
      chatId,
      message, {
        reply_markup: {
          inline_keyboard: [inline_keyboard_for_back_main_menu]
        },
        parse_mode: "Markdown",
      },
  );
}

export async function sendMainMenu(bot: any, chatId: any) {
  const auth: any = getAuth(chatId);
  let inline_keyboard = [];

  if (!auth?.requestToken) {
    inline_keyboard = inline_keyboard_for_main_menu;
  } else {
    inline_keyboard = inline_keyboard_for_main_menu_after_success_auth;
  }

  await bot.sendMessage(
      chatId,
      '🏠 *[Select a Quote.Trade Option]* - Try it now! 🚀', {
        reply_markup: {
          inline_keyboard: inline_keyboard
        },
        parse_mode: "Markdown",
      },
  );
}

export async function sendSetTradeKeysInstructions(bot: any, chatId: any) {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Instructions to Set Your Trade Keys!*__`),
      `\n\n`,
      escapeMarkdownV2(`💡 *Tip:* ${TipSetAuthKeys}\n\n`),
      `💬 *Set your trade keys by sending a command or using the wizard\\!*\n\n`,
      escapeMarkdownV2(`📌 *Command:* `),
      `${CommandSetAuthKeys}\n`,
      escapeMarkdownV2(`📝 *e.g.,: *`),
      `${escapeAllMarkdownV2(ExampleSetAuthKeys)}\n\n`,
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [ inline_keyboard_for_set_trade_keys_wizard ],
              [ inline_keyboard_for_back_main_menu ]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Error: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function setTradeKeys(bot: any, chatId: any, API_KEY: string, API_SECRET: string) {
  try {
    const auth = {
      requestToken: API_KEY,
      requestSecret: API_SECRET,
    };
    setAuth(chatId, auth);

    await sendMainMenu(bot, chatId);
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Error: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function sendLoginWalletInstructions(bot: any, chatId: any) {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Instructions to login with your wallet!*__`),
      `\n\n`,
      escapeMarkdownV2(`💡 *Tip:* ${TipLogin}\n\n`),
      `💬 *Login with your wallet by sending a command or using the wizard\\!*\n\n`,
      escapeMarkdownV2(`📌 *Command:* `),
      `${CommandLogin}\n`,
      escapeMarkdownV2(`📝 *e.g.,: *`),
      `${escapeAllMarkdownV2(ExampleLogin)}\n\n`,
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [ inline_keyboard_for_set_login_wallet_wizard ],
              [ inline_keyboard_for_back_main_menu ]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Error: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function login(bot: any, chatId: any, WALLET_ADDRESS: string, PRIVATE_KEY: string) {
  try {
    await sendProcessingMessage(bot, chatId);

    const auth = await BotSvc.authorization(WALLET_ADDRESS, PRIVATE_KEY);
    if (auth.id) {
      auth.walletAddress = WALLET_ADDRESS;
      auth.privateKey = PRIVATE_KEY;
      setAuth(chatId, auth);

      await sendAuthorizedMessage(bot, chatId);
      await sendMainMenu(bot, chatId);
    } else {
      await bot.sendMessage(chatId, `❌ Failed to authenticate!, try again`);
    }
  } catch (error: any) {
    console.error(error);
    await bot.sendMessage(chatId, `❌ Failed: ${error?.error ?? (error?.message ?? 'Unknown error')}`);
  }
}

export async function sendAvailableTickersList(bot: any, chatId: any, pageNumber: number = 1): Promise<void> {
  try {
    const pageSize = 20;  // Example: page size 20
    const skip = (pageNumber - 1) * pageSize;
    const limit = pageSize;

    sendProcessingMessage(bot, chatId).then();

    let {symbolsList, totalNumberOfRecodes}: any = await BotSvc.getSymbolsList(skip, limit);

    const SymbolsMessage = [];
    for (let i = 0; i < (symbolsList ?? []).length ; i++) {
      SymbolsMessage.push(`    🔹\`${escapeAllMarkdownV2(symbolsList[i].symbol)}\` \\- ${escapeMarkdownV2(symbolsList[i].name)} \n`)
    }

    if (symbolsList.length <= 0) {
      await bot.sendMessage(chatId, "⚠️ Not available symbols. Please try again later.").then();
      return;
    }

    const numberOfPages = Math.ceil(totalNumberOfRecodes/pageSize);

    const MessagesArray = [
      escapeMarkdownV2(`__📜 *Available Tickers*__\n\n`),
      `${SymbolsMessage.join('')}`,
      `\n\n`,
      escapeMarkdownV2(`▪️ *Current Page Number : ${pageNumber}*\n`),
      escapeMarkdownV2(`▪️ *Total Number of Tickers : ${totalNumberOfRecodes}*\n`),
      escapeMarkdownV2(`▪️ *Number of pages : ${numberOfPages}*\n\n`),
      escapeMarkdownV2(`💬 *You can view more users by clicking the page buttons, one page at a time.*\n\n`),
    ];

    const inline_keyboard = [];

    const page_break = 4;
    for (let i = 1; i <= numberOfPages; i += page_break) {
      const chunk: any[] = [];

      for (let j = i; j < i + page_break && j <= numberOfPages; j++) {
        chunk.push({ text: `📑 PAGE-${j}`, callback_data: `tickers_page|${j}` });
      }

      inline_keyboard.push(chunk);
    }
    inline_keyboard.push([ inline_keyboard_for_back_main_menu ]);

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: inline_keyboard
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Unable to fetch symbols: ${error?.error ?? (error?.message ?? 'Unknown error')}`);
  }
}

export async function sendAvailablePositions(bot: any, chatId: any): Promise<void> {
  const auth = getAuth(chatId);

  try {
    if (!auth?.requestToken) {
      sendUnauthorizedMessage(bot, chatId).then()
      return;
    }

    sendProcessingMessage(bot, chatId).then();

    let positions: any = await BotSvc.getPositions(auth);
    // console.log(positions)

    if (positions.length <= 0) {
      await bot.sendMessage(chatId, "⚠️ Not available symbols. Please try again later.").then();
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__📊 *Your Positions* 💰__\n\n`),
    ];

    (positions).forEach((item: any) => {
      MessagesArray.push(
          `🔹*${escapeAllMarkdownV2(item.symbol)}* \n*Size\\:* ${escapeAllMarkdownV2(item.quantity)} \\| *Value \\(USD\\)\\:* ${escapeAllMarkdownV2(fCurrency(item.usdValue))}\n`,
      );
    });

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Unable to fetch positions: ${error?.error ?? (error?.message ?? 'UNKNOWN_ERROR')}`);
  }
}

export async function sendDepositFundsInstructions(bot: any, chatId: any): Promise<void> {
  const auth = getAuth(chatId);

  try {
    sendProcessingMessage(bot, chatId).then();
    let depositInfo: any = await BotSvc.getDepositAddress();
    // console.log(depositInfo)

    if (!depositInfo.address) {
      await sendErrorMessage(bot, chatId, "🚫 Couldn't fetch deposit address. Please try again later.").then();
      return;
    }

    const depositNetwork = process.env.DEPOSIT_BLOCKCHAIN_NETWORK as string;
    const chainInfo: any = NetworkMap[depositNetwork] ?? {};

    let inline_keyboard = [];

    const MessagesArray = [
      escapeMarkdownV2(`__💸 *Deposit Funds Instructions!* 💰__\n\n`),
      escapeMarkdownV2(`💬 You can deposit *USDC* or *USDT* on the *${chainInfo.name} network* using the address below:\n\n`),
      `${escapeMarkdownV2('🔖 *Deposit Address* (📋 Long-press to copy) *:*')}\`${depositInfo.address}\`\n\n`,
      escapeMarkdownV2(`⚠️ *Important:*\n`),
      escapeMarkdownV2(`- Only send *USDC* or *USDT* (Ethereum ERC-20).\n`),
      escapeMarkdownV2(`- Sending any other asset may result in loss.\n`),
      escapeMarkdownV2(`- Ensure you send funds from a wallet you control.\n\n`),
      escapeMarkdownV2(`💬 Once deposited, your positions will update automatically after a few minutes.\n\n`),
      escapeMarkdownV2(`*--or--* \n\n`),
      escapeMarkdownV2(`💬 You can *auto-deposit* from your wallet using the following commands: \n\n`),
    ];

    if (!auth?.walletAddress) {
      MessagesArray.push(escapeMarkdownV2(`1️⃣ First, 🔑 *Log In with Your Wallet:* \n\n`));
      MessagesArray.push(escapeMarkdownV2(`💬 Authenticate using your wallet credentials. This is only needed if you are using the Bot to auto-deposit \n\n`));
      MessagesArray.push(escapeMarkdownV2(`2️⃣ Then, 💸 *Deposit your amount:*\n\n`));
      inline_keyboard = [inline_keyboard_for_login_wallet];
    } else {
      MessagesArray.push(escapeMarkdownV2(`💸 *Deposit Funds:*\n\n`));
      inline_keyboard = [inline_keyboard_for_set_deposit_funds_wizard];

      MessagesArray.push(escapeMarkdownV2(`💡 *Tip:* ${TipDeposit}\n\n`));
      MessagesArray.push(escapeMarkdownV2(`💬 *Deposit Funds by sending a command or using the wizard!*\n\n`));
      MessagesArray.push(escapeMarkdownV2(`📌 *Command:* `));
      MessagesArray.push( `${CommandDeposit}\n`);
      MessagesArray.push(escapeMarkdownV2(`📝 *e.g.,: *`));
      MessagesArray.push(`${escapeAllMarkdownV2(ExampleDeposit)}\n\n`);
    }

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              inline_keyboard,
              [inline_keyboard_for_back_main_menu],
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Error: ${error?.error || (error?.message || 'Unknown error')}`);
  }
}

export async function deposit(bot: any, chatId: any, depositToken: string, depositAmount: number): Promise<void> {
  const auth = getAuth(chatId);

  if (!auth?.walletAddress) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    let depositInfo: any = await BotSvc.getDepositAddress();

    if (!depositInfo.address) {
      await sendErrorMessage(bot, chatId, "🚫 Couldn't fetch deposit address. Please try again later.");
      return;
    }

    if (!DepositToken.includes(depositToken.toUpperCase())) {
      await sendErrorMessage(bot, chatId, "🚫 Invalid deposit token. Please again later.");
      return;
    }

    const depositNetwork = process.env.DEPOSIT_BLOCKCHAIN_NETWORK as string;
    const chainInfo: any = NetworkMap[depositNetwork] ?? {};

    const trxHash = await BotSvc.deposit(chainInfo, auth?.walletAddress, auth?.privateKey, depositToken.toUpperCase(), depositAmount, depositInfo.address);

    const MessagesArray = [
      escapeMarkdownV2(`🎯 *Deposit Confirmed!*\n\n`),
      `${escapeMarkdownV2('💠 *Token:*')} ${depositToken.toUpperCase()}\n`,
      `${escapeMarkdownV2('📈 *Amount:*')} ${escapeAllMarkdownV2(String(depositAmount))}\n`,
      `${escapeMarkdownV2('#️⃣ *Transaction Hash:*')} \`${escapeAllMarkdownV2(trxHash)}\`\n`,
      `\n`,
      escapeMarkdownV2(`🔔 _Your deposit has been placed successfully!_`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu],
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Failed: ${error?.error ?? (error?.message ?? 'Unknown error')}`);
  }
}

export async function withdrawFundsInstructions(bot: any, chatId: any) {
  const auth = getAuth(chatId);

  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🏦 *Instructions to Withdraw Funds!* 💰__`),
      `\n\n`,
    ];

    let inline_keyboard = [];

    MessagesArray.push(escapeMarkdownV2(`💡 *Tip:* ${TipWithdraw}\n\n`));
    MessagesArray.push(escapeMarkdownV2(`💬 *You can withdraw funds using a command or through the wizard flow!*\n\n`));

    if (!auth?.requestToken) {
      MessagesArray.push(escapeMarkdownV2(`1️⃣ First, 🔐 *Set Trade Keys* \n\n`));
      MessagesArray.push(escapeMarkdownV2(`2️⃣ Then, 🏦 *Withdraw Funds*\n\n`));
      inline_keyboard = [inline_keyboard_for_set_trade_keys, inline_keyboard_for_login_wallet];
    } else {
      inline_keyboard = [inline_keyboard_for_withdraw_funds_wizard];
      MessagesArray.push(escapeMarkdownV2(`📌 *Command:* `));
      MessagesArray.push( `${CommandWithdraw}\n`);
      MessagesArray.push(escapeMarkdownV2(`📝 *e.g.,: *`));
      MessagesArray.push(`${escapeAllMarkdownV2(ExampleWithdraw)}\n\n`);
    }

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              inline_keyboard,
              [ inline_keyboard_for_back_main_menu ]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Error: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function withdraw(bot: any, chatId: any, withdrawToken: string, withdrawAmount: number): Promise<void> {
  const auth = getAuth(chatId);

  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }
  if (!WithdrawToken.includes(withdrawToken)) {
    await sendErrorMessage(bot, chatId, "🚫 Invalid withdraw token. Please again.");
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    await BotSvc.withdraw({
      "token": withdrawToken,
      "account": auth.id,
      "side": "BUY",
      "quantity": withdrawAmount,
      "toAddress": auth?.walletAddress,
    }, auth);

    const MessagesArray = [
      escapeMarkdownV2(`🎯 *Withdraw Confirmed!*\n\n`),
      `${escapeMarkdownV2('💠 *Token:*')} ${withdrawToken.toUpperCase()}\n`,
      `${escapeMarkdownV2('📈 *Amount:*')} ${escapeAllMarkdownV2(String(withdrawAmount))}\n`,
      `${escapeMarkdownV2('📃 To Address:*')} \`${escapeAllMarkdownV2(auth?.walletAddress || '')}\`\n`,
      `\n`,
      escapeMarkdownV2(`🔔 _Your withdraw has been placed successfully!_\n\n`),
      escapeMarkdownV2(`💬 _There may be a delay of up to 24 hours for withdrawals on new accounts_`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu],
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.error ?? (error?.message ?? 'Unknown error')}`);
  }
}

export async function sendRemoveAuthorization(bot: any, chatId: any) {
  try {
    const MessagesArray = [
      `🔒 *Authorization Removed*\n\n`,
      `💬 Your trading authorization has been successfully revoked. You can no longer place trades, deposit, or stake funds.\n`,
    ];

    deleteAuth(chatId);
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [...inline_keyboard_for_main_menu]
          },
          parse_mode: "Markdown",
        },
    );
  } catch (error: any) {
    console.error(error);
  }
}

export async function sendPriceAndTradeInstructions(bot: any, chatId: any): Promise<void> {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__📚 *How Price & Trade Work*__\n\n`),
      escapeMarkdownV2(`💬 _Before placing an order, please ensure your account has sufficient funds. If not, use the *Deposit Funds* option to top up your balance before proceeding._\n\n`),

      escapeMarkdownV2(`💵 *Check Price & Trade*\n\n`),
      escapeMarkdownV2(`📌 _To check Buy/Sell prices by symbol & quantity:_\n\n`),
      escapeMarkdownV2(`👉 Step 1: Tap the *Check Price & Trade* button.\n`),
      escapeMarkdownV2(`👉 Step 2: Enter the *crypto asset symbol* (refer to the Ticker list).\n`),
      escapeMarkdownV2(`👉 Step 3: Enter the trade *quantity*.\n`),
      escapeMarkdownV2(`👉 Step 4: Choose *Buy* or *Sell* to go long or short at the quoted price.\n`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_price_trade],
              [inline_keyboard_for_back_main_menu],
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Error: ${error?.error || (error?.message || 'Unknown error')}`);
  }
}

export async function checkPrice(bot: any, chatId: any, symbol: string, quantity: number) {
  try {
    await sendProcessingMessage(bot, chatId);

    let matchingPrice: any = await BotSvc.getMatchingPrice(symbol, quantity);

    let BuyingMessage = [
      `🟢 *Buying price per ${escapeAllMarkdownV2(symbol)} = ${fCurrency(matchingPrice.ask.p)}*\n`,
      `💲 *Total cost for ${quantity} ${escapeAllMarkdownV2(symbol)} = ${fCurrency(matchingPrice.ask.p * quantity)}*`,
    ];
    let SellingMessage = [
      `🔴 *Selling price per ${escapeAllMarkdownV2(symbol)} = ${fCurrency(matchingPrice.bid.p)}*\n`,
      `💲 *Total cost for ${quantity} ${escapeAllMarkdownV2(symbol)} = ${fCurrency(matchingPrice.bid.p * quantity)}*`,
    ];

    const inline_keyboard_for_buy = [];
    const inline_keyboard_for_sell = [];

    if (!matchingPrice?.ask?.p) {
      BuyingMessage = [`🟢 *The buying price does not match the selected quantity.* 😔\n`];
    } else {
      inline_keyboard_for_buy.push({ text: `🟢 BUY ${quantity} ${symbol} @ ${fCurrency(matchingPrice.ask.p)}`, callback_data: `buy|${symbol}|${quantity}` })
    }
    if (!matchingPrice?.bid?.p) {
      SellingMessage = [`🔴 *The selling price does not match the selected quantity.* 😔\n`];
    } else {
      inline_keyboard_for_sell.push({ text: `🔴 SELL ${quantity} ${symbol} @ ${fCurrency(matchingPrice.bid.p)}`, callback_data: `sell|${symbol}|${quantity}` });
    }

    const inline_keyboard_btn = [
      { text: `🔄 Refresh Price for ${quantity} ${symbol}`, callback_data: `refresh_price|${symbol}|${quantity}` },
      inline_keyboard_price_trade
    ];

    const MessagesArray = [
      `__💵 *Wizard: Check Price & Trade!*__\n\n`,
      `_🎯 *Matching Price for ${quantity} ${escapeAllMarkdownV2(symbol)}*_\n\n`,
      `${BuyingMessage.join(``)}`,
      `\n\n`,
      `${SellingMessage.join(``)}`,
      `\n\n`,
      '🎯 *[Pick a trade option to continue]*',
    ];

    const inline_keyboard = [];

    if (inline_keyboard_for_buy.length > 0) {
      inline_keyboard.push(inline_keyboard_for_buy);
    }
    if (inline_keyboard_for_sell.length > 0) {
      inline_keyboard.push(inline_keyboard_for_sell);
    }

    inline_keyboard.push(inline_keyboard_btn);
    inline_keyboard.push([inline_keyboard_exit_wizard]);

    await bot.sendMessage(
        chatId,
        `${escapeMarkdownV2(MessagesArray.join(``))}`, {
          reply_markup: {
            inline_keyboard: inline_keyboard
          },
          parse_mode: "MarkdownV2",
        },
    );

  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function buy(bot: any, chatId: any, symbol: string, quantity: number) {
  const auth = getAuth(chatId);

  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    await BotSvc.placeOrder({
      "account": auth.id,
      "symbol": symbol,
      "side": "BUY",
      "quantity": Number(quantity),
      // "price": parseFloat(price),
      "type": "MARKET",
      "paymentCurrency": 'USD'
    }, auth);

    const MessagesArray = [
      `🎯 *Trade Submitted!*  \n\n`,
      `💠 *Symbol:* ${escapeAllMarkdownV2(symbol)}\n`,
      `📈 *Quantity:* ${quantity}\n`,
      `\n\n`,
      `🔔 _Your *BUY* order has been placed successfully!_`,
    ];

    await bot.sendMessage(
        chatId,
        `${escapeMarkdownV2(MessagesArray.join(``))}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    console.error(error);
    await bot.sendMessage(chatId, `❌ Buy Failed: ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
  }
}

export async function sell(bot: any, chatId: any, symbol: string, quantity: number) {
  const auth = getAuth(chatId);
  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    await BotSvc.placeOrder({
      "account": auth.id,
      "symbol": symbol,
      "side": "SELL",
      "quantity": Number(quantity),
      // "price": parseFloat(price),
      "type": "MARKET",
      "paymentCurrency": 'USD'
    }, auth);

    const MessagesArray = [
      `🎯 *Trade Submitted!*  \n\n`,
      `💠 *Symbol:* ${escapeAllMarkdownV2(symbol)}\n`,
      `📈 *Quantity:* ${quantity}\n`,
      `\n\n`,
      `🔔 _Your *SELL* order has been placed successfully!_`,
    ];

    await bot.sendMessage(
        chatId,
        `${escapeMarkdownV2(MessagesArray.join(``))}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    console.error(error);
    await bot.sendMessage(chatId, `❌ Sell Failed: ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
  }
}

export async function sendStakingInstructions(bot: any, chatId: any) {
  try {
    let MessagesArray = [
      escapeMarkdownV2(`📚 __*Staking Instructions*__`),
      `\n\n`,
    ];

    const MessagesArray2 = [
      escapeMarkdownV2(`🌟 __*Stake*__\n\n`),
      escapeMarkdownV2(`📌 _You can stake *USDC* or *USDT* symbols if you have an available position._\n\n`),
      escapeMarkdownV2(`👉 Step 1: Select a stake symbol.\n`),
      escapeMarkdownV2(`👉 Step 2: Select a stake option.\n`),
      escapeMarkdownV2(`👉 Step 3: Enter the stake quantity.\n\n`),
      escapeMarkdownV2(`📃 *List of Stake Options:*\n\n`),
      `🔹 *${escapeAllMarkdownV2('24_HOUR')}*${escapeMarkdownV2(' → 24-Hour Lockup (Current Rate: *5%*)')} \n`,
      `🔹 *${escapeAllMarkdownV2('06_MONTH')}*${escapeMarkdownV2( '→ 6-Month Lockup (*Up to 20% APR*, *Min 5% Guaranteed*')} \n`,
      `🔹 *${escapeAllMarkdownV2('12_MONTH')}*${escapeMarkdownV2( '→ 12-Month Lockup (*Up to 30% APR*, *Min 5.5% Guaranteed*')} \n`,
      `🔹 *${escapeAllMarkdownV2('18_MONTH')}*${escapeMarkdownV2( '→ 18-Month Lockup (*Up to 40% APR*, *Min 6% Guaranteed*')} \n`,
      `\n\n`,
      escapeMarkdownV2(`🌟 __*Unstake*__\n\n`),
      `📌 _You can unstake *${escapeAllMarkdownV2('STAKE_USDC_24H')}* or *${escapeAllMarkdownV2('STAKE_USDT_24H')}* symbols if you have an available position\\._\n\n`,
      escapeMarkdownV2(`👉 Step 1: Select a unstake symbol.\n`),
      escapeMarkdownV2(`👉 Step 3: Enter the unstake quantity.\n\n`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}${MessagesArray2.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions, inline_keyboard_stake_unstake],
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Error: ${error?.error ?? (error?.message ?? 'UNKNOWN_ERROR')}`);
  }
}

export async function stake(bot: any, chatId: any, option: string, symbol: string, quantity: number) {
  const auth = getAuth(chatId);
  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    const optionId: number = StakingOptionsMap[option].value;

    await BotSvc.placeOrder({
      "account": auth.id,
      "symbol": symbol,
      "side": "BUY",
      "quantity": Number(quantity),
      // "price": parseFloat(price),
      "type": "LIMIT",
      "stake": 1,
      "stakeOption": optionId,
    }, auth);

    const MessagesArray = [
      escapeMarkdownV2(`🎯 *Stake Confirmed!*  \n\n`),
      `${escapeMarkdownV2('💠 *Symbol:*')} ${escapeAllMarkdownV2(symbol)}\n`,
      `${escapeMarkdownV2('🔹 *Option:* ')}${escapeAllMarkdownV2(option)}\n`,
      escapeMarkdownV2(`📈 *Quantity:* ${quantity}\n\n`),
      escapeMarkdownV2(`🔔 _Your *Stake* order has been placed successfully!_`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    console.error(error);
    await bot.sendMessage(chatId, `❌ Stake Failed: ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
  }
}

export async function unstake(bot: any, chatId: any, symbol: string, quantity: number) {
  const auth = getAuth(chatId);
  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    await BotSvc.placeOrder({
      "account": auth.id,
      "symbol": symbol,
      "side": "SELL",
      "quantity": quantity,
      // "price": parseFloat(price),
      "type": "LIMIT",
      "stake": 1,
    }, auth);

    const MessagesArray = [
      escapeMarkdownV2(`🎯 *Un-stake Confirmed!*  \n\n`),
      `${escapeMarkdownV2('💠 *Symbol:*')} ${escapeAllMarkdownV2(symbol)}\n`,
      escapeMarkdownV2(`📈 *Quantity:* ${quantity}\n\n`),
      escapeMarkdownV2(`🔔 _Your *Unstake* order has been placed successfully!_`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Failed: ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
  }
}

export async function sendSwappingInstructions(bot: any, chatId: any) {
  const auth = getAuth(chatId);
  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    let MessagesArray = [
      escapeMarkdownV2(`🔁 __*Swapping*__ 💰`),
      `\n\n`,
      escapeMarkdownV2(`👉 Step 1: Choose your preferred swap option from the available list.\n`),
      escapeMarkdownV2(`👉 Step 2: Enter the quantity you want to swap.\n`),
      escapeMarkdownV2(`👉 Step 3: Confirm.\n`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '➡️ SWAP USD to USDC', callback_data: 'swap_symbol|USD|USDC' },
                { text: '➡️ SWAP USDC to USD', callback_data: 'swap_symbol|USDC|USD' },
              ],
              [
                { text: '➡️ SWAP USD to USDT', callback_data: 'swap_symbol|USD|USDT' },
                { text: '➡️ SWAP USDT to USD', callback_data: 'swap_symbol|USDT|USD' },
              ],
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Error: ${error?.error ?? (error?.message ?? 'UNKNOWN_ERROR')}`);
  }
}

export async function swap(bot: any, chatId: any, fromSymbol: string, toSymbol: string, side: string, symbol: string, quantity: number) {
  const auth = getAuth(chatId);
  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);

    await BotSvc.placeOrder({
      "account": auth.id,
      "symbol": symbol,
      "side": side,
      "quantity": quantity,
      "type": "MARKET",
      "paymentCurrency": 'USD',
    }, auth);

    const MessagesArray = [
      escapeMarkdownV2(`🎯 *SWAP ${fromSymbol} to ${toSymbol} Confirmed!*  \n\n`),
      `${escapeMarkdownV2('💠 *Swap Symbol:*')} ${escapeAllMarkdownV2(fromSymbol)}\n`,
      escapeMarkdownV2(`📈 *Swap Quantity:* ${quantity}\n\n`),
      escapeMarkdownV2(`🔔 _Your *Swap* order has been placed successfully!_`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_get_positions],
              [inline_keyboard_for_back_main_menu]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Failed: ${error?.error || (error?.message || 'UNKNOWN_ERROR')}`);
  }
}