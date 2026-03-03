import * as vscode from 'vscode';

export class RateLimiter {
    private requests: number[] = [];
    private readonly limit: number;
    private readonly windowMs: number;
    private statusBarItem: vscode.StatusBarItem;

    constructor(limit = 50, windowMs = 60000) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.text = `$(sync) Codeaira: Ready`;
        this.statusBarItem.show();
    }

    /**
     * Checks if a request can be made and records it.
     */
    async checkAndRecord(): Promise<boolean> {
        const now = Date.now();
        this.requests = this.requests.filter(timestamp => now - timestamp < this.windowMs);

        if (this.requests.length >= this.limit) {
            this.updateStatusBar(true);
            return false;
        }

        this.requests.push(now);
        this.updateStatusBar(false);
        return true;
    }

    /**
     * Updates the status bar with current usage info.
     */
    private updateStatusBar(isLimited: boolean) {
        const remaining = this.limit - this.requests.length;
        if (isLimited) {
            this.statusBarItem.text = `$(warning) Codeaira: Rate Limited`;
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            this.statusBarItem.text = `$(sync) Codeaira: ${remaining} left`;
            this.statusBarItem.backgroundColor = undefined;
        }
        this.statusBarItem.tooltip = `API Usage: ${this.requests.length}/${this.limit} requests in the last minute.`;
    }

    /**
     * Disposes the rate limiter and its UI elements.
     */
    dispose() {
        this.statusBarItem.dispose();
    }
}
