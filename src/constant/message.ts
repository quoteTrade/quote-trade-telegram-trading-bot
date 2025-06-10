export const CommandSetAuthKeys = '📌 \`/set_trade_keys <\API_KEY> <\API_SECRET>\`';
export const ExampleSetAuthKeys = '📝 e.g.,: /set\\_trade\\_keys 0x9\\*\\*\\*e b6\\*\\*\\*06';
export const TipSetAuthKeys = '💡 To set your trade keys. This is the recommended authorization method. Get your API keys from 🔗 *[Quote.Trade](https://quote.trade)*';

export const CommandAuthorization = '📌 \`/login WALLET_ADDRESS PRIVATE_KEY\`';
export const ExampleAuthorization = '📝 e.g.,: /login CJy\\*\\*\\*dF S71\\*\\*\\*vq';
export const TipAuthorization = '💡 Authenticate using your wallet credentials. This is only needed if you are using the Bot to auto-deposit.';

export const CommandGetDepositAddress = '📌 \`/deposit_funds\`';
export const ExampleGetDepositAddress = '📝 e.g.,: /deposit\\_funds';
export const TipGetDepositAddress = '💡 Get deposit address & instructions.';

export const CommandDeposit = `📌 \`/deposit DEPOSIT_TOKEN DEPOSIT_AMOUNT\``;
export const ExampleDeposit = '📝 e.g.,: /deposit USDC 1000';
export const TipDeposit = '💡 Deposit funds automatically. Only send *USDC* or *USDT* (Ethereum ERC-20) as the deposit token';

export const CommandWithdraw = `📌 \`/withdraw WITHDRAW_TOKEN WITHDRAW_AMOUNT\``;
export const ExampleWithdraw = '📝 e.g.,: /withdraw USDC 1000';
export const TipWithdraw = '💡 Withdraw funds. Only send *USDC* or *USDT* as the Withdraw token';

export const CommandTopSymbols = '📌 \`/tickers\`';
export const ExampleTopSymbols = '📝 e.g.,: /tickers';

export const CommandPaginationSymbols = '📌 \`/tickers PAGE_NUMBER\`';
export const ExamplePaginationSymbols = '📝 e.g.,: /tickers 2';
export const TrpPaginationSymbols = '💡 Trp: Get a paginated list of symbols (up to the total number of pages).';

export const CommandGetPositions = '📌 \`/get_positions\`';
export const ExampleGetPositions = '📝 e.g.,: /get\\_positions';
export const TrpGetPositions = '💡 Trp: View open trading positions';

export const CommandPrice = '📌 \`/price TICKER QUANTITY\`';
export const ExamplePrice = '📝 e.g.,: /price BTC 0.02';
export const TrpPrice = '💡 Trp: Retrieve the ticker price for a specific quantity.';

export const CommandBuy = '📌 \`/buy TICKER QUANTITY\`';
export const ExampleBuy = '📝 e.g.,: /buy BTC 0.02';
export const TrpBuy = '💡 Trp: Place a buy order.';

export const CommandSell = '📌 \`/sell TICKER QUANTITY\`';
export const ExampleSell = '📝 e.g.,: /sell BTC 0.02';
export const TrpSell = '💡 Trp: Place a sell order.';

export const CommandStaking = '📌 \`/staking\`';
export const ExampleStaking = '📝 e.g.,: /staking';
export const TrpStaking = '💡 Trp: Get staking instructions.';

export const CommandRemoveAuth = '📌 \`/remove_authorization\`';
export const ExampleRemoveAuth = '📝 e.g.,: /remove\\_authorization';
export const TrpRemoveAuth = '💡 Trp: Authorization will be revoked, and wallet keys & API keys will be removed from the Bot App.';

export const CommandStart = '🎯 /start';
export const CommandHelp = '🆘 /help';


