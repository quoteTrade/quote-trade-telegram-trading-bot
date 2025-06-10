import {ethers} from "ethers";

import {HttpSvc} from "./utils/http.service";
import {PriceFeedSvc} from "./utils/price-feed.service";
import {EthersFeedSvc} from "./utils/ethers.service";
import {UserDataStreamService} from "./utils/user-data-stream.service";
import {TokenMap} from "./constant/block-chain-info";

class BotService {
  constructor() {}

  public async getMatchingPrice(symbol: string, quantity: number) {
    return new Promise((resolve, reject) => {
      PriceFeedSvc.getPrices(symbol).then((orderBookResult) => {
        const matchingPrice = PriceFeedSvc.fetchMaxMatchingPrices(orderBookResult, quantity);
        resolve(matchingPrice);
      }).catch(error => {
        reject(error);
      });
    });
  }

  public async getSymbolsList(skip: number, limit: number, config: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      HttpSvc.get(`/getInstrumentPairs?skip=${skip}&limit=${limit}`, config)
          .then((data: any) => {
            let symbolsList = [];
            // console.log(data);
            for (const pair of data?.instrumentPairs || []) {
              symbolsList.push(pair);
            }
            resolve({symbolsList, totalNumberOfRecodes: data.count || 1});
          })
          .catch((error) => {
            reject(error);
          });
    });
  }

  public async placeOrder(reqBody: any, config: any = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const formattedReq = {
        "liquidityOrder": 1,
        "account": reqBody.account,
        "symbol": reqBody.symbol,
        "side": reqBody.side,
        "type": reqBody.type,
        // "price": reqBody.price,
        "quantity": reqBody.quantity,
        "disableLeverage": reqBody.disableLeverage,
        "paymentCurrency": reqBody.paymentCurrency,
        "timestamp": reqBody.timestamp || new Date().getTime(),
        "stake": reqBody.stake || 0,
        "stakeOption": reqBody.stakeOption || 0
      };

      HttpSvc.post(`/order`, formattedReq, config)
          .then((data) => {
            resolve(data);
          })
          .catch((error) => {
            reject(error);
          });
    });
  }

  public async authorization(walletAddress: string, privateKey: string, config: any = {}): Promise<any> {
    try {
      const challenge: any = await HttpSvc.post(`/getChallenge`, {login: walletAddress}, {});
      const signature = await EthersFeedSvc.signMessage(walletAddress, privateKey, challenge.challenge);

      const req = {
        challenge: challenge.challenge,
        signature: signature
      };

      let auth: any;

      if (challenge.isNewUser) {
        auth = await HttpSvc.post(`/registerUser`, req, {});
      } else {
        auth = await HttpSvc.post(`/logon`, req, {});
      }

      return auth;
    } catch (e: any) {
      throw new Error(e.message || e);
    }
  }

  public async getPositions(auth: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const UserDataStreamSvc = new UserDataStreamService();

      UserDataStreamSvc.getPositions(auth).then((positions) => {
        // console.log(positions);
        resolve(positions);
      }).catch(error => {
        reject(error);
      });
    });
  }

  public async getDepositAddress(config: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      HttpSvc.get(`/getDepositAddress`, config)
          .then((data: any) => {
            // console.log(data);
            resolve(data);
          })
          .catch((error) => {
            reject(error);
          });
    });
  }

  public async deposit(chainInfo: any, walletAddress: string, privateKey: string, token: string, amount: number, depositAddress: string): Promise<any> {
    try {
      return await EthersFeedSvc.transferERC20Token(chainInfo, walletAddress, privateKey, token, amount, depositAddress);
    } catch (e: any) {
      throw new Error(e.message || e);
    }
  }

  public async withdraw(reqBody: any, config: any = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const tokenInfo: any = TokenMap[reqBody.token]

      const formattedReq =  {
        "instrumentId": 0,
        "symbol": reqBody.token,
        "account": reqBody.account,
        "quantity": (ethers.parseUnits(reqBody.quantity.toString(), tokenInfo.decimals)).toString(),// scaled quantity (USDC 100,  quantity_scale = 6, then quntity = 100000000 = (100  * 10^6) )
        "quantityScale": tokenInfo.decimals,// quantity scale of the instrument
        "toAddress": reqBody.toAddress, // User's wallet address
        "address": reqBody.toAddress, // User's wallet address
      }

      HttpSvc.post(`/sendWithdrawWithVTokenRequest`, formattedReq, config)
          .then((data) => {
            resolve(data);
          })
          .catch((error) => {
            reject(error);
          });
    });
  }

}

export const BotSvc = new BotService();
