import {inline_keyboard_for_back_main_menu, inline_keyboard_start} from "./constant/messageV2";

require('dotenv').config();
import TelegramBot from 'node-telegram-bot-api';
import {
  AvailableAllCommands,
  CommandPrice,
  CommandSetAuthKeys,
  CommandAuthorization,
  CommandBuy,
  CommandSell,
  CommandDeposit,
  CommandStaking,
  CommandWithdraw,
} from "./constant/message";
import {
  StakingOptions,
  StakingSymbols,
  UnstakingSymbols,
} from "./constant/utils";
import {
  checkPrice,
  deposit,
  login,
  sendAvailablePositions,
  sendAvailableTickersList,
  buy,
  sendDepositFundsInstructions, sendErrorMessage, sendLoginWalletInstructions, sendMainMenu,
  sendPriceAndTradeInstructions,
  sendRemoveAuthorization,
  sell, sendSetTradeKeysInstructions,
  sendStakingInstructions,
  unstake, setTradeKeys, stake, withdraw, withdrawFundsInstructions, sendSwappingInstructions, swap
} from "./bot.utils";
import {deleteUserState, getUserState} from "./utils/user-states.service";
import {
  checkPriceWizardStep1,
  checkPriceWizardStep2,
  depositFundsWizardStep1,
  depositFundsWizardStep2,
  depositFundsWizardStepConfirm,
  loginWalletWizardStep1,
  loginWalletWizardStep2,
  loginWalletWizardStepConfirm,
  setTradeKeysWizardStep1,
  setTradeKeysWizardStep2,
  setTradeKeysWizardStepConfirm,
  stakeUnstakeWizard,
  stakeWizardStep1,
  stakeWizardStep2,
  stakeWizardStepConfirm, swapWizardStep1, swapWizardStepConfirm,
  unstakeWizardStep1,
  unstakeWizardStepConfirm,
  withdrawFundsWizardStep1,
  withdrawFundsWizardStep2,
  withdrawFundsWizardStepConfirm
} from "./bot-wizard";

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN as string, { polling: true });

bot.onText(/\/start/, async (msg: { chat: { id: any; }; }) => {
  // setupMainCommand(msg.chat.id);

  await sendMainMenu(bot, msg.chat.id);
});

bot.onText(/\/help/, async (msg: { chat: { id: any; }; }) => {
  // setupMainCommand(msg.chat.id);

  const MessagesArray = [
    `🤖 *Welcome to [Quote.Trade](https://quote.trade) Bot!*  
      I can help you manage your trades efficiently.\n\n`,
  ];
  await bot.sendMessage(
      msg.chat.id,
      `${MessagesArray.join(``)}`,
      {parse_mode: "Markdown"}
  );

  setupMainCommand(msg.chat.id);
});

bot.onText(/\/set_trade_keys(?:\s(\S+)\s(\S+))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  const API_KEY = match[1];  // First captured value (API Key)
  const API_SECRET = match[2];  // Second captured value (API Secret)

  if (!API_KEY || !API_SECRET) {
    await bot.sendMessage(chatId, '⚠️ Invalid command. \n\nUse: ' + CommandSetAuthKeys, { parse_mode: "Markdown" });
    return;
  }
  await setTradeKeys(bot, chatId, API_KEY, API_SECRET);
});

bot.onText(/\/login(?:\s(\S+)\s(\S+))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  const WALLET_ADDRESS = match[1];  // First captured value (WALLET_ADDRESS)
  const PRIVATE_KEY = match[2];  // Second captured value (PRIVATE_KEY)

  if (!WALLET_ADDRESS || !PRIVATE_KEY) {
    await bot.sendMessage(chatId, '⚠️ Invalid command. \n\nUse: ' + CommandAuthorization, { parse_mode: "Markdown" });
    return;
  }

  await login(bot, chatId, WALLET_ADDRESS, PRIVATE_KEY);
});

bot.onText(/\/tickers(?:\s(\d+))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  let pageNumber = Number(match?.[1]) || 1;  // Default 1
  sendAvailableTickersList(bot, chatId, pageNumber).then();
});

bot.onText(/\/deposit_funds/, async (msg: { chat: { id: any; }; }) => {
  const chatId = msg.chat.id;
  sendDepositFundsInstructions(bot, chatId).then();
});

bot.onText(/\/deposit(?:\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; text?: any; }, match: any) => {
  // console.log(msg, match)
  if (msg.text === '/deposit_funds') {
    return;
  }
  const chatId = msg.chat.id;
  if (!match) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandDeposit, { parse_mode: "Markdown" });

  let depositToken = match[1]?.toUpperCase();
  let depositAmount = Number(match[2]) || 0;
  if (!depositToken || !depositAmount) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandDeposit, { parse_mode: "Markdown" });

  await deposit(bot, chatId, depositToken, depositAmount);
});

bot.onText(/\/withdraw(?:\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  if (!match) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandWithdraw, { parse_mode: "Markdown" });

  let withdrawToken = match[1]?.toUpperCase();
  let withdrawAmount = Number(match[2]) || 0;
  if (!withdrawToken || !withdrawAmount) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandWithdraw, { parse_mode: "Markdown" });

  await withdraw(bot, chatId, withdrawToken, withdrawAmount);
});

bot.onText(/\/get_positions/, async (msg: { chat: { id: any; }; }) => {
  const chatId = msg.chat.id;
  sendAvailablePositions(bot, chatId).then();
});

bot.onText(/\/price(?:\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;

  let symbol = match[1]?.toUpperCase();
  let quantity = Number(match[2]) || 0;

  if (!symbol || !quantity) {
    await bot.sendMessage(chatId, '⚠️ Invalid command. \n\nUse: ' + CommandPrice, { parse_mode: "Markdown" });
    return;
  }

  await checkPrice(bot, chatId, symbol, quantity);
});

bot.onText(/\/buy(?:\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  if (!match) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandBuy, { parse_mode: "Markdown" });

  // console.log(match);
  let symbol = match[1]?.toUpperCase();
  let quantity = Number(match[2]) || 0;
  // let quoteCurrency = match[4]?.toUpperCase();
  let quoteCurrency = "USD";
  if (!symbol || !quantity || !quoteCurrency) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandBuy, { parse_mode: "Markdown" });

  await buy(bot, chatId, symbol, quantity);
});

bot.onText(/\/sell(?:\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  if (!match) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandSell, { parse_mode: "Markdown" });

  let symbol = match[1]?.toUpperCase();
  let quantity = Number(match[2]) || 0;

  let quoteCurrency = "USD";
  if (!symbol || !quantity ||!quoteCurrency) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandSell, { parse_mode: "Markdown" });

  await sell(bot, chatId, symbol, quantity);
});

bot.onText(/\/staking/, async (msg: { chat: { id: any; }; }) => {
  const chatId = msg.chat.id;

  await sendStakingInstructions(bot, chatId);
});

bot.onText(/\/stake(?:\s(\S+)\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  if (!match) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });

  let option = match[1];
  let symbol = match[2]?.toUpperCase();
  let quantity = Number(match[3]) || 0;
  if (!option || !symbol || !quantity) {
    return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });
  }

  if (!StakingOptions.includes(option)) {
    return bot.sendMessage(chatId, '⚠️ Invalid Staking Option.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });
  }
  if (!StakingSymbols.includes(symbol)) {
    return bot.sendMessage(chatId, '⚠️ Invalid Staking Symbol.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });
  }

  await stake(bot, chatId, option, symbol, quantity);
});

bot.onText(/\/un_stake(?:\s(\S+)\s(\d+(\.\d+)?))?/, async (msg: { chat: { id: any; }; }, match: any) => {
  const chatId = msg.chat.id;
  if (!match) return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });

  let symbol = match[1]?.toUpperCase();
  let quantity = Number(match[2]) || 0;
  if (!symbol || !quantity) {
    return bot.sendMessage(chatId, '⚠️ Invalid command.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });
  }

  if (!UnstakingSymbols.includes(symbol)) {
    return bot.sendMessage(chatId, '⚠️ Invalid Unstaking Symbol.\n\nUse: ' + CommandStaking, { parse_mode: "Markdown" });
  }

  await unstake(bot, chatId, symbol, quantity);
});

bot.onText(/\/remove_authorization/, async (msg: { chat: { id: any; }; }) => {
  const chatId = msg.chat.id;
  sendRemoveAuthorization(bot, chatId).then();
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userState = getUserState(chatId);

  if (!userState) {return;}

  if (userState.status === 'awaiting_API_KEY') {
    const API_KEY = text;
    if (!API_KEY) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await setTradeKeysWizardStep2(bot, chatId, API_KEY);
  } else if (userState.status === 'awaiting_API_SECRET') {
    const API_SECRET = text;
    if (!API_SECRET) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await setTradeKeysWizardStepConfirm(bot, chatId, API_SECRET);
  } else if (userState.status === 'awaiting_WALLET_ADDRESS') {
    const WALLET_ADDRESS = text;
    if (!WALLET_ADDRESS) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await loginWalletWizardStep2(bot, chatId, WALLET_ADDRESS);
  } else if (userState.status === 'awaiting_PRIVATE_KEY') {
    const PRIVATE_KEY = text;
    if (!PRIVATE_KEY) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await loginWalletWizardStepConfirm(bot, chatId, PRIVATE_KEY);
  } else if (userState.status === 'awaiting_DEPOSIT_TOKEN') {
    const DEPOSIT_TOKEN = text;
    if (!DEPOSIT_TOKEN) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await depositFundsWizardStep2(bot, chatId, DEPOSIT_TOKEN);
  } else if (userState.status === 'awaiting_DEPOSIT_AMOUNT') {
    const DEPOSIT_AMOUNT = Number(text) || 0;
    if (!DEPOSIT_AMOUNT) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await depositFundsWizardStepConfirm(bot, chatId, DEPOSIT_AMOUNT);
  } else if (userState.status === 'awaiting_WITHDRAW_AMOUNT') {
    const WITHDRAW_AMOUNT = Number(text) || 0;
    if (!WITHDRAW_AMOUNT) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await withdrawFundsWizardStepConfirm(bot, chatId, WITHDRAW_AMOUNT);
  } else if (userState.status === 'awaiting_price_and_trade_SYMBOL') {
    const SYMBOL = text;
    if (!SYMBOL) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await checkPriceWizardStep2(bot, chatId, SYMBOL);
  } else if (userState.status === 'awaiting_price_and_trade_QUANTITY') {
    const QUANTITY = Number(text) || 0;
    if (!userState?.data.SYMBOL || !QUANTITY) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await checkPrice(bot, chatId, (userState.data.SYMBOL).toUpperCase(), QUANTITY);
  } else if (userState.status === 'awaiting_stake_quantity') {
    let quantity = Number(text) || 0;

    if (!quantity) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await stakeWizardStepConfirm(bot, chatId, quantity);
  } else if (userState.status === 'awaiting_unstake_quantity') {
    let quantity = Number(text) || 0;

    if (!quantity) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await unstakeWizardStepConfirm(bot, chatId, quantity);
  } else if (userState.status === 'awaiting_swap_quantity') {
    let quantity = Number(text) || 0;

    if (!quantity) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    await swapWizardStepConfirm(bot, chatId, quantity);
  }
});

bot.on('callback_query', async (callbackQuery: any) => {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data ?? '';

  try {
    await bot.answerCallbackQuery(callbackQuery.id); // <-- may throw if query expired

    const parts = data.split('|');
    const userState = getUserState(chatId);

    switch (data) {
      case 'set_trade_keys':
        await sendSetTradeKeysInstructions(bot, chatId);
        break;
      case 'set_trade_keys_wizard':
        await setTradeKeysWizardStep1(bot, chatId);
        break;
      case 'set_trade_keys_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.API_KEY || !userState?.data.API_SECRET) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }

        await setTradeKeys(bot, chatId, userState?.data.API_KEY, userState?.data.API_SECRET);
        deleteUserState(chatId);
        break;
      case 'login_wallet':
        await sendLoginWalletInstructions(bot, chatId);
        break;
      case 'login_wallet_wizard':
        await loginWalletWizardStep1(bot, chatId);
        break;
      case 'login_wallet_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.WALLET_ADDRESS || !userState?.data.PRIVATE_KEY) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }

        await login(bot, chatId, userState?.data.WALLET_ADDRESS, userState?.data.PRIVATE_KEY);
        deleteUserState(chatId);
        break;
      case 'tickers':
        await sendAvailableTickersList(bot, chatId, 1);
        break;
      case 'get_positions':
        await sendAvailablePositions(bot, chatId);
        break;
      case 'deposit_funds':
        await sendDepositFundsInstructions(bot, chatId);
        break;
      case 'deposit_funds_wizard':
        await depositFundsWizardStep1(bot, chatId);
        break;
      case 'deposit_funds_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.DEPOSIT_TOKEN || !userState?.data.DEPOSIT_AMOUNT) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }
        await deposit(bot, chatId, userState?.data.DEPOSIT_TOKEN, userState?.data.DEPOSIT_AMOUNT);
        deleteUserState(chatId);
        break;
      case 'withdraw_funds':
        await withdrawFundsInstructions(bot, chatId);
        break;
      case 'withdraw_funds_wizard':
        await withdrawFundsWizardStep1(bot, chatId);
        break;
      case 'withdraw_funds_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.WITHDRAW_TOKEN || !userState?.data.WITHDRAW_AMOUNT) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }
        await withdraw(bot, chatId, userState?.data.WITHDRAW_TOKEN, userState?.data.WITHDRAW_AMOUNT);
        deleteUserState(chatId);
        break;
      case 'price_trade_instructions':
        await sendPriceAndTradeInstructions(bot, chatId);
        break;
      case 'price_trade':
        await checkPriceWizardStep1(bot, chatId);
        break;
      case 'staking':
        await sendStakingInstructions(bot, chatId);
        break;
      case 'stake_unstake':
        await stakeUnstakeWizard(bot, chatId);
        break;
      case 'stake_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.option || !userState?.data.symbol || !userState?.data.quantity) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }

        await stake(bot, chatId, userState?.data.option, userState?.data.symbol, userState?.data.quantity);
        deleteUserState(chatId);
        break;
      case 'unstake_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.symbol || !userState?.data.quantity) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }

        await unstake(bot, chatId, userState?.data.symbol, userState?.data.quantity);
        deleteUserState(chatId);
        break;
      case 'remove_authorization':
        await sendRemoveAuthorization(bot, chatId);
        break;
      case 'back_to_main':
        deleteUserState(chatId);
        await sendMainMenu(bot, chatId);
        break;
      case 'help':
        setupMainCommand(chatId);
        break;
      case 'swapping':
        await sendSwappingInstructions(bot, chatId);
        break;
      case 'swap_wizard_confirm':
        if (userState?.status !== 'awaiting_confirm' || !userState?.data.side || !userState?.data.symbol || !userState?.data.quantity) {
          await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
          return;
        }
        await swap(bot, chatId, userState?.data.fromSymbol, userState?.data.toSymbol, userState?.data.side, userState?.data.symbol, userState?.data.quantity);
        deleteUserState(chatId);
        break;
      default:
        break;
    }

    if (data.startsWith("refresh_price")) {
      await checkPrice(bot, chatId, parts[1], parts[2]);
    } else if (data.startsWith("tickers_page")) {
      await sendAvailableTickersList(bot, chatId, parts[1]);
    } else if (data.startsWith("buy")) {
      await buy(bot, chatId, parts[1], parts[2]);
    } else if (data.startsWith("sell")) {
      await sell(bot, chatId, parts[1], parts[2]);
    } else if (data.startsWith("stake_wizard_step1")) {
      await stakeWizardStep1(bot, chatId, parts[1]);
    } else if (data.startsWith("stake_wizard_step2")) {
      await stakeWizardStep2(bot, chatId, parts[1], parts[2]);
    } else if (data.startsWith("unstake_wizard_step1")) {
      await unstakeWizardStep1(bot, chatId, parts[1]);
    } else if (data.startsWith("deposit_wizard_step2")) {
      await depositFundsWizardStep2(bot, chatId, parts[1]);
    } else if (data.startsWith("withdraw_wizard_step2")) {
      await withdrawFundsWizardStep2(bot, chatId, parts[1]);
    } else if (data.startsWith("swap_symbol")) {
      await swapWizardStep1(bot, chatId, parts[1], parts[2]);
    }

    // Don't forget to answer callback to remove loading spinner on button click
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (err: any) {
    // Optional: Notify user
    if (err.response && err.response.body && err.response.body.error_code === 400) {
      if (err.response.body.description.includes('query is too old')) {
        // maybe do nothing or log
      }
    }
  }
});

function setupMainCommand(chatId: any) {

  const MessagesArray = [
    `🤖 *Welcome to [Quote.Trade](https://quote.trade) Bot!*  
      I can help you manage your trades efficiently.\n\n`,
    `*🎯 Available Commands: 🎯*\n\n`,
    `${AvailableAllCommands.join('')}`,
    `\n\n`,
    `Try it now! 🚀`,
  ];

  bot.sendMessage(
      chatId,
      `${MessagesArray.join(``)}`, {
        reply_markup: {
          inline_keyboard: [
            [ inline_keyboard_start, inline_keyboard_for_back_main_menu ]
          ]
        },
        parse_mode: "Markdown",
      },
  ).then(r => {});
}

console.log('🤖 Telegram Bot is running...');