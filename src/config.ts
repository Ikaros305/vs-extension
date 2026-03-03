import * as vscode from 'vscode';

export function getModelName(): string {
    return vscode.workspace.getConfiguration('codeaira').get('modelName') || 'gpt-4o';
}

export function getBaseUrl(): string {
    return vscode.workspace.getConfiguration('codeaira').get('baseUrl') || 'https://codeaira.qdatalabs.com/api';
}

export function getCompletionDelay(): number {
    return vscode.workspace.getConfiguration('codeaira').get('completionDelay') || 300;
}

