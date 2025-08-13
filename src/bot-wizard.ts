import {
  escapeAllMarkdownV2,
  escapeMarkdownV2,
  sendErrorMessage,
  sendProcessingMessage,
  sendUnauthorizedMessage
} from "./bot.utils";
import {deleteUserState, getUserState, setUserState} from "./utils/user-states.service";
import {
  inline_keyboard_exit_wizard,
  inline_keyboard_for_set_login_deposit_funds_confirm,
  inline_keyboard_for_set_login_wallet_wizard_confirm,
  inline_keyboard_for_set_trade_keys_wizard_confirm,
  inline_keyboard_for_stake_wizard_confirm, inline_keyboard_for_swap_wizard_confirm,
  inline_keyboard_for_unstake_wizard_confirm,
  inline_keyboard_for_withdraw_funds_wizard_confirm,
} from "./constant/messageV2";
import {getAuth} from "./utils/auth.service";
import {BotSvc} from "./bot.service";
import {cfThousandSeparator, fCurrency} from "./utils/format-number";


export async function setTradeKeysWizardStep1(bot: any, chatId: any) {
  try {
    deleteUserState(chatId);

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Set Your Trade Keys!*__\n\n`),
    ];
    MessagesArray.push(`✍️ *Please enter your API\\_KEY\\:*\n\n`);
    // MessagesArray.push(escapeMarkdownV2(`or click '✖️ Exit' if you want to leave the wizard`));

    setUserState(chatId, 'awaiting_API_KEY', {});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function setTradeKeysWizardStep2(bot: any, chatId: any, API_KEY: string) {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Set Your Trade Keys!*__\n\n`),
    ];
    MessagesArray.push(`🔑 Your API\\_KEY\\: ${escapeAllMarkdownV2(API_KEY)}\n\n`);
    MessagesArray.push(`✍️ *Please enter your API\\_SECRET\\:*\n`);
    // MessagesArray.push(escapeMarkdownV2(`✖️ Click 'Exit' if you want to leave the wizard`));

    setUserState(chatId, 'awaiting_API_SECRET', {API_KEY});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function setTradeKeysWizardStepConfirm(bot: any, chatId: any, API_SECRET: string) {
  try {
    const userState = getUserState(chatId);
    if (!userState?.data.API_KEY) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Set Your Trade Keys!*__\n\n`),
    ];
    MessagesArray.push(`🔑 Your API\\_KEY\\: ${escapeAllMarkdownV2(userState?.data.API_KEY)}\n`);
    MessagesArray.push(`🔑 Your API\\_SECRET\\: ${escapeAllMarkdownV2(API_SECRET)}`);

    setUserState(chatId, 'awaiting_confirm', {API_SECRET});
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_set_trade_keys_wizard_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}


export async function loginWalletWizardStep1(bot: any, chatId: any) {
  try {
    deleteUserState(chatId);

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Login with your wallet!*__\n\n`),
    ];
    MessagesArray.push(`✍️ *Please enter your WALLET\\_ADDRESS\\:*\n\n`);
    // MessagesArray.push(escapeMarkdownV2(`or click '✖️ Exit' if you want to leave the wizard`));

    setUserState(chatId, 'awaiting_WALLET_ADDRESS', {});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function loginWalletWizardStep2(bot: any, chatId: any, WALLET_ADDRESS: string) {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Login with your wallet!*__\n\n`),
    ];
    MessagesArray.push(`🔑 Your WALLET\\_ADDRESS\\: ${escapeAllMarkdownV2(WALLET_ADDRESS)}\n\n`);
    MessagesArray.push(`✍️ *Please enter your PRIVATE\\_KEY\\:*\n`);
    // MessagesArray.push(escapeMarkdownV2(`✖️ Click 'Exit' if you want to leave the wizard`));

    setUserState(chatId, 'awaiting_PRIVATE_KEY', {WALLET_ADDRESS});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function loginWalletWizardStepConfirm(bot: any, chatId: any, PRIVATE_KEY: string) {
  try {
    const userState = getUserState(chatId);
    if (!userState?.data.WALLET_ADDRESS) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Login with your wallet!*__\n\n`),
    ];
    MessagesArray.push(`🔑 Your WALLET\\_ADDRESS\\: ${escapeAllMarkdownV2(userState?.data.WALLET_ADDRESS)}\n`);
    MessagesArray.push(`🔑 Your PRIVATE\\_KEY\\: ${escapeAllMarkdownV2(PRIVATE_KEY)}`);

    setUserState(chatId, 'awaiting_confirm', {PRIVATE_KEY});
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_set_login_wallet_wizard_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}


export async function depositFundsWizardStep1(bot: any, chatId: any) {
  try {
    deleteUserState(chatId);

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Deposit Funds!*__\n\n`),
    ];
    // MessagesArray.push(escapeMarkdownV2(`💡 *Tip:* ${TipDeposit}\n\n`));
    // MessagesArray.push(`✍️ *Please enter your deposit token\\:*\n\n`);

    MessagesArray.push(escapeMarkdownV2(`*[Choose a Withdraw Token]* - Try it now! 🚀`));

    // setUserState(chatId, 'awaiting_DEPOSIT_TOKEN', {});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💠 USDC', callback_data: 'deposit_wizard_step2|USDC' },
                { text: '💠 USDT', callback_data: 'deposit_wizard_step2|USDT' }
              ],
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function depositFundsWizardStep2(bot: any, chatId: any, DEPOSIT_TOKEN: string) {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Deposit Funds!*__\n\n`),
    ];
    MessagesArray.push(`💠 Your deposit token\\: ${escapeAllMarkdownV2(DEPOSIT_TOKEN)}\n\n`);
    MessagesArray.push(`✍️ *Please enter your deposit amount\\:*\n`);

    setUserState(chatId, 'awaiting_DEPOSIT_AMOUNT', {DEPOSIT_TOKEN});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function depositFundsWizardStepConfirm(bot: any, chatId: any, DEPOSIT_AMOUNT: number) {
  try {
    const userState = getUserState(chatId);
    if (!userState?.data.DEPOSIT_TOKEN) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Deposit Funds!*__\n\n`),
    ];
    MessagesArray.push(`💠 Your deposit token\\: ${escapeAllMarkdownV2(userState?.data.DEPOSIT_TOKEN)}\n`);
    MessagesArray.push(`🔢 Your deposit amount\\: ${escapeAllMarkdownV2(String(DEPOSIT_AMOUNT))}`);

    setUserState(chatId, 'awaiting_confirm', {DEPOSIT_AMOUNT});
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_set_login_deposit_funds_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}


export async function withdrawFundsWizardStep1(bot: any, chatId: any) {
  try {
    deleteUserState(chatId);

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Withdraw Funds!*__\n\n`),
    ];
    // MessagesArray.push(escapeMarkdownV2(`💡 *Tip:* ${TipWithdraw}\n\n`));
    // MessagesArray.push(`✍️ *Please enter your WITHDRAW\\_TOKEN\\:*\n\n`);
    MessagesArray.push(escapeMarkdownV2(`*[Choose a Withdraw Token]* - Try it now! 🚀`));

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💠 USDC', callback_data: 'withdraw_wizard_step2|USDC' },
                { text: '💠 USDT', callback_data: 'withdraw_wizard_step2|USDT' }
              ],
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function withdrawFundsWizardStep2(bot: any, chatId: any, WITHDRAW_TOKEN: string) {
  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Withdraw Funds!*__\n\n`),
    ];
    MessagesArray.push(`💠 Your withdraw token\\: ${escapeAllMarkdownV2(WITHDRAW_TOKEN)}\n\n`);
    MessagesArray.push(`✍️ *Please enter your withdraw amount\\:*\n`);

    setUserState(chatId, 'awaiting_WITHDRAW_AMOUNT', {WITHDRAW_TOKEN});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function withdrawFundsWizardStepConfirm(bot: any, chatId: any, WITHDRAW_AMOUNT: number) {
  try {
    const userState = getUserState(chatId);
    if (!userState?.data.WITHDRAW_TOKEN) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🔐 *Wizard: Withdraw Funds!*__\n\n`),
    ];
    MessagesArray.push(`💠 Your withdraw token\\: ${escapeAllMarkdownV2(userState?.data.WITHDRAW_TOKEN)}\n`);
    MessagesArray.push(`🔢 Your withdraw amount\\: ${escapeAllMarkdownV2(String(WITHDRAW_AMOUNT))}`);

    setUserState(chatId, 'awaiting_confirm', {WITHDRAW_AMOUNT});
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_withdraw_funds_wizard_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}


export async function checkPriceWizardStep1(bot: any, chatId: any) {
  try {
    deleteUserState(chatId);

    const auth = getAuth(chatId);
    if (!auth?.requestToken) {
      sendUnauthorizedMessage(bot, chatId).then()
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__💵 *Wizard: Check Price & Trade!*__\n\n`),
    ];
    MessagesArray.push(`✍️ *Please enter the crypto asset symbol:*\n\n`);

    setUserState(chatId, 'awaiting_price_and_trade_SYMBOL', {});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function checkPriceWizardStep2(bot: any, chatId: any, SYMBOL: string) {
  try {
    let matchingPrice: any = await BotSvc.getMatchingPrice((SYMBOL).toUpperCase(), 0);

    const MessagesArray = [
      escapeMarkdownV2(`__💵 *Wizard: Check Price & Trade!*__\n\n`),
    ];
    MessagesArray.push(`💠 Your crypto asset symbol: *${escapeAllMarkdownV2(SYMBOL.toUpperCase())}*\n\n`);
    MessagesArray.push(`🟢 *Buying: ${escapeAllMarkdownV2(fCurrency(matchingPrice.ask.p))}*\n`);
    MessagesArray.push(`🔴 *Selling: ${escapeAllMarkdownV2(fCurrency(matchingPrice.bid.p))}*\n\n`);
    MessagesArray.push(`✍️ *Please enter your quantity:*\n`);

    setUserState(chatId, 'awaiting_price_and_trade_QUANTITY', {SYMBOL});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}


export async function stakeUnstakeWizard(bot: any, chatId: any) {
  const auth = getAuth(chatId);

  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then()
    return;
  }

  try {
    let MessagesArray = [
      `__🌟 *Wizard: Stake / Unstake!*__\n\n`,
      `*[Choose a Stake or Unstake Symbol]* - Try it now! 🚀`,
      `\n\n`,
    ];

    await bot.sendMessage(
        chatId,
        `${escapeMarkdownV2(MessagesArray.join(``))}`, {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💰 Stake - USDC', callback_data: 'stake_wizard_step1|USDC' },
                { text: '💰 Stake - USDT', callback_data: 'stake_wizard_step1|USDT' }
              ],
              [{ text: '💰 Un-stake - STAKE_USDC_24H', callback_data: 'unstake_wizard_step1|STAKE_USDC_24H' },],
              [ { text: '💰 Un-stake - STAKE_USDT_24H', callback_data: 'unstake_wizard_step1|STAKE_USDT_24H' }],

              [{ text: '💰 Un-stake - STAKE_USDC_6M', callback_data: 'unstake_wizard_step1|STAKE_USDC_6M' },],
              [ { text: '💰 Un-stake - STAKE_USDT_6M', callback_data: 'unstake_wizard_step1|STAKE_USDT_6M' }],

              [{ text: '💰 Un-stake - STAKE_USDC_12M', callback_data: 'unstake_wizard_step1|STAKE_USDC_12M' },],
              [{ text: '💰 Un-stake - STAKE_USDT_12M', callback_data: 'unstake_wizard_step1|STAKE_USDT_12M' }],

              [{ text: '💰 Un-stake - STAKE_USDC_18M', callback_data: 'unstake_wizard_step1|STAKE_USDC_18M' },],
              [{ text: '💰 Un-stake - STAKE_USDT_18M', callback_data: 'unstake_wizard_step1|STAKE_USDT_18M' }],
              [inline_keyboard_exit_wizard]
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

export async function stakeWizardStep1(bot: any, chatId: any, symbol: string) {
  deleteUserState(chatId);
  const auth = getAuth(chatId);

  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then();
    return;
  }

  try {
    const MessagesArray = [
      escapeMarkdownV2(`__🌟 *Wizard: Stake!*__\n\n`),
      `${escapeMarkdownV2('💠 Your stake symbol:')} *${escapeAllMarkdownV2(symbol.toUpperCase())}*\n\n`,
      escapeMarkdownV2(`*[Choose a stake option]* - Try it now! 🚀`),
    ];

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '👉 24_HOUR', callback_data: `stake_wizard_step2|${symbol}|24_HOUR` }],
              [{ text: '👉 06_MONTH', callback_data: `stake_wizard_step2|${symbol}|06_MONTH` }],
              [{ text: '👉 12_MONTH', callback_data: `stake_wizard_step2|${symbol}|12_MONTH` }],
              [{ text: '👉 18_MONTH', callback_data: `stake_wizard_step2|${symbol}|18_MONTH` }],
              [inline_keyboard_exit_wizard]
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

export async function stakeWizardStep2(bot: any, chatId: any, symbol: string, option: string) {
  const auth = getAuth(chatId);

  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then();
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);
    let positions: any = await BotSvc.getPositions(auth);
    const has = positions.find((item: any) => item.symbol === symbol);

    const MessagesArray = [
      escapeMarkdownV2(`__🌟 *Wizard: Stake!*__\n\n`),
      `${escapeMarkdownV2('💠 Your stake symbol:')} *${escapeAllMarkdownV2(symbol.toUpperCase())}*\n`,
      `${escapeMarkdownV2('🔹 Your stake option:')} *${escapeAllMarkdownV2(option)}*\n\n`,
    ];

    let availableQuantity = has?.quantity ?? 0;
    MessagesArray.push(`💬 _*Available ${escapeAllMarkdownV2(symbol.toUpperCase())} Quantity\\: ${escapeAllMarkdownV2(cfThousandSeparator(availableQuantity))}*_\n\n`);

    if (availableQuantity <= 0) {
      MessagesArray.push(`🚫 Insufficient quantity for staking\\.`);
      deleteUserState(chatId);
      await bot.sendMessage(
          chatId,
          `${MessagesArray.join(``)}`, {
            reply_markup: {
              inline_keyboard: [
                [inline_keyboard_exit_wizard]
              ]
            },
            parse_mode: "MarkdownV2",
          },
      );
    } else {
      setUserState(chatId, 'awaiting_stake_quantity', {
        option,
        symbol,
      });
      MessagesArray.push(`✍️ *Please enter your stake quantity\\:*\n`);
      await bot.sendMessage(
          chatId,
          `${MessagesArray.join(``)}`, {
            reply_markup: {
              inline_keyboard: [
                [inline_keyboard_exit_wizard]
              ]
            },
            parse_mode: "MarkdownV2",
          },
      );
    }

  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Stake Failed: ${error?.error ?? (error?.message ?? 'UNKNOWN_ERROR')}`);
  }
}

export async function stakeWizardStepConfirm(bot: any, chatId: any, quantity: number) {
  try {
    const userState = getUserState(chatId);

    if (!userState?.data.option || !userState?.data.symbol) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🌟 *Wizard: Stake!*__\n\n`),
      `${escapeMarkdownV2('💠 Your stake symbol:')} *${escapeAllMarkdownV2((userState?.data?.symbol ?? '').toUpperCase())}*\n`,
      `${escapeMarkdownV2('🔹 Your stake option:')} *${escapeAllMarkdownV2(userState?.data.option)}*\n`,
      `${escapeMarkdownV2('📈 Your stake quantity:')} *${escapeAllMarkdownV2(String(quantity))}*\n\n`,
    ];

    setUserState(chatId, 'awaiting_confirm', {quantity});
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_stake_wizard_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function unstakeWizardStep1(bot: any, chatId: any, symbol: string) {
  const auth = getAuth(chatId);
  if (!auth?.requestToken) {
    sendUnauthorizedMessage(bot, chatId).then();
    return;
  }

  try {
    await sendProcessingMessage(bot, chatId);
    let positions: any = await BotSvc.getPositions(auth);
    const has = positions.find((item: any) => item.symbol === symbol);

    const MessagesArray = [
      escapeMarkdownV2(`__🌟 *Wizard: Un-stake!*__\n\n`),
      `${escapeMarkdownV2('💠 Your stake symbol:')} *${escapeAllMarkdownV2(symbol.toUpperCase())}*\n`,
    ];

    let availableQuantity = has?.quantity ?? 0;
    MessagesArray.push(`💬 _*Available ${escapeAllMarkdownV2(symbol.toUpperCase())} Quantity\\: ${escapeAllMarkdownV2(cfThousandSeparator(availableQuantity))}*_\n\n`);

    if (availableQuantity <= 0) {
      MessagesArray.push(`🚫 Insufficient quantity for staking\\.`);
      deleteUserState(chatId);
      await bot.sendMessage(
          chatId,
          `${MessagesArray.join(``)}`, {
            reply_markup: {
              inline_keyboard: [
                [inline_keyboard_exit_wizard]
              ]
            },
            parse_mode: "MarkdownV2",
          },
      );
    } else {
      setUserState(chatId, 'awaiting_unstake_quantity', {
        symbol,
      });
      MessagesArray.push(`✍️ *Please enter your un\\-stake quantity\\:*\n`);

      await bot.sendMessage(
          chatId,
          `${MessagesArray.join(``)}`, {
            reply_markup: {
              inline_keyboard: [
                [inline_keyboard_exit_wizard]
              ]
            },
            parse_mode: "MarkdownV2",
          },
      );
    }

  } catch (error: any) {
    // console.error(error);
    await bot.sendMessage(chatId, `❌ Failed: ${error?.error ?? (error?.message ?? 'UNKNOWN_ERROR')}`);
  }
}

export async function unstakeWizardStepConfirm(bot: any, chatId: any, quantity: number) {
  try {
    const userState = getUserState(chatId);

    if (!userState?.data.symbol) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🌟 *Wizard: Un-stake!*__\n\n`),
      `${escapeMarkdownV2('💠 Your un-stake symbol:')} *${escapeAllMarkdownV2((userState?.data?.symbol ?? '').toUpperCase())}*\n`,
      `${escapeMarkdownV2('📈 Your un-stake quantity:')} *${escapeAllMarkdownV2(String(quantity))}*\n\n`,
    ];

    setUserState(chatId, 'awaiting_confirm', {quantity});
    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_unstake_wizard_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}


export async function swapWizardStep1(bot: any, chatId: any, fromSymbol: string, toSymbol: string) {
  try {
    deleteUserState(chatId);
    const auth = getAuth(chatId);

    let side = '';
    let symbol = '';
    let price = 0;

    if (fromSymbol === 'USD') {
      side = 'BUY';
      symbol = toSymbol;
    } else {
      side = 'SELL';
      symbol = fromSymbol;
    }

    let matchingPrice: any = await BotSvc.getMatchingPrice((symbol).toUpperCase(), 0);

    if (side === 'BUY') {
      price = matchingPrice?.ask?.p;
      if (price < 1) {
        price = 1;
      }
    } else { // side === 'SELL'
      price = matchingPrice?.bid?.p;
      if (price > 1) {
        price = 1;
      }
    }

    let positions: any = await BotSvc.getPositions(auth);
    const has = positions.find((item: any) => item.symbol === fromSymbol);


    let availableQuantity = has?.quantity ?? 0;

    const MessagesArray = [
      escapeMarkdownV2(`__🔁 *Wizard: SWAP ${fromSymbol} to ${toSymbol}*__\n\n`),
      `${escapeMarkdownV2(`📈 The mark price for selling (${symbol}):`)} *${escapeAllMarkdownV2(String(price))}*\n`,
    ];
    MessagesArray.push(`💠 Available ${escapeAllMarkdownV2(fromSymbol.toUpperCase())} Quantity\\: *${escapeAllMarkdownV2(cfThousandSeparator(availableQuantity))}*\n\n`);

    MessagesArray.push(`✍️ *Please enter the ${fromSymbol} quantity you want to swap\\:*\n`);
    setUserState(chatId, 'awaiting_swap_quantity', {
      fromSymbol,
      toSymbol,
      side,
      symbol,
      price,
      availableQuantity,
    });

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}

export async function swapWizardStepConfirm(bot: any, chatId: any, quantity: any) {
  try {
    const userState = getUserState(chatId);

    const {
      fromSymbol,
      toSymbol,
      side,
      symbol,
      price,
      availableQuantity,
    } = userState?.data ?? {};

    let toQuantity = 0;

    if (!fromSymbol || !toSymbol) {
      await sendErrorMessage(bot, chatId, `😔 *Oops! Something went wrong. Give it another try!*`);
      return;
    }

    if (quantity && price) {
      if (side === 'BUY') {
        toQuantity = quantity * (1 / price);
      } else {
        toQuantity = quantity * price;
      }
    }

    const MessagesArray = [
      escapeMarkdownV2(`__🔁 *Wizard: SWAP ${fromSymbol} to ${toSymbol}*__\n\n`),
      `${escapeMarkdownV2(`📈 The mark price for selling (${symbol}):`)} *${escapeAllMarkdownV2(String(price))}*\n`,
    ];
    MessagesArray.push(`💠 Available ${escapeAllMarkdownV2(fromSymbol.toUpperCase())} Quantity\\: *${escapeAllMarkdownV2(cfThousandSeparator(availableQuantity))}*\n\n`);
    MessagesArray.push(`💠 Swap Quantity\\: *${escapeAllMarkdownV2(cfThousandSeparator(quantity))} ${escapeAllMarkdownV2(fromSymbol.toUpperCase())}*\n`);
    MessagesArray.push(`💠 Receive Quantity\\: *${escapeAllMarkdownV2(cfThousandSeparator(toQuantity))} ${escapeAllMarkdownV2(toSymbol.toUpperCase())}*\n\n`);

    setUserState(chatId, 'awaiting_confirm', {quantity});

    await bot.sendMessage(
        chatId,
        `${MessagesArray.join(``)}`, {
          reply_markup: {
            inline_keyboard: [
              [inline_keyboard_for_swap_wizard_confirm, inline_keyboard_exit_wizard]
            ]
          },
          parse_mode: "MarkdownV2",
        },
    );
  } catch (error: any) {
    await bot.sendMessage(chatId, `❌ Failed: ${error?.message ?? 'UNKNOWN_ERROR'}`);
  }
}