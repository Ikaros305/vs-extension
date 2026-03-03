import * as vscode from 'vscode';
import { getCompletion } from './apiClient';
import { TokenManager } from './tokenManager';

const AVAILABLE_MODELS = [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'claude-3-7-sonnet@20250219', label: 'Claude 3.7' },
    { id: 'azure-gpt-4o', label: 'GPT-4o' },
];

export class InlineChatProvider {
    private _inset: vscode.WebviewEditorInset | undefined;
    private _currentEditor: vscode.TextEditor | undefined;
    private _selectedRange: vscode.Range | undefined;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _tokenManager: TokenManager
    ) {}

    public async show() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Open a file to use Codeaira Inline Generate.');
            return;
        }

        // Dispose any existing inset
        if (this._inset) {
            this._inset.dispose();
            this._inset = undefined;
        }

        this._currentEditor = editor;
        this._selectedRange = editor.selection.isEmpty
            ? undefined
            : new vscode.Range(editor.selection.start, editor.selection.end);

        const cursorLine = editor.selection.active.line;
        const INSET_HEIGHT = 4; // Height in lines

        try {
            console.log(`[Codeaira] Attempting to create inset at line ${cursorLine}`);
            
            // Proposed API — enabled via --enable-proposed-api=codeaira-copilot in launch.json
            if (typeof (vscode.window as any).createWebviewTextEditorInset === 'function') {
                this._inset = (vscode.window as any).createWebviewTextEditorInset(
                    editor,
                    cursorLine,
                    INSET_HEIGHT,
                    { 
                        enableScripts: true,
                        localResourceRoots: [this._extensionUri]
                    }
                );
                
                if (this._inset) {
                    console.log(`[Codeaira] Inset created successfully.`);
                    this._inset.webview.html = this._getInsetHtml();
                    this._inset.onDidDispose(() => { 
                        console.log(`[Codeaira] Inset disposed.`);
                        this._inset = undefined; 
                    });

                    this._inset.webview.onDidReceiveMessage(async (data: any) => {
                        switch (data.type) {
                            case 'submit':
                                this._inset?.dispose();
                                await this._handleGenerate(data.prompt, data.model);
                                break;
                            case 'cancel':
                                this._inset?.dispose();
                                break;
                        }
                    });
                }
            } else {
                console.warn('[Codeaira] createWebviewTextEditorInset is NOT a function. Falling back to InputBox.');
                await this._showInputBoxFallback();
            }
        } catch (err: any) {
            console.error(`[Codeaira] Error creating inset: ${err.message}`);
            await this._showInputBoxFallback();
        }
    }

    private async _showInputBoxFallback() {
        const editor = this._currentEditor;
        if (!editor) return;

        const picked = await vscode.window.showQuickPick(
            AVAILABLE_MODELS.map(m => ({ label: m.label, value: m.id })),
            { placeHolder: 'Select a model', title: '$(sparkle) Codeaira Inline Generate' }
        );
        if (!picked) return;

        const prompt = await vscode.window.showInputBox({
            title: `$(sparkle) Codeaira — ${(picked as any).label}`,
            prompt: editor.selection.isEmpty
                ? 'Generate code at cursor'
                : `Transform ${editor.selection.end.line - editor.selection.start.line + 1} selected lines`,
            placeHolder: 'Enter instruction...',
            ignoreFocusOut: false,
        });
        if (!prompt) return;
        await this._handleGenerate(prompt, (picked as any).value);
    }

    private async _handleGenerate(userPrompt: string, model: string) {
        const token = await this._tokenManager.retrieveToken();
        if (!token) {
            vscode.window.showErrorMessage('Set your API Token first: "Codeaira: Store API Token"');
            return;
        }

        const editor = this._currentEditor ?? vscode.window.activeTextEditor;
        if (!editor) return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `$(sparkle) Codeaira generating...`,
            cancellable: false
        }, async () => {
            try {
                const selection = this._selectedRange ?? editor.selection;
                const document = editor.document;
                const selectedText = document.getText(selection);

                const startLine = Math.max(0, selection.start.line - 20);
                const endLine = Math.min(document.lineCount - 1, selection.end.line + 20);
                const prefixContext = document.getText(
                    new vscode.Range(new vscode.Position(startLine, 0), selection.start)
                );
                const suffixContext = document.getText(
                    new vscode.Range(selection.end, new vscode.Position(endLine, document.lineAt(endLine).text.length))
                );

                const systemRule = 'Output ONLY raw code. No markdown fences, no explanations.';

                const prompt = selectedText
                    ? `${systemRule}\nTask: Transform the selected code.\nUser Request: ${userPrompt}\n\n<selected_code>\n${selectedText}\n</selected_code>\n\n<prefix_context>\n${prefixContext}\n</prefix_context>\n\n<suffix_context>\n${suffixContext}\n</suffix_context>\n\nTransformed Code:`
                    : `${systemRule}\nTask: Generate code at cursor position.\nUser Request: ${userPrompt}\n\n<prefix_context>\n${prefixContext}\n</prefix_context>\n\n<suffix_context>\n${suffixContext}\n</suffix_context>\n\nGenerated Code:`;

                const raw = await getCompletion(prompt, token, undefined, undefined, undefined, model);
                const cleaned = raw
                    .replace(/^```[a-z]*\n?/gm, '')
                    .replace(/^```\n?/gm, '')
                    .replace(/```$/gm, '')
                    .trim();

                await editor.edit(editBuilder => {
                    if (!selectedText || selection.isEmpty) {
                        editBuilder.insert(selection.start, cleaned);
                    } else {
                        editBuilder.replace(selection, cleaned);
                    }
                });

                this._selectedRange = undefined;
                vscode.window.setStatusBarMessage('$(sparkle) Codeaira: Done!', 3000);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Codeaira Error: ${err.message}`);
            }
        });
    }

    private _getInsetHtml(): string {
        const modelsHtml = AVAILABLE_MODELS.map((m, i) =>
            `<option value="${m.id}"${i === 0 ? ' selected' : ''}>${m.label}</option>`
        ).join('');

        return /* html */`<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    display: flex;
    align-items: center;
    height: 100vh;
    padding: 0 12px;
    gap: 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-focusBorder, #007acc66);
    border-radius: 6px;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    overflow: hidden;
    box-shadow: 0 4px 15px rgba(0,0,0,0.3);
  }

  .logo { font-size: 16px; flex-shrink: 0; user-select: none; }

  input[type="text"] {
    flex: 1;
    min-width: 0;
    background: transparent;
    color: var(--vscode-input-foreground, #ccc);
    border: none;
    outline: none;
    font-size: 13px;
    font-family: inherit;
    padding: 4px;
  }
  input[type="text"]::placeholder {
    color: var(--vscode-input-placeholderForeground, rgba(204,204,204,0.5));
  }

  .sep { width: 1px; height: 20px; background: rgba(255,255,255,0.1); flex-shrink: 0; }

  select {
    background: transparent;
    color: var(--vscode-descriptionForeground, #aaa);
    border: none;
    outline: none;
    font-size: 11px;
    cursor: pointer;
    flex-shrink: 0;
    font-family: inherit;
    padding-right: 12px;
  }

  button.send {
    background: var(--vscode-button-background, #007acc);
    border: none;
    border-radius: 4px;
    color: var(--vscode-button-foreground, white);
    cursor: pointer;
    padding: 4px 10px;
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  button.send:disabled { opacity: 0.5; }

  button.cancel {
    background: transparent;
    border: none;
    color: var(--vscode-descriptionForeground, #888);
    cursor: pointer;
    font-size: 18px;
    flex-shrink: 0;
  }
</style>
</head>
<body>
  <span class="logo">✨</span>
  <input type="text" id="promptInput" placeholder="Ask Codeaira..." autofocus>
  <div class="sep"></div>
  <select id="modelSelect">${modelsHtml}</select>
  <button class="send" id="sendBtn">Submit</button>
  <button class="cancel" id="cancelBtn" title="Cancel (Esc)">×</button>

<script>
  const vscode = acquireVsCodeApi();
  const input  = document.getElementById('promptInput');
  const send   = document.getElementById('sendBtn');
  const cancel = document.getElementById('cancelBtn');
  const model  = document.getElementById('modelSelect');

  function submit() {
    const prompt = input.value.trim();
    if (!prompt) return;
    send.disabled = true;
    send.textContent = '...';
    vscode.postMessage({ type: 'submit', prompt, model: model.value });
  }

  send.addEventListener('click', submit);
  cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { vscode.postMessage({ type: 'cancel' }); }
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); submit(); }
  });

  document.body.addEventListener('click', () => { input.focus(); });
  window.addEventListener('load', () => { input.focus(); });
</script>
</body>
</html>`;
    }
}
