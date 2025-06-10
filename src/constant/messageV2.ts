export const CommandSetAuthKeys = `\`/set_trade_keys <\API_KEY> <\API_SECRET>\``;
export const ExampleSetAuthKeys = `/set_trade_keys CJy***dF S71***vq`;
export const TipSetAuthKeys = `This is the recommended for trading accounts.\n🔗 Get your API keys from *[Quote.Trade](https://quote.trade)*`;

export const CommandLogin = `\`/login <\WALLET_ADDRESS> <\PRIVATE_KEY>\``;
export const ExampleLogin = `/login 0x9***e b6***06\``;
export const TipLogin = `Authenticate using your wallet credentials. This is only needed if you are using the Bot to auto-deposit.`;

export const CommandDeposit = `\`/deposit DEPOSIT_TOKEN DEPOSIT_AMOUNT\``;
export const ExampleDeposit = `/deposit USDC 1000`;
export const TipDeposit = `Deposit funds automatically. Only *USDC* or *USDT* (Ethereum ERC-20) are accepted.`;

export const CommandTopTickers = `\`/tickers\``;
export const ExampleTopTickers = `/tickers`;
export const TipTickers = ``;

export const CommandWithdraw = `\`/withdraw WITHDRAW_TOKEN WITHDRAW_AMOUNT\``;
export const ExampleWithdraw = `/withdraw USDC 1000`;
export const TipWithdraw = `To withdraw, please use only USDC or USDT as the token.`;

// inline_keyboard --------------------
export const inline_keyboard_for_back_main_menu = { text: '🏠 Back to Main Menu', callback_data: 'back_to_main' };
export const inline_keyboard_for_set_trade_keys = { text: '🔐 Set Trade Keys', callback_data: 'set_trade_keys' };
export const inline_keyboard_for_login_wallet = { text: '🔑 Login Wallet', callback_data: 'login_wallet' };
export const inline_keyboard_remove_auth = { text: '🚫 Revoke Authorization 🔒', callback_data: 'remove_authorization' };
export const inline_keyboard_tickers = { text: '📜 View Tickers', callback_data: 'tickers' };
export const inline_keyboard_get_positions = { text: '📊 View Positions', callback_data: 'get_positions' };
export const inline_keyboard_deposit_funds = { text: '💸 Deposit Funds', callback_data: 'deposit_funds' };
export const inline_keyboard_withdraw_funds = { text: '🏦 Withdraw Funds', callback_data: 'withdraw_funds' };
export const inline_keyboard_price_trade_instructions = { text: '📖 How Price & Trade Work', callback_data: 'price_trade_instructions' };
export const inline_keyboard_price_trade = { text: '💵 Check Price & Trade', callback_data: 'price_trade' };
export const inline_keyboard_stake_staking = { text: '📚 Staking Instructions', callback_data: 'staking' };
export const inline_keyboard_stake_unstake = { text: '🌟 Stake / Unstake', callback_data: 'stake_unstake' };
export const inline_keyboard_exit_wizard = { text: '✖️ Exit Wizard', callback_data: 'back_to_main' };
export const inline_keyboard_start = { text: '🎯 Start', callback_data: 'back_to_main' };
export const inline_keyboard_help = { text: '🆘 Help', callback_data: 'help' };
export const inline_keyboard_swapping = { text: '🔁 Swapping', callback_data: 'swapping' };

export const inline_keyboard_for_main_menu = [
    [
        inline_keyboard_for_set_trade_keys, inline_keyboard_for_login_wallet,
    ],
    [
        inline_keyboard_deposit_funds, inline_keyboard_withdraw_funds,
    ],
    [
        inline_keyboard_tickers, inline_keyboard_get_positions
    ],
    [
        inline_keyboard_price_trade_instructions, inline_keyboard_price_trade
    ],
    [
        inline_keyboard_stake_staking, inline_keyboard_stake_unstake,
    ],
    [
        inline_keyboard_swapping,
    ],
    [
        inline_keyboard_help,
    ],
];
export const inline_keyboard_for_main_menu_after_success_auth = [
    [
        inline_keyboard_deposit_funds, inline_keyboard_withdraw_funds,
    ],
    [
        inline_keyboard_tickers, inline_keyboard_get_positions
    ],
    [
        inline_keyboard_price_trade_instructions, inline_keyboard_price_trade
    ],
    [
        inline_keyboard_stake_staking, inline_keyboard_stake_unstake,
    ],
    [
        inline_keyboard_remove_auth, inline_keyboard_swapping,
    ],
    [
        inline_keyboard_help,
    ],
];

export const inline_keyboard_for_set_trade_keys_wizard = { text: '📑 Let\'s Continue the Wizard', callback_data: 'set_trade_keys_wizard' };
export const inline_keyboard_for_set_trade_keys_wizard_confirm = { text: '✅ Confirm', callback_data: 'set_trade_keys_wizard_confirm' };

export const inline_keyboard_for_set_login_wallet_wizard = { text: '📑 Let\'s Continue the Wizard', callback_data: 'login_wallet_wizard' };
export const inline_keyboard_for_set_login_wallet_wizard_confirm = { text: '✅ Confirm', callback_data: 'login_wallet_wizard_confirm' };

export const inline_keyboard_for_stake_wizard_confirm = { text: '✅ Confirm', callback_data: 'stake_wizard_confirm' };
export const inline_keyboard_for_unstake_wizard_confirm = { text: '✅ Confirm', callback_data: 'unstake_wizard_confirm' };

export const inline_keyboard_for_set_deposit_funds_wizard = { text: '📑 Let\'s Continue the Wizard', callback_data: 'deposit_funds_wizard' };
export const inline_keyboard_for_set_login_deposit_funds_confirm = { text: '✅ Confirm', callback_data: 'deposit_funds_wizard_confirm' };

export const inline_keyboard_for_withdraw_funds_wizard = { text: '📑 Let\'s Continue the Wizard', callback_data: 'withdraw_funds_wizard' };
export const inline_keyboard_for_withdraw_funds_wizard_confirm = { text: '✅ Confirm', callback_data: 'withdraw_funds_wizard_confirm' };

export const inline_keyboard_for_swap_wizard_confirm = { text: '✅ Confirm', callback_data: 'swap_wizard_confirm' };
