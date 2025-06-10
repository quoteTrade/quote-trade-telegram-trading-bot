type Auth = {
    id: number,
    requestToken: string,
    requestSecret: string,
    walletAddress: string,
    privateKey: string,
};

const authsMap: Map<string, Auth> = new Map();

export function setAuth(chatId: string | number, auth: any): void {
    const key = chatId.toString();
    authsMap.set(key, auth);
}

export function getAuth(chatId: string | number): Auth | undefined {
    return authsMap.get(chatId.toString());
}

export function deleteAuth(chatId: string | number): void {
    authsMap.delete(chatId.toString());
}
