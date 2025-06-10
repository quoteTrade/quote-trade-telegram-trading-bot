export const NetworkMap: Record<string, any> = {
    'mainnet': {
        nativeCurrency: { name: 'Ether',  unit: 'ether',symbol: 'ETH', decimals: 18 },
        name: 'Ethereum',
        chainId: 1,
        rpcUrls: 'https://eth.merkle.io',
        erc20ContractAddress: {
            'USDC': process.env.USDC_CONTRACT_ADDRESS_MAINNET,
        },
    },
    'polygon': {
        nativeCurrency: { name: 'POL', unit: 'ether', symbol: 'POL', decimals: 18 },
        name: 'Polygon',
        chainId: 137,
        rpcUrls: 'https://polygon-rpc.com',
        erc20ContractAddress: {
            'USDC': null,
        },
    },
    'polygonAmoy': {
        nativeCurrency: { name: 'POL', unit: 'ether', symbol: 'POL', decimals: 18 },
        name: 'Polygon Amoy',
        chainId: 80002,
        rpcUrls: 'https://rpc-amoy.polygon.technology',
        erc20ContractAddress: {
            'USDC': process.env.USDC_CONTRACT_ADDRESS_POLYGON_AMOY,
        },
    },
    'sepolia': {
        nativeCurrency: { name: 'Sepolia Ether',  unit: 'ether',symbol: 'ETH', decimals: 18 },
        name: 'Sepolia',
        chainId: 11155111,
        rpcUrls: 'https://sepolia.drpc.org',
        erc20ContractAddress: {
            'USDC': process.env.USDC_CONTRACT_ADDRESS_SEPOLIA,
        },
    },
};

export const TokenMap: Record<string, any> = {
    'USDC': {
        symbol: 'ETH',
        decimals: 6,
        unit: 'mwei',
    },
    'USDT': {
        symbol: 'ETH',
        decimals: 6,
        unit: 'mwei',
    },
    'ETH': {
        symbol: 'ETH',
        decimals: 18,
        unit: 'ether',
    },
    'POL': {
        symbol: 'POL',
        decimals: 18,
        unit: 'ether',
    },
};