declare const process: any;
declare const __dirname: string;
declare const Buffer: any;
declare function require(name: string): any;
declare namespace NodeJS { type Timeout = any; }

declare module "node:fs" {
  export const existsSync: any; export const mkdirSync: any; export const readFileSync: any; export const writeFileSync: any; export const renameSync: any;
}
declare module "node:path" { export const dirname: any; export const join: any; export const resolve: any; }
declare module "node:events" {
  export default class EventEmitter { on(event: string, listener: (...args:any[]) => void): this; once(event:string, listener:(...args:any[])=>void): this; off(event:string, listener:(...args:any[])=>void): this; emit(event:string, ...args:any[]): boolean; }
  export { EventEmitter };
}
declare module "node:crypto" { export const createHmac: any; export const createPrivateKey: any; export const sign: any; export const generateKeyPairSync: any; }
declare module "axios" { const axios: any; export default axios; }
declare module "dotenv" { export function config(): any; }
declare module "ws" {
  class WebSocket { static CONNECTING: number; static OPEN: number; readyState: number; constructor(url: string, protocols?: any); on(event: string, listener: (...args:any[]) => void): this; send(data: any): void; close(code?: number, reason?: string): void; }
  namespace WebSocket { type RawData = any; }
  export = WebSocket; export default WebSocket;
}
declare module "commander" {
  export class Command { name(v:string):this; description(v:string):this; helpOption(v:false|string):this; addHelpCommand(v:false|string):this; version(v:string, flags?:string, desc?:string):this; option(flags:string, desc?:string, parserOrDefault?:any, defaultValue?:any):this; requiredOption(flags:string, desc?:string, parserOrDefault?:any, defaultValue?:any):this; command(nameAndArgs:string):Command; action(fn:(...args:any[])=>any):this; opts():any; parse(argv?:string[]):this; }
}
declare module "node-telegram-bot-api" {
  class TelegramBot { constructor(token:string, options?:any); onText(regex:RegExp, callback:(msg:any, match:RegExpExecArray|null)=>void):void; sendMessage(chatId:any, text:string, options?:any):Promise<any>; }
  export = TelegramBot; export default TelegramBot;
}
declare module "ethers" { export const ethers: any; }
declare module "numeral" { const numeral: any; export default numeral; }
