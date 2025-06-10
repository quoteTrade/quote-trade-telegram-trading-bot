import axios from 'axios';
import crypto from "crypto";

class HttpService {
  private readonly apiUrl: string;
  private readonly channel = 'LIQUIDITY';

  constructor() {
    this.apiUrl = `${process.env.API_BASE_URL}`;
    // this.requestSecret = `${process.env.TRADE_SECRET}`;
    // axios.defaults.headers.common['X-Mbx-Apikey'] = `${process.env.TRADE_API_KEY}`;
  }

  private getFullPath(path: string) {
    return path.includes("?") ? `${this.apiUrl}${path}&channel=${this.channel}` : `${this.apiUrl}${path}?channel=${this.channel}`;
  }

  public async get(path: string, config: any = {}): Promise<string> {
    // Simulating an API request
    const fullUrl = this.getFullPath(path);
    const configHeaders = {
      headers: config.headers || {},
    };
    if (config.requestSecret) {
      // Generate HMAC-SHA256 hash
      configHeaders.headers.signature = crypto.createHmac("sha256", config.requestSecret)
          .update(JSON.stringify(path))
          .digest("hex");
    }

    return new Promise((resolve, reject) => {
      axios
          .get(fullUrl, configHeaders)
          .then((response) => {
            // console.log(response);
            if (response.data) {
              if (response.data?.status === 'error') {
                reject(response.data);
              } else if (response.data?.error) {
                reject(response.data);
              } else {
                resolve(response.data);
              }
            } else {
              const resErr = { error: 'Not changed...' };
              reject(resErr);
            }
          })
          .catch((error) => {
            reject(error);
          });
    });
  }

  public async post(path: string, reqBody: any, config: any = {}): Promise<string> {
    // Simulating an API request
    const fullUrl = this.getFullPath(path);
    const configHeaders = {
      headers: config.headers || {},
    };

    reqBody.channel = this.channel;
    if (config.requestSecret) {
      // Generate HMAC-SHA256 hash
      configHeaders.headers.signature = crypto.createHmac("sha256", config.requestSecret)
          .update(JSON.stringify(reqBody))
          .digest("hex");
    }

    if (config.requestToken) {
      axios.defaults.headers.common['X-Mbx-Apikey'] = config.requestToken;
    }

    return new Promise((resolve, reject) => {
      axios
          .post(fullUrl, reqBody, configHeaders)
          .then((response) => {
            delete axios.defaults.headers.common['X-Mbx-Apikey'];

            // console.log(response);
            if (response.data) {
              if (response.data?.status === 'error') {
                reject(response.data);
              } else if (response.data?.error) {
                reject(response.data);
              } else {
                resolve(response.data);
              }
            } else {
              const resErr = { error: 'Not changed...' };
              reject(resErr);
            }
          })
          .catch((error) => {
            delete axios.defaults.headers.common['X-Mbx-Apikey'];
            reject(error);
          });
    });
  }

}

export const HttpSvc = new HttpService();
