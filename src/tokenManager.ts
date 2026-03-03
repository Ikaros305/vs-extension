import * as vscode from 'vscode';

export interface ITokenManager {
    storeToken(token: string): Promise<void>;
    retrieveToken(): Promise<string | undefined>;
    validateToken(): Promise<boolean>;
    rotateToken(newToken: string): Promise<void>;
    clearToken(): Promise<void>;
    updateUsage(tokens: number): Promise<void>;
    getUsage(): number;
}

export class TokenManager implements ITokenManager {
    private static readonly TOKEN_KEY = 'codeaira_api_token';
    private static readonly USAGE_KEY = 'codeaira_token_usage';
    private _secrets: vscode.SecretStorage;
    private _context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this._secrets = context.secrets;
        this._context = context;
    }

    /**
     * Stores the API token securely using VS Code SecretStorage.
     */
    async storeToken(token: string): Promise<void> {
        await this._secrets.store(TokenManager.TOKEN_KEY, token);
    }

    /**
     * Retrieves the API token from secure storage.
     */
    async retrieveToken(): Promise<string | undefined> {
        return await this._secrets.get(TokenManager.TOKEN_KEY);
    }

    /**
     * Validates if a token exists and is in a plausible format.
     * Note: Full validation happens during API requests.
     */
    async validateToken(): Promise<boolean> {
        const token = await this.retrieveToken();
        return !!token && token.length > 0;
    }

    /**
     * Rotates the token by replacing the old one with a new one.
     */
    async rotateToken(newToken: string): Promise<void> {
        await this.storeToken(newToken);
    }

    /**
     * Clears the stored token.
     */
    async clearToken(): Promise<void> {
        await this._secrets.delete(TokenManager.TOKEN_KEY);
    }

    async updateUsage(tokens: number): Promise<void> {
        const current = this.getUsage();
        await this._context.workspaceState.update(TokenManager.USAGE_KEY, current + tokens);
    }

    getUsage(): number {
        return this._context.workspaceState.get<number>(TokenManager.USAGE_KEY) || 0;
    }
}
