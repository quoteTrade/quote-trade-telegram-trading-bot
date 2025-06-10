type UserState = {
    status: string;
    data: any;
};

const userStatesMap = new Map<string, UserState>();

export function setUserState(chatId: string | number, status: string, data: any): void {
    const key = chatId.toString();
    const existingState = userStatesMap.get(key);

    if (existingState) {
        existingState.status = status;
        existingState.data = { ...existingState.data, ...data };
    } else {
        userStatesMap.set(key, { status, data });
    }
}

export function getUserState(chatId: string | number): UserState | undefined {
    return userStatesMap.get(chatId.toString());
}

export function deleteUserState(chatId: string | number): void {
    userStatesMap.delete(chatId.toString());
}
