import * as vscode from 'vscode';

export class CodeairaCodeActionProvider implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.Refactor,
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        const actions: vscode.CodeAction[] = [];

        // 1. Inline Chat Action (Always available)
        const askAction = new vscode.CodeAction('✨ Ask Codeaira...', vscode.CodeActionKind.Refactor);
        askAction.command = {
            command: 'codeaira-copilot.inlineGenerate',
            title: 'Ask Codeaira...'
        };
        actions.push(askAction);

        // 2. Selection-based actions
        if (!range.isEmpty) {
            const explainAction = this.createCommandAction(
                '📖 Explain with Codeaira',
                'codeaira.chatView.focus',
                'Explain this code in detail.'
            );

            const refactorAction = this.createCommandAction(
                '🛠️ Refactor with Codeaira',
                'codeaira.chatView.focus',
                'Refactor this code to be cleaner and more efficient.'
            );

            actions.push(explainAction, refactorAction);
        }

        return actions;
    }

    private createCommandAction(title: string, commandId: string, promptPrefix: string): vscode.CodeAction {
        const action = new vscode.CodeAction(title, vscode.CodeActionKind.Refactor);
        // We'll use a hack to pass context to the chat view: 
        // We'll trigger the focus command and then the chat provider will see the selection.
        // In a more robust implementation, we'd have a specific command that takes the prompt.
        action.command = {
            command: 'codeaira-copilot.sendToChat',
            title: title,
            arguments: [promptPrefix]
        };
        return action;
    }
}
