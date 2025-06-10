export const DepositToken = [
    'USDC',
    'USDT',
];

export const WithdrawToken = [
    'USDC',
    'USDT',
];

export const StakingSymbols = [
    'USDC',
    'USDT',
];

export const UnstakingSymbols = [
    "STAKE_USDC_24H",
    // "STAKE_USDC_6M",
    // "STAKE_USDC_12M",
    // "STAKE_USDC_18M",
    "STAKE_USDT_24H",
    // "STAKE_USDT_6M",
    // "STAKE_USDT_12M",
    // "STAKE_USDT_18M"
];

export const StakingOptions = [
    '24_HOUR',
    '06_MONTH',
    '12_MONTH',
    '18_MONTH',
];

export const StakingOptionsMap: Record<string, any> = {
    '24_HOUR': {value: 1},
    '06_MONTH': {value: 2},
    '12_MONTH': {value: 3},
    '18_MONTH': {value: 4},
};

export const StakingOptionsIdMap: Record<string, any> = {
    1: '24_HOUR',
    2: '06_MONTH',
    3: '12_MONTH',
    4: '18_MONTH',
};