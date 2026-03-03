import * as vscode from 'vscode';
import { WorkspaceIndexer } from './workspaceIndexer';

export function getContext(indexer?: WorkspaceIndexer): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return '';
    }

    const document = editor.document;
    const selection = editor.selection;
    
    // Simple context: current file relative path and language
    let context = `File: ${vscode.workspace.asRelativePath(document.uri)}\nLanguage: ${document.languageId}\n\n`;
    
    if (indexer) {
        context += indexer.getWorkspaceSummary() + '\n\n';
    }
    
    // Add selected text if any
    if (!selection.isEmpty) {
        context += `Selected code:\n\`\`\`${document.languageId}\n${document.getText(selection)}\n\`\`\`\n\n`;
    }
    
    // Add some surrounding lines for more context
    const cursorLine = selection.active.line;
    const startLine = Math.max(0, cursorLine - 20);
    const endLine = Math.min(document.lineCount - 1, cursorLine + 20);
    
    context += `Content around cursor (lines ${startLine + 1} to ${endLine + 1}):\n\`\`\`${document.languageId}\n`;
    for (let i = startLine; i <= endLine; i++) {
        context += document.lineAt(i).text + '\n';
    }
    context += '\`\`\`';

    return context;
}
