import {ethers} from "ethers";

export class EthersService {
  // private PRIVATE_KEY = "";
  // private WALLET_ADDRESS = "";

  // constructor() {}

  public async signMessage(walletAddress: string, privateKey: string, message: string): Promise<string> {
    try {
      // ✅ Create a wallet instance with the private key
      const wallet = new ethers.Wallet(privateKey);

      // ✅ Check if the private key corresponds to the given wallet address
      if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
        throw new Error("Private key does not match the given wallet address!");
      }

      // ✅ Sign the message
      // console.log(`📜 Signed Message: ${signedMessage}`);

      return await wallet.signMessage(message);
    } catch (error) {
      console.error("❌ Error signing message:", error);
      throw error;
    }

  }

  public async transferERC20Token(chainInfo: any, walletAddress: string, privateKey: string, erc20Token: string, amount: number, toAddress: string): Promise<string> {
    // ✅ ERC-20 ABI (Minimal for transfer function)
    const ERC20_ABI = [
      "function transfer(address to, uint256 amount) public returns (bool)"
    ];

    try {
      // ✅ Initialize ethers.js Provider & Wallet
      const provider = new ethers.JsonRpcProvider(chainInfo.rpcUrls);
      const wallet = new ethers.Wallet(privateKey, provider);

      // ✅ Connect to USDC Contract
      const usdcContract = new ethers.Contract(chainInfo.erc20ContractAddress[erc20Token], ERC20_ABI, wallet);

      console.log(`🔹 Sending ${amount} USDC to ${toAddress}...`);

      // ✅ Convert amount to USDC decimals (6 decimals: 1 USDC = 1,000,000)
      const parsedAmount = ethers.parseUnits(amount.toString(), 6);

      // ✅ Call transfer function
      const tx = await usdcContract.transfer(toAddress, parsedAmount);

      console.log("📨 Transaction Sent! Hash:", tx.hash);

      await tx.wait();

      // ✅ Wait for transaction confirmation
      console.log("✅ Transaction Confirmed:", tx.hash);

      return tx.hash;
    } catch (error) {
      console.error(`❌ Error Sending ${erc20Token}:`, error);
      throw error;
    }

  }

}

export const EthersFeedSvc = new EthersService();