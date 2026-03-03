import * as vscode from 'vscode';
import { getCompletion } from './apiClient';
import { getContext } from './contextProvider';
import { TokenManager } from './tokenManager';
import { RateLimiter } from './rateLimiter';
import { WorkspaceIndexer } from './workspaceIndexer';
import { CodeairaResponseParser } from './responseParser';

export class CodeairaInlineCompletionItemProvider implements vscode.InlineCompletionItemProvider {
    private responseParser = new CodeairaResponseParser();
    private loadingDecorationType = vscode.window.createTextEditorDecorationType({
        after: {
            contentText: ' ✨',
            margin: '0 0 0 4px',
            color: 'var(--vscode-editorSuggestWidget-foreground, #888)',
            fontStyle: 'italic',
        },
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });

    constructor(
        private tokenManager: TokenManager,
        private rateLimiter: RateLimiter,
        private indexer: WorkspaceIndexer
    ) {}

    async provideInlineCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.InlineCompletionContext,
        token: vscode.CancellationToken
    ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
        console.log(`[Codeaira] Inline completion triggered for ${document.fileName} at line ${position.line}`);
        
        const apiToken = await this.tokenManager.retrieveToken();
        if (!apiToken) {
            console.log('[Codeaira] Inline completion aborted: No API Token found.');
            return [];
        }

        if (!(await this.rateLimiter.checkAndRecord())) {
            console.log('[Codeaira] Inline completion aborted: Rate limit exceeded.');
            return [];
        }

        // Debouncing logic: wait 750ms before sending request for inline to avoid congestion
        console.log('[Codeaira] Debouncing for 750ms...');
        await new Promise(resolve => setTimeout(resolve, 750));
        if (token.isCancellationRequested) {
            console.log('[Codeaira] Inline completion cancelled during debounce.');
            return [];
        }

        // Only trigger if user didn't just delete something or if it's explicitly triggered
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
            // Empty file protection: don't trigger if the document is completely empty
            if (document.getText().trim().length === 0) {
                console.log('[Codeaira] Inline completion aborted: Document is completely empty.');
                return [];
            }
        }

        const editor = vscode.window.activeTextEditor;

        try {
            // Show loading indicator
            if (editor && editor.document === document) {
                editor.setDecorations(this.loadingDecorationType, [new vscode.Range(position, position)]);
            }

            // Link VS Code CancellationToken to AbortController
            const controller = new AbortController();
            token.onCancellationRequested(() => {
                console.log('[Codeaira] VS Code requested cancellation. Aborting API request.');
                controller.abort();
            });

            // Gather context
            const workspaceSummary = this.indexer.getWorkspaceSummary();
            const recentFiles = this.indexer.getRecentFiles()
                .map(f => vscode.workspace.asRelativePath(f))
                .join(', ');

            // Use a smaller context for inline but include prefix and suffix
            const startLine = Math.max(0, position.line - 15);
            const endLine = Math.min(document.lineCount - 1, position.line + 15);
            
            const prefixContext = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
            const suffixContext = document.getText(new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length)));

            const prompt = `Task: Generate up to 3 distinct code completions for the cursor position.
Rules:
1. Output ONLY the code to be inserted.
2. Separate distinct suggestions with '===CODEAIRA_DELIMITER==='.
3. NO markdown, NO explanations.
4. Smoothly bridge prefix and suffix.
5. If the completion uses a new symbol not present in context, add a trailing comment like: // Import: {SymbolName} from '{package}'

<workspace_context>
${workspaceSummary}
Recent Files: ${recentFiles}
</workspace_context>

<prefix_context>
${prefixContext}</prefix_context>

<suffix_context>
${suffixContext}</suffix_context>

Suggestions:`;
            
            console.log(`[Codeaira] Sending multi-suggestion request to API...`);
            const rawResponse = await getCompletion(prompt, apiToken, undefined, undefined, controller.signal);
            
            const suggestions = rawResponse.split('===CODEAIRA_DELIMITER===')
                .map(s => s.trim())
                .filter(s => s.length > 0)
                .slice(0, 3);

            const items: vscode.InlineCompletionItem[] = [];
            const lineText = document.lineAt(position).text;
            const linePrefix = lineText.substring(0, position.character);

            for (const suggestion of suggestions) {
                let cleaned = this.responseParser.cleanResponse(suggestion);
                
                // Heuristics
                if (cleaned.startsWith(linePrefix)) {
                    cleaned = cleaned.substring(linePrefix.length);
                }
                if (linePrefix.endsWith('{') && cleaned.startsWith('{')) {
                    cleaned = cleaned.substring(1);
                }

                if (cleaned.length > 0) {
                    const item = new vscode.InlineCompletionItem(cleaned);
                    item.range = new vscode.Range(position, position);
                    items.push(item);
                }
            }

            console.log(`[Codeaira] Returning ${items.length} completion suggestions.`);
            return items;
        } catch (error: any) {
            if (error.message === 'Request cancelled') {
                console.log('[Codeaira] Inline completion request was successfully cancelled.');
                return [];
            }
            console.error('[Codeaira] Inline completion error:', error);
            return [];
        } finally {
            // Clear loading indicator
            if (editor) {
                editor.setDecorations(this.loadingDecorationType, []);
            }
        }
    }
}
