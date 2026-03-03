import * as vscode from 'vscode';
import { getCompletion, validateTokenAPI } from './apiClient';
import { getContext } from './contextProvider';
import { CodeairaInlineCompletionItemProvider } from './inlineCompletion';
import { TokenManager } from './tokenManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { RateLimiter } from './rateLimiter';
import { ChatViewProvider } from './chatViewProvider';
import { InlineChatProvider } from './inlineChatProvider';
import { CodeairaCodeActionProvider } from './codeActionProvider';

let tokenManager: TokenManager;
let workspaceIndexer: WorkspaceIndexer;
let rateLimiter: RateLimiter;
let chatProvider: ChatViewProvider;
let inlineChatProvider: InlineChatProvider;

export function activate(context: vscode.ExtensionContext) {
    console.log('Codeaira Copilot is now active!');

    tokenManager = new TokenManager(context);
    workspaceIndexer = new WorkspaceIndexer();
    rateLimiter = new RateLimiter();
    chatProvider = new ChatViewProvider(context.extensionUri, tokenManager, workspaceIndexer, context);
    inlineChatProvider = new InlineChatProvider(context.extensionUri, tokenManager);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType, 
            chatProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Trigger workspace indexing
    workspaceIndexer.indexWorkspace();

    // Track active file changes for context
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                workspaceIndexer.trackFileVisit(editor.document.uri.fsPath);
            }
        })
    );
    // Initial track
    if (vscode.window.activeTextEditor) {
        workspaceIndexer.trackFileVisit(vscode.window.activeTextEditor.document.uri.fsPath);
    }
    let disposable = vscode.commands.registerCommand('codeaira-copilot.askAgent', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Ask Codeaira Agent...',
            placeHolder: 'e.g., Refactor this function to be more efficient'
        });

        if (!prompt) {
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Codeaira is thinking...",
            cancellable: false
        }, async (progress: vscode.Progress<{ message?: string; increment?: number }>) => {
            try {
                if (!(await rateLimiter.checkAndRecord())) {
                    vscode.window.showWarningMessage('Codeaira API Rate limit exceeded. Please wait a moment.');
                    return;
                }

                const token = await tokenManager.retrieveToken();
                if (!token) {
                    vscode.window.showErrorMessage('Codeaira API Token is not set. Use "Codeaira: Store API Token" command.');
                    return;
                }
                const docContext = getContext(workspaceIndexer);
                const response = await getCompletion(prompt, token, docContext);
                
                // Show response in a new markdown document
                const doc = await vscode.workspace.openTextDocument({
                    content: response,
                    language: 'markdown'
                });
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Codeaira Error: ${error.message}`);
            }
        });
    });

    context.subscriptions.push(disposable);

    let storeTokenDisposable = vscode.commands.registerCommand('codeaira-copilot.storeToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Codeaira API Token',
            password: true,
            ignoreFocusOut: true
        });

        if (token) {
            await tokenManager.storeToken(token);
            vscode.window.showInformationMessage('Codeaira API Token stored securely.');
        }
    });

    context.subscriptions.push(storeTokenDisposable);

    let checkTokenDisposable = vscode.commands.registerCommand('codeaira-copilot.checkToken', async () => {
        const token = await tokenManager.retrieveToken();
        if (!token) {
            vscode.window.showWarningMessage('No Codeaira API Token is currently stored.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Verifying Codeaira API Token...",
            cancellable: false
        }, async () => {
            try {
                const isValid = await validateTokenAPI(token);
                if (isValid) {
                    vscode.window.showInformationMessage('✅ Codeaira API Token is Valid and Active.');
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`❌ Token Validation Failed: ${error.message}`);
            }
        });
    });

    context.subscriptions.push(checkTokenDisposable);

    let inlineGenerateDisposable = vscode.commands.registerCommand('codeaira-copilot.inlineGenerate', async () => {
        await inlineChatProvider.show();
    });

    context.subscriptions.push(inlineGenerateDisposable);

    let focusChatDisposable = vscode.commands.registerCommand('codeaira-copilot.focusChat', () => {
        vscode.commands.executeCommand('codeaira.chatView.focus');
    });

    context.subscriptions.push(focusChatDisposable);

    let sendToChatDisposable = vscode.commands.registerCommand('codeaira-copilot.sendToChat', async (promptPrefix: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const selection = editor.selection;
        const text = editor.document.getText(selection);
        const fullPrompt = `${promptPrefix}\n\nCode context:\n\`\`\`${editor.document.languageId}\n${text}\n\`\`\``;

        await vscode.commands.executeCommand('codeaira.chatView.focus');
        chatProvider.handleExternalPrompt(fullPrompt);
    });

    context.subscriptions.push(sendToChatDisposable);

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**' },
            new CodeairaCodeActionProvider(),
            { providedCodeActionKinds: CodeairaCodeActionProvider.providedCodeActionKinds }
        )
    );

    const inlineProvider = vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        new CodeairaInlineCompletionItemProvider(tokenManager, rateLimiter, workspaceIndexer)
    );
    context.subscriptions.push(inlineProvider);
    context.subscriptions.push(rateLimiter);
}

export function deactivate() {
    if (rateLimiter) {
        rateLimiter.dispose();
    }
}