export const AvailableAllCommands = [
    CommandStart, `\n\n`,
    CommandSetAuthKeys, `\n`,
    ExampleSetAuthKeys, `\n`,
    TipSetAuthKeys, `\n`,
    `\n`,
    CommandAuthorization, `\n`,
    ExampleAuthorization, `\n`,
    TipAuthorization, `\n`,
    `\n`,
    CommandGetDepositAddress, `\n`,
    ExampleGetDepositAddress, `\n`,
    TipGetDepositAddress, `\n`,
    `\n`,
    CommandDeposit, `\n`,
    ExampleDeposit, `\n`,
    TipDeposit, `\n`,
    `\n`,
    CommandWithdraw, `\n`,
    ExampleWithdraw, `\n`,
    TipWithdraw, `\n`,
    `\n`,
    CommandTopSymbols, `\n`,
    ExampleTopSymbols, `\n`,
    `\n`,
    CommandPaginationSymbols, `\n`,
    ExamplePaginationSymbols, `\n`,
    TrpPaginationSymbols, `\n`,
    `\n`,
    CommandGetPositions, `\n`,
    ExampleGetPositions, `\n`,
    TrpGetPositions, `\n`,
    `\n`,
    CommandPrice, `\n`,
    ExamplePrice, `\n`,
    TrpPrice, `\n`,
    `\n`,
    CommandBuy, `\n`,
    ExampleBuy, `\n`,
    TrpBuy, `\n`,
    `\n`,
    CommandSell, `\n`,
    ExampleSell, `\n`,
    TrpSell, `\n`,
    `\n`,
    CommandStaking, `\n`,
    ExampleStaking, `\n`,
    TrpStaking, `\n`,
    `\n`,
    CommandRemoveAuth, `\n`,
    ExampleRemoveAuth, `\n`,
    TrpRemoveAuth, `\n`,
    `\n`,
    CommandHelp, `\n`,
];

export const AvailableAllCommands2 = [

];

export const AvailableAllExamples = [
    ExampleTopSymbols,
    ExamplePaginationSymbols,
    ExamplePrice,
    ExampleSetAuthKeys,
    ExampleAuthorization,
    ExampleGetDepositAddress,
    ExampleDeposit,
    ExampleGetPositions,
    ExampleBuy,
    ExampleSell,
    ExampleStaking,
    ExampleWithdraw,
    ExampleRemoveAuth,
]

export const AvailableCommandsWithAuth = [
    CommandTopSymbols,
    CommandPaginationSymbols,
    CommandPrice,
    CommandGetDepositAddress,
    CommandDeposit,
    CommandGetPositions,
    CommandBuy,
    CommandSell,
    CommandStaking,
    CommandWithdraw,
    CommandRemoveAuth,
];

export const AvailableExamplesWithAuth = [
    ExampleTopSymbols,
    ExamplePaginationSymbols,
    ExamplePrice,
    ExampleGetDepositAddress,
    ExampleDeposit,
    ExampleGetPositions,
    ExampleBuy,
    ExampleSell,
    ExampleStaking,
    ExampleWithdraw,
    ExampleRemoveAuth,
]

export const AuthErrorMessagesArray = [
    `🚫 *Access denied: You must be authorized to [Quote.Trade Bot]!*`,
    `\n\n`,
    `🔐 *To gain access, follow one of the methods below:*\n\n`,
    `1️⃣  *Using API Keys (Recommended for Trading Accounts)*\n`,
    `${CommandSetAuthKeys}\n\n`,
    `2️⃣  *Using Wallet Authorization*\n`,
    `${CommandAuthorization}\n\n`,
    `💡*Example Usage:*\n`,
    `${ExampleSetAuthKeys}\n`,
    `${ExampleAuthorization}\n\n`,
    `🔄 Once authorized, you can start 🚀`
];

export const FullAuthErrorMessagesArray = [
    `🚫 *Access denied!*`,
    `\n\n`,
    `🔐 *To gain access, Using Wallet Authorization*\n`,
    `${CommandAuthorization}\n\n`,
    `💡*Example Usage:*\n`,
    `${ExampleAuthorization}\n\n`,
    `🔄 Once authorized, you can start 🚀`
];

export const ProcessingRequestMessagesArray = [
    `⏳ *Processing Your Request...*`,
    `\n\n`,
    `Please wait while we process your request. This may take a few moments.`,
];

export const StakingAuthorizationInstructions = [
    `You can *Stake* and *Unstake* after authorization.`,
    `\n\n`,
    `🔹 *Authorization Methods:*  \n`,
    `  👉 Use \` /set_trade_keys API_KEY API_SECRET\` to set API keys.  \n`,
    `  👉 Or use \` /login WALLET_ADDRESS PRIVATE_KEY\` for authentication.  \n\n`,
];