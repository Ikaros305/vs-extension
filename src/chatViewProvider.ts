import * as vscode from 'vscode';
import * as path from 'path';
import { getCompletion } from './apiClient';
import { getContext } from './contextProvider';
import { TokenManager } from './tokenManager';
import { WorkspaceIndexer } from './workspaceIndexer';
import { WorkflowPlanner, Action, Plan } from './workflowPlanner';
import { ActionExecutor } from './actionExecutor';
import { GitUtils } from './gitUtils';

export interface ChatSession {
    id: string;
    title: string;
    messages: { role: string, content: string }[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codeaira.chatView';
    private _view?: vscode.WebviewView;
    private _sessions: ChatSession[] = [];
    private _activeSessionId: string | null = null;
    private _planner = new WorkflowPlanner();
    private _executor = new ActionExecutor();
    private _activePlan: Plan | null = null;
    private _trustedCommands: string[] = [];
    private _trustedPaths: string[] = [];
    private _abortController: AbortController | null = null;
    private _stopRequested: boolean = false;
    private _gitUtils: GitUtils | null = null;
    private _lastSnapshotName: string | null = null;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _tokenManager: TokenManager,
        private readonly _indexer: WorkspaceIndexer,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._trustedCommands = this._context.workspaceState.get<string[]>('trustedCommands', []);
        this._trustedPaths = this._context.workspaceState.get<string[]>('trustedPaths', []);
        this._sessions = this._context.workspaceState.get<ChatSession[]>('chatSessions', []);
        if (this._sessions.length > 0) {
            this._activeSessionId = this._sessions[this._sessions.length - 1].id;
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        const mediaPath = vscode.Uri.joinPath(this._extensionUri, 'media');
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri, mediaPath]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspacePath) {
            this._gitUtils = new GitUtils(workspacePath);
        }

        // Send initial state
        webviewView.webview.postMessage({ type: 'updateUsage', tokens: this._tokenManager.getUsage() });

        webviewView.webview.onDidReceiveMessage(async (data: any) => {
            switch (data.type) {
                case 'webviewLoaded':
                    this._updateWebviewSessions();
                    if (this._activeSessionId) {
                        const session = this._sessions.find(s => s.id === this._activeSessionId);
                        if (session) {
                            this._view?.webview.postMessage({ type: 'loadSession', messages: session.messages });
                        }
                    }
                    break;
                case 'sendMessage':
                    await this._handleSendMessage(data.value, data.model, data.flow, data.attachedContext);
                    break;
                case 'selectContextFiles': {
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: true,
                        canSelectFiles: true,
                        canSelectFolders: true,
                        openLabel: 'Attach to Context'
                    });
                    if (uris) {
                        const items = uris.map(u => ({ name: path.basename(u.fsPath), path: u.fsPath }));
                        this._view?.webview.postMessage({ type: 'updateContextArea', items });
                    }
                    break;
                }
                case 'addContextItems': {
                    if (data.items) {
                        this._view?.webview.postMessage({ type: 'updateContextArea', items: data.items });
                    }
                    break;
                }
                case 'newChat':
                    this._activeSessionId = Date.now().toString();
                    this._sessions.push({ id: this._activeSessionId, title: 'New Chat', messages: [] });
                    await this._saveSessions();
                    this._updateWebviewSessions();
                    this._view?.webview.postMessage({ type: 'loadSession', messages: [] });
                    break;
                case 'switchSession':
                    this._activeSessionId = data.sessionId;
                    const session = this._sessions.find(s => s.id === this._activeSessionId);
                    this._view?.webview.postMessage({ type: 'loadSession', messages: session ? session.messages : [] });
                    break;
                case 'executeAction': {
                    await this._runAction(data.planId, data.actionId);
                    break;
                }
                case 'cancelAction': {
                    if (this._activePlan && this._activePlan.id === data.planId) {
                        const action = this._activePlan.actions.find(a => a.id === data.actionId);
                        if (action) {
                            this._executor.cancelActionProcess(data.actionId);
                            action.status = 'cancelled';
                            this._view?.webview.postMessage({ type: 'actionStatus', planId: data.planId, actionId: data.actionId, status: 'cancelled' });
                        }
                    }
                    break;
                }
                case 'stopGeneration': {
                    if (this._abortController) {
                        this._abortController.abort();
                        this._abortController = null;
                    }
                    this._stopRequested = true;
                    // Also cancel currently running actions in active plan
                    if (this._activePlan) {
                        for (const action of this._activePlan.actions) {
                            if (action.status === 'running') {
                                this._executor.cancelActionProcess(action.id);
                            }
                        }
                    }
                    break;
                }
                case 'trustAction': {
                    if (this._activePlan && this._activePlan.id === data.planId) {
                        const action = this._activePlan.actions.find(a => a.id === data.actionId);
                        if (action) {
                            await this._trustSingleAction(action);
                            await this._runAction(data.planId, data.actionId);
                        }
                    }
                    break;
                }
                case 'runAllActions': {
                    this._stopRequested = false;
                    if (this._activePlan && this._activePlan.id === data.planId) {
                        // Create snapshot before bulk run
                        if (this._gitUtils) {
                            const snapshotName = await this._gitUtils.createSnapshot('bulk-run');
                            if (snapshotName) {
                                this._lastSnapshotName = snapshotName;
                                this._view?.webview.postMessage({ type: 'snapshotCreated', planId: data.planId, snapshotName });
                            }
                        }
                        for (const action of this._activePlan.actions) {
                            if (this._stopRequested) break;
                            if (action.status === 'pending') {
                                const success = await this._runAction(data.planId, action.id);
                                if (!success) break; // Stop on failure
                            }
                        }
                    }
                    break;
                }
                case 'rollback': {
                    if (this._gitUtils && data.snapshotName) {
                        const success = await this._gitUtils.rollback(data.snapshotName);
                        if (success) {
                            vscode.window.showInformationMessage('Workspace rolled back successfully.');
                            this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: 'Workspace rolled back to pre-execution state.' });
                        } else {
                            vscode.window.showErrorMessage('Rollback failed.');
                        }
                    }
                    break;
                }
                case 'cancelAllActions': {
                    if (this._activePlan && this._activePlan.id === data.planId) {
                        for (const action of this._activePlan.actions) {
                            if (action.status === 'pending' || action.status === 'running') {
                                if (action.status === 'running') this._executor.cancelActionProcess(action.id);
                                action.status = 'cancelled';
                                this._view?.webview.postMessage({ type: 'actionStatus', planId: data.planId, actionId: action.id, status: 'cancelled' });
                            }
                        }
                    }
                    break;
                }
                case 'trustAllActions': {
                    this._stopRequested = false;
                    if (this._activePlan && this._activePlan.id === data.planId) {
                        // Create snapshot
                        if (this._gitUtils) {
                            const snapshotName = await this._gitUtils.createSnapshot('trust-all');
                            if (snapshotName) {
                                this._lastSnapshotName = snapshotName;
                                this._view?.webview.postMessage({ type: 'snapshotCreated', planId: data.planId, snapshotName });
                            }
                        }
                        for (const action of this._activePlan.actions) {
                            if (this._stopRequested) break;
                            await this._trustSingleAction(action);
                            if (action.status === 'pending') {
                                const success = await this._runAction(data.planId, action.id);
                                if (!success) break; // Stop on failure
                            }
                        }
                    }
                    break;
                }
                case 'executePlan': {
                    if (this._activePlan && this._activePlan.id === data.planId) {
                        try {
                            await this._executor.executePlan(this._activePlan);
                            this._view?.webview.postMessage({ type: 'planApplied', planId: data.planId, success: true });
                            await this._updateProjectMemory(this._activePlan);
                        } catch (err: any) {
                            this._view?.webview.postMessage({ type: 'planApplied', planId: data.planId, success: false, error: err.message });
                        }
                    }
                    break;
                }
                case 'previewAction': {
                    await this._handlePreviewAction(data.planId, data.actionId);
                    break;
                }
                case 'getDiff': {
                    const diff = await this._handleGetDiff(data.planId, data.actionId);
                    this._view?.webview.postMessage({ type: 'actionDiff', planId: data.planId, actionId: data.actionId, diff });
                    break;
                }
            }
        });
    }

    /**
     * Allows external components (like Code Actions) to send prompts to the chat.
     */
    public handleExternalPrompt(prompt: string) {
        if (this._view) {
            this._view.show?.();
            this._view.webview.postMessage({ type: 'setPrompt', value: prompt });
        }
    }

    private async _saveSessions() {
        await this._context.workspaceState.update('chatSessions', this._sessions);
    }

    private _updateWebviewSessions() {
        if (!this._view) return;
        this._view.webview.postMessage({
            type: 'updateSessions',
            sessions: this._sessions.map(s => ({ id: s.id, title: s.title })),
            activeSessionId: this._activeSessionId
        });
    }

    private async _handleSendMessage(text: string, model: string, flow: string, attachedContext?: {name: string, path: string}[], role: 'user' | 'system' = 'user') {
        if (!this._view) {
            return;
        }

        // Create new session if none active
        if (!this._activeSessionId) {
            this._activeSessionId = Date.now().toString();
            this._sessions.push({
                id: this._activeSessionId,
                title: text.substring(0, 25) + (text.length > 25 ? '...' : ''),
                messages: []
            });
            this._updateWebviewSessions();
        }

        const activeSession = this._sessions.find(s => s.id === this._activeSessionId);
        if (!activeSession) return;

        // Add to history
        activeSession.messages.push({ role, content: text });
        await this._saveSessions();
        
        // Send message to UI
        this._view.webview.postMessage({ type: 'addMessage', role, content: text });

        // Handle Slash Commands
        if (text.startsWith('/')) {
            const handled = await this._handleSlashCommand(text);
            if (handled) return;
        }

        try {
            const token = await this._tokenManager.retrieveToken();
            if (!token) {
                this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: 'Please set your API token first using the "Codeaira: Store API Token" command.' });
                return;
            }

            const docContext = getContext(this._indexer);
            const semanticContext = await this._indexer.searchContext(text);
            
            let fullPrompt = text;
            if (semanticContext) {
                fullPrompt = `Supplemental relevant context found in workspace:\n${semanticContext}\n\n${fullPrompt}`;
            }

            let explicitContext = "";
            let attachedImages: string[] = [];
            if (attachedContext && attachedContext.length > 0) {
                explicitContext = "User explicitly attached the following context files for this request:\n";
                for (const item of attachedContext) {
                    try {
                        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(item.path));
                        const ext = path.extname(item.path).toLowerCase();
                        const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);

                        if (stat.type === vscode.FileType.File) {
                            const contentBytes = await vscode.workspace.fs.readFile(vscode.Uri.file(item.path));
                            if (isImage) {
                                attachedImages.push(Buffer.from(contentBytes).toString('base64'));
                            } else {
                                explicitContext += `\n--- file: ${item.path} ---\n${new TextDecoder('utf-8').decode(contentBytes)}\n`;
                            }
                        } else if (stat.type === vscode.FileType.Directory) {
                            const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(item.path));
                            explicitContext += `\n--- directory: ${item.path} ---\nContents: ${entries.map(e => e[0]).join(', ')}\n`;
                        }
                    } catch (e) {
                         explicitContext += `\n--- path: ${item.path} ---\n(Could not read path)\n`;
                    }
                }
                explicitContext += "\n";
            }

            if (flow === 'agent') {
                const systemPrompt = `You are Codeaira, an advanced agentic coding assistant.
When a task requires multiple steps (creating files, folder, or running terminal commands), you MUST generate a JSON execution plan.

Quality Guardrails:
- Whenever you create a NEW source file, you MUST also propose a corresponding UNIT TEST file.
- Use the 'git' action type for version control (type: "git", path: "commit"|"branch", content: "message"|"branchName").
- Ensure all commands are appropriate for the project type (e.g., npm for Node, pip for Python).

JSON Plan Schema:
{
  "description": "Overall plan goal",
  "actions": [
    {
      "type": "createFile" | "modifyFile" | "deleteFile",
      "path": "relative/path/to/file",
      "content": "Full content",
      "description": "Why this action?"
    },
    {
      "type": "command",
      "path": "npm",
      "arguments": ["test"],
      "description": "Run tests"
    },
    {
      "type": "git",
      "path": "commit",
      "content": "Feat: implement fibonacci",
      "description": "Commit changes"
    }
  ]
}

Only output JSON if a plan is required.
Current Workspace Context:
${docContext}`;

                fullPrompt = `${systemPrompt}\n\n${explicitContext}User Request: ${text}`;
            } else {
                fullPrompt = `You are Codeaira, a helpful coding assistant. 
Current Workspace Context:
${docContext}

${explicitContext}User Request: ${text}`;
            }

            // Combine history for context
            let historyPrompt = "";
            if (activeSession.messages.length > 1) { 
                historyPrompt = "Previous Conversation:\n" + activeSession.messages.slice(0, -1).map(m => `${m.role}: ${m.content}`).join('\n') + "\n\n";
                fullPrompt = historyPrompt + fullPrompt;
            }
            
            this._view.webview.postMessage({ type: 'startAssistantMessage' });
            this._view.webview.postMessage({ type: 'generationState', active: true });

            this._abortController = new AbortController();
            this._stopRequested = false;

            let response = "";
            if (flow === 'agent') {
                // 1. Draft Plan
                this._view.webview.postMessage({ type: 'addMessage', role: 'system', content: 'Agent is drafting an initial plan...' });
                const draft = await getCompletion(fullPrompt, token, undefined, undefined, this._abortController.signal, model, attachedImages);
                
                // 2. Self-Reflection
                this._view.webview.postMessage({ type: 'addMessage', role: 'system', content: 'Agent is critiquing and refining the plan...' });
                const critiquePrompt = `Analyze the following proposal for potential bugs, missing files (like tests), or security issues. Then, provide an IMPROVED and FINAL version of the implementation plan in the same JSON format.\n\nPROPOSAL:\n${draft}`;
                
                response = await getCompletion(critiquePrompt, token, undefined, (chunk: string) => {
                    this._view?.webview.postMessage({ type: 'updateAssistantMessage', content: chunk });
                }, this._abortController.signal, model, attachedImages);
            } else {
                response = await getCompletion(fullPrompt, token, undefined, (chunk: string) => {
                    this._view?.webview.postMessage({ type: 'updateAssistantMessage', content: chunk });
                }, this._abortController.signal, model, attachedImages);
            }

            this._abortController = null;

            activeSession.messages.push({ role: 'assistant', content: response });
            await this._saveSessions();
            
            // Update token usage estimate
            const estimatedTokens = Math.ceil((fullPrompt.length + response.length) / 4);
            await this._tokenManager.updateUsage(estimatedTokens);
            this._view?.webview.postMessage({ type: 'updateUsage', tokens: this._tokenManager.getUsage() });

            if (flow === 'agent') {
                const plan = this._planner.parsePlan(response);
                if (plan.actions.length > 0) {
                    this._activePlan = plan; // Store globally for this provider
                    
                    // Check for trusted commands
                    for (const action of plan.actions) {
                        if (action.type === 'command' && this._trustedCommands.includes(action.path)) {
                            action.status = 'running'; // Mark as auto-starting
                        }
                    }

                    this._view.webview.postMessage({ 
                        type: 'planGenerated', 
                        planId: plan.id, 
                        description: plan.description,
                        actions: plan.actions.map(a => ({ 
                            id: a.id,
                            type: a.type, 
                            path: a.path,
                            description: a.description,
                            arguments: a.arguments,
                            status: a.status
                        })) 
                    });

                    // Auto-execute trusted actions sequentially
                    for (const action of plan.actions) {
                        const isTrusted = action.type === 'command' 
                            ? this._trustedCommands.includes(action.path)
                            : this._trustedPaths.includes(action.path);
                        
                        if (isTrusted) {
                             const success = await this._runAction(plan.id, action.id);
                             if (!success) break;
                        } else {
                             // Stop auto-executing when we hit an untrusted action to preserve sequential order
                             break;
                        }
                    }
                }
            }
            this._view.webview.postMessage({ type: 'generationState', active: false });
        } catch (error: any) {
            this._abortController = null;
            this._view?.webview.postMessage({ type: 'generationState', active: false });
            if (error.message === 'Request cancelled') {
                this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `*Generation stopped by user.*` });
                return;
            }
            this._view.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `Error: ${error.message}` });
        }
    }

    private async _handleSlashCommand(commandLine: string): Promise<boolean> {
        const [command, ...args] = commandLine.trim().split(/\s+/);
        
        switch (command.toLowerCase()) {
            case '/test':
                this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: 'Running project tests...' });
                await this._executor.executeAction({
                    id: 'slash-test-' + Date.now(),
                    type: 'command',
                    path: 'npm',
                    arguments: ['test'],
                    description: 'Run project tests',
                    status: 'pending'
                }, (output) => {
                    this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: `\`\`\`\n${output}\n\`\`\`` });
                });
                return true;
            case '/lint':
                this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: 'Linting src directory...' });
                await this._executor.executeAction({
                    id: 'slash-lint-' + Date.now(),
                    type: 'command',
                    path: 'npm',
                    arguments: ['run', 'lint'],
                    description: 'Run project linter',
                    status: 'pending'
                }, (output) => {
                    this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: `\`\`\`\n${output}\n\`\`\`` });
                });
                return true;
            case '/rollback':
                if (this._lastSnapshotName) {
                    this._view?.webview.postMessage({ type: 'rollback', planId: 'slash', snapshotName: this._lastSnapshotName });
                    return true;
                }
                this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: 'No snapshot available to rollback.' });
                return true;
            case '/clear':
                const session = this._sessions.find(s => s.id === this._activeSessionId);
                if (session) {
                    session.messages = [];
                    await this._saveSessions();
                    this._view?.webview.postMessage({ type: 'loadSession', messages: [] });
                }
                return true;
            case '/memory':
                try {
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                    if (workspaceFolder) {
                        const memoryUri = vscode.Uri.joinPath(workspaceFolder.uri, '.codeaira', 'project_memory.md');
                        const content = (await vscode.workspace.fs.readFile(memoryUri)).toString();
                        this._view?.webview.postMessage({ type: 'addMessage', role: 'assistant', content: `### Project Memory\n\n${content}` });
                    }
                } catch (e) {
                    this._view?.webview.postMessage({ type: 'addMessage', role: 'system', content: 'No project memory found yet. Complete a task to generate it.' });
                }
                return true;
            default:
                return false;
        }
    }

    private async _updateProjectMemory(plan: Plan) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        const memoryDir = vscode.Uri.joinPath(workspaceFolder.uri, '.codeaira');
        const memoryUri = vscode.Uri.joinPath(memoryDir, 'project_memory.md');

        try {
            await vscode.workspace.fs.createDirectory(memoryDir);
            let existingContent = "";
            try {
                existingContent = (await vscode.workspace.fs.readFile(memoryUri)).toString();
            } catch (e) {}

            const newEntry = `\n## Task: ${new Date().toLocaleString()}\n- **Description**: ${plan.description}\n- **Actions**: ${plan.actions.length} applied successfully.\n`;
            await vscode.workspace.fs.writeFile(memoryUri, Buffer.from(existingContent + newEntry));
            console.log('[Codeaira] Project memory updated.');
        } catch (err) {
            console.error('[Codeaira] Failed to update project memory:', err);
        }
    }

    private async _handleActionFailure(action: Action, error: string) {
        if (!this._view) return;
        
        // 1. Get AI explanation
        const explanationPrompt = `The action "${action.type}" for path "${action.path}" FAILED with the following error/output:
\`\`\`
${error}
\`\`\`
Provide a concise explanation of WHY this failed and what needs to be done to fix it.`;

        try {
            const token = await this._tokenManager.retrieveToken();
            if (token) {
                this._view.webview.postMessage({ type: 'startAssistantMessage' });
                const explanation = await getCompletion(explanationPrompt, token, undefined, (chunk: string) => {
                    this._view?.webview.postMessage({ type: 'updateAssistantMessage', content: chunk });
                });
                // Store in history
                const session = this._sessions.find(s => s.id === this._activeSessionId);
                if (session) session.messages.push({ role: 'assistant', content: explanation });
            }
        } catch (aiErr) {
            console.error('Failed to get AI explanation:', aiErr);
        }

        // 2. Automatically trigger fix attempt as a system message
        const feedbackPrompt = `The action "${action.type}" for path "${action.path}" FAILED. 
Error: ${error}

Please automatically try to fix this issue by generating a new JSON Execution Plan. If the issue cannot be resolved automatically (e.g., requires external manual login or user choice), provide a clear explanation and ask the user for intervention without providing a JSON plan.`;

        // Send this as a SYSTEM-led auto-fix trigger so it's hidden or distinguished
        const session = this._sessions.find(s => s.id === this._activeSessionId);
        if (session) {
            const activeModel = "gemini-2.5-flash"; // Default or should we detect? For now flash.
            await this._handleSendMessage(feedbackPrompt, activeModel, 'agent', undefined, 'system');
        }
    }

    private async _handlePreviewAction(planId: string, actionId: string) {
        if (!this._activePlan || this._activePlan.id !== planId) return;
        const action = this._activePlan.actions.find(a => a.id === actionId);
        if (!action) return;

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;

        try {
            switch (action.type) {
                case 'createFile': {
                    const tempUri = vscode.Uri.file(path.join(this._context.extensionPath, 'preview_' + path.basename(action.path)));
                    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(action.content || ''));
                    const doc = await vscode.workspace.openTextDocument(tempUri);
                    await vscode.window.showTextDocument(doc, { preview: true });
                    break;
                }
                case 'modifyFile': {
                    const fullPath = path.isAbsolute(action.path) ? action.path : path.join(workspaceFolder.uri.fsPath, action.path);
                    const originalUri = vscode.Uri.file(fullPath);
                    const newContent = action.content || '';
                    const tempUri = vscode.Uri.file(path.join(this._context.extensionPath, 'modified_' + path.basename(action.path)));
                    await vscode.workspace.fs.writeFile(tempUri, Buffer.from(newContent));
                    
                    await vscode.commands.executeCommand('vscode.diff', originalUri, tempUri, `Diff: ${path.basename(action.path)} (Proposed Change)`);
                    break;
                }
                case 'deleteFile':
                case 'command':
                case 'git': {
                    // For file deletion, just open the file.
                    if (action.path && action.type === 'deleteFile') {
                        const fullPath = path.isAbsolute(action.path) ? action.path : path.join(workspaceFolder.uri.fsPath, action.path);
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fullPath));
                        await vscode.window.showTextDocument(doc, { preview: true });
                    }
                    break;
                }
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open preview: ${err.message}`);
        }
    }

    private async _handleGetDiff(planId: string, actionId: string): Promise<string> {
        if (!this._activePlan || this._activePlan.id !== planId) return "No active plan.";
        const action = this._activePlan.actions.find(a => a.id === actionId);
        if (!action) return "Action not found.";
        if (action.type !== 'modifyFile') return "Diff only available for modifications.";

        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) return "No workspace folder.";
            const fullPath = path.isAbsolute(action.path) ? action.path : path.join(workspaceFolder.uri.fsPath, action.path);
            const originalContent = (await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath))).toString();
            const newContent = action.content || '';

            return this._simpleDiff(originalContent, newContent);
        } catch (e: any) {
            return `Error generating diff: ${e.message}`;
        }
    }

    private _simpleDiff(oldStr: string, newStr: string): string {
        const oldLines = oldStr.split(/\r?\n/);
        const newLines = newStr.split(/\r?\n/);
        let diff = "";
        
        let i = 0, j = 0;
        while (i < oldLines.length || j < newLines.length) {
            if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
                diff += `  ${oldLines[i]}\n`;
                i++; j++;
            } else {
                // Simplified diff: show all old then all new
                if (i < oldLines.length) {
                    diff += `- ${oldLines[i]}\n`;
                    i++;
                }
                if (j < newLines.length) {
                    diff += `+ ${newLines[j]}\n`;
                    j++;
                }
            }
        }
        return diff;
    }

    private async _trustSingleAction(action: Action) {
        if (action.type === 'command') {
            if (!this._trustedCommands.includes(action.path)) {
                this._trustedCommands.push(action.path);
                await this._context.workspaceState.update('trustedCommands', this._trustedCommands);
            }
        } else {
            if (!this._trustedPaths.includes(action.path)) {
                this._trustedPaths.push(action.path);
                await this._context.workspaceState.update('trustedPaths', this._trustedPaths);
            }
        }
    }

    private async _runAction(planId: string, actionId: string): Promise<boolean> {
        if (!this._activePlan || this._activePlan.id !== planId) return false;
        const action = this._activePlan.actions.find(a => a.id === actionId);
        if (!action) return false;

        try {
            action.status = 'running';
            this._view?.webview.postMessage({ type: 'actionStatus', planId, actionId, status: 'running' });
            
            const result = await this._executor.executeAction(action, (chunk) => {
                this._view?.webview.postMessage({ 
                    type: 'actionOutput', 
                    planId, 
                    actionId, 
                    output: chunk 
                });
            });
            
            if (result.success) {
                action.status = 'success';
                this._view?.webview.postMessage({ 
                    type: 'actionStatus', 
                    planId, 
                    actionId, 
                    status: 'success',
                    output: result.output 
                });
                return true;
            } else {
                action.status = 'failed';
                const errorText = result.error || result.output;
                this._view?.webview.postMessage({ 
                    type: 'actionStatus', 
                    planId, 
                    actionId, 
                    status: 'failed', 
                    error: errorText,
                    output: result.output
                });
                await this._handleActionFailure(action, errorText);
                return false;
            }
        } catch (err: any) {
            action.status = 'failed';
            this._view?.webview.postMessage({ 
                type: 'actionStatus', 
                planId, 
                actionId, 
                status: 'failed', 
                error: err.message 
            });
            return false;
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const mediaUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media'));
        const markedUri = `${mediaUri}/marked.min.js`;
        const hlJsUri = `${mediaUri}/highlight.min.js`;
        const hlCssUri = `${mediaUri}/github-dark.css`;

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; connect-src https:;">
                <link rel="stylesheet" href="${hlCssUri}">
                <script src="${markedUri}"></script>
                <script src="${hlJsUri}"></script>
                <style>
                    :root {
                        --accent-color: var(--vscode-button-background, #007acc);
                        --bg-color: var(--vscode-sideBar-background);
                        --card-bg: var(--vscode-editor-background);
                        --border-color: var(--vscode-panel-border);
                        --text-color: var(--vscode-foreground);
                        --user-msg-bg: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.1));
                        --assistant-msg-bg: var(--vscode-editor-background);
                        --muted-text: var(--vscode-descriptionForeground, #888);
                    }
                    body { 
                        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
                        color: var(--text-color); 
                        background-color: var(--bg-color); 
                        padding: 0; margin: 0; 
                        display: flex; flex-direction: column; height: 100vh; 
                        overflow: hidden;
                    }
                    .header {
                        padding: 12px 16px; border-bottom: 1px solid var(--border-color);
                        display: flex; flex-direction: column; gap: 12px;
                        background: var(--card-bg);
                    }
                    .header-top { display: flex; justify-content: space-between; align-items: center; }
                    .ai-title { font-weight: 600; font-size: 14px; display: flex; align-items: center; gap: 8px; }
                    .status-badge { 
                        font-size: 10px; color: #4ec9b0; display: flex; align-items: center; gap: 4px; 
                        background: rgba(78, 201, 176, 0.1); padding: 2px 6px; border-radius: 10px;
                    }
                    .status-dot { width: 6px; height: 6px; background: #4ec9b0; border-radius: 50%; }
                    
                    .header-actions { display: flex; gap: 8px; align-items: center; }
                    .select-group { display: flex; gap: 4px; align-items: center; width: 100%; }
                    
                    select {
                        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                        border: 1px solid var(--border-color); border-radius: 4px; padding: 4px; font-size: 11px;
                        outline: none; cursor: pointer; flex-grow: 1;
                    }
                    .icon-btn {
                        background: transparent; color: var(--text-color); border: none;
                        padding: 4px; border-radius: 4px; cursor: pointer;
                        display: flex; align-items: center; justify-content: center;
                        opacity: 0.7; transition: all 0.2s;
                    }
                    .icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
                    
                    .messages { 
                        flex-grow: 1; overflow-y: auto; padding: 16px; 
                        display: flex; flex-direction: column; gap: 20px;
                    }
                    .message-container { display: flex; gap: 12px; }
                    .message-container.user { flex-direction: row-reverse; }
                    
                    .avatar {
                        width: 24px; height: 24px; border-radius: 50%;
                        display: flex; align-items: center; justify-content: center;
                        flex-shrink: 0; margin-top: 4px;
                    }
                    .avatar.assistant { background: var(--accent-color); color: white; }
                    .avatar.user { background: var(--user-msg-bg); border: 1px solid var(--border-color); }
                    
                    .message { 
                        max-width: 85%; padding: 10px 14px; border-radius: 8px; 
                        line-height: 1.5; font-size: 13px; position: relative;
                        animation: fadeIn 0.2s ease-out;
                        border: 1px solid transparent;
                    }
                    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
                    
                    .user .message { 
                        background-color: var(--user-msg-bg); 
                        border-color: var(--border-color);
                        align-self: flex-end; 
                    }
                    .assistant .message { 
                        background-color: var(--assistant-msg-bg); 
                        border-color: var(--border-color);
                        align-self: flex-start; 
                    }
                    
                    .assistant pre { 
                        background-color: #1e1e1e; padding: 12px; border-radius: 6px; 
                        overflow-x: auto; margin: 12px 0; border: 1px solid rgba(255,255,255,0.05);
                        position: relative;
                    }
                    .copy-btn {
                        position: absolute; top: 8px; right: 8px;
                        background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.1);
                        color: #ccc; border-radius: 4px; padding: 2px 6px; font-size: 10px;
                        cursor: pointer; opacity: 0; transition: opacity 0.2s;
                    }
                    pre:hover .copy-btn { opacity: 1; }
                    .copy-btn:hover { background: rgba(255,255,255,0.2); color: white; }

                    .assistant code { font-family: var(--vscode-editor-font-family, 'Fira Code', monospace); font-size: 12px; }
                    
                    .message-footer {
                        display: flex; gap: 12px; margin-top: 6px; opacity: 0; transition: opacity 0.2s;
                    }
                    .message-container:hover .message-footer { opacity: 0.6; }
                    .feedback-btn { font-size: 14px; cursor: pointer; transition: transform 0.1s; }
                    .feedback-btn:hover { transform: scale(1.2); opacity: 1; }

                    .plan-card {
                        margin-top: 12px; padding: 12px; border-radius: 8px;
                        background: rgba(255, 255, 255, 0.03);
                        border: 1px solid var(--border-color);
                        display: flex; flex-direction: column; gap: 10px;
                    }
                    .plan-header { 
                        font-weight: 600; color: var(--accent-color); 
                        display: flex; align-items: center; gap: 6px; 
                        font-size: 11px; text-transform: uppercase;
                        letter-spacing: 0.5px;
                    }
                    .plan-bulk-actions {
                        display: flex; gap: 8px; margin-bottom: 4px;
                        padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);
                    }
                    .bulk-btn {
                        flex: 1; padding: 4px; font-size: 10px; font-weight: 600;
                        border-radius: 4px; border: 1px solid var(--border-color);
                        background: rgba(255, 255, 255, 0.05); color: var(--text-color);
                        cursor: pointer; transition: all 0.2s;
                    }
                    .bulk-btn:hover { background: rgba(255, 255, 255, 0.1); border-color: var(--accent-color); }
                    .bulk-btn.primary { background: var(--accent-color); color: white; border: none; }
                    .bulk-btn.danger { color: #dc3545; border-color: rgba(220, 53, 69, 0.3); }
                    
                    .plan-actions { display: flex; flex-direction: column; gap: 8px; }
                    .plan-action-item { 
                        display: flex; flex-direction: column; gap: 6px; 
                        padding: 8px; background: rgba(255,255,255,0.02);
                        border: 1px solid rgba(255,255,255,0.05);
                        border-radius: 6px;
                    }
                    .action-header { display: flex; align-items: center; justify-content: space-between; }
                    .action-type { font-size: 9px; padding: 2px 5px; border-radius: 4px; text-transform: uppercase; font-weight: bold; }
                    .type-create { background: rgba(40, 167, 69, 0.2); color: #28a745; }
                    .type-modify { background: rgba(226, 185, 49, 0.2); color: #e2b931; }
                    .type-delete { background: rgba(220, 53, 69, 0.2); color: #dc3545; }
                    .type-command { background: rgba(0, 122, 204, 0.2); color: #569cd6; }
                    
                    .action-path { 
                        font-family: var(--vscode-editor-font-family); font-size: 11px; word-break: break-all; 
                        color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: underline;
                    }
                    .action-path:hover { color: var(--vscode-textLink-activeForeground); }
                    .action-desc { font-size: 11px; opacity: 0.7; }
                    .action-output { 
                        display: none; 
                        background: #000; 
                        color: #0f0; 
                        font-family: var(--vscode-editor-font-family, 'Courier New', Courier, monospace); 
                        font-size: 10px; 
                        padding: 8px; 
                        border-radius: 4px; 
                        margin-top: 8px; 
                        max-height: 200px; 
                        overflow: auto; 
                        white-space: pre-wrap;
                        border: 1px solid #333;
                        min-height: 0;
                        transition: min-height 0.2s;
                    }
                    .action-output:not(:empty) { border: 1px solid #444; }
                    .action-btns { display: flex; gap: 6px; margin-top: 4px; }
                    .diff-view {
                        background: #1e1e1e; color: #d4d4d4; padding: 6px; margin-top: 6px;
                        border-radius: 4px; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
                        font-size: 11px; white-space: pre-wrap; display: none;
                        border: 1px solid #333; max-height: 200px; overflow-y: auto;
                    }
                    .diff-add { color: #4ec9b0; }
                    .diff-remove { color: #ce9178; }

                    .mini-btn {
                        padding: 2px 8px; font-size: 10px; border-radius: 4px; border: 1px solid transparent;
                        cursor: pointer; background: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        transition: all 0.1s;
                    }
                    .mini-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    .message-container.system {
                        display: flex; justify-content: center; margin: 12px 0;
                    }
                    .message-container.system .message {
                        background: var(--vscode-badge-background, #333);
                        color: var(--vscode-badge-foreground, #ccc);
                        padding: 6px 16px; border-radius: 20px; font-size: 11px;
                        font-weight: 500; opacity: 0.9; box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                        border: 1px solid var(--vscode-border-color);
                    }
                    .avatar.system { display: none; }

                    .status-badge { font-size: 10px; font-weight: bold; }
                    .status-running { color: #569cd6; }
                    .status-success { color: #28a745; }
                    .status-failed { color: #dc3545; }
                    .status-cancelled { opacity: 0.5; }

                    .input-container { 
                        padding: 12px 16px; background-color: var(--bg-color); 
                        border-top: 1px solid var(--border-color); 
                        display: flex; flex-direction: column; gap: 8px;
                        position: relative;
                    }
                    .input-container.drag-over {
                        background-color: rgba(0, 122, 204, 0.1);
                        border-color: rgba(0, 122, 204, 0.5);
                    }
                    .context-area {
                        display: flex; flex-wrap: wrap; gap: 6px;
                        margin-bottom: 4px;
                        max-height: 80px; overflow-y: auto;
                    }
                    .context-area:empty { display: none; }
                    .context-pill {
                        background: var(--vscode-badge-background, #4d4d4d);
                        color: var(--vscode-badge-foreground, #ffffff);
                        padding: 2px 8px; border-radius: 12px; font-size: 10px;
                        display: flex; align-items: center; gap: 4px;
                    }
                    .context-pill-remove {
                        cursor: pointer; opacity: 0.7; border: none; background: none; color: inherit; padding: 0; font-size: 10px;
                    }
                    .context-pill-remove:hover { opacity: 1; }
                    .input-row { display: flex; gap: 8px; align-items: flex-end; }
                    .attach-btn {
                        background: none; border: none; color: var(--vscode-icon-foreground);
                        cursor: pointer; font-size: 16px; padding: 4px 6px; border-radius: 4px;
                        display: flex; align-items: center; justify-content: center; opacity: 0.7; transition: all 0.2s;
                    }
                    .attach-btn:hover { opacity: 1; background: var(--vscode-button-secondaryHoverBackground); }

                    textarea { 
                        flex-grow: 1; box-sizing: border-box; 
                        background: var(--vscode-input-background); 
                        color: var(--vscode-input-foreground); 
                        border: 1px solid var(--vscode-input-border); 
                        padding: 8px 10px; border-radius: 6px; 
                        resize: none; outline: none; font-size: 13px;
                        min-height: 36px; max-height: 120px;
                    }
                    textarea:focus { border-color: var(--vscode-focusBorder); }
                    
                    .send-btn {
                        background: var(--accent-color); color: white; border: none;
                        width: 32px; height: 32px; border-radius: 6px; cursor: pointer;
                        display: flex; align-items: center; justify-content: center;
                        flex-shrink: 0; transition: filter 0.2s;
                    }
                    .send-btn:hover { filter: brightness(1.1); }
                    .stop-btn {
                        background: #dc3545; color: white; border: none;
                        width: 32px; height: 32px; border-radius: 6px; cursor: pointer;
                        display: none; align-items: center; justify-content: center;
                        flex-shrink: 0; transition: filter 0.2s;
                    }
                    .stop-btn:hover { filter: brightness(1.1); }
                    
                    ::-webkit-scrollbar { width: 4px; }
                    ::-webkit-scrollbar-track { background: transparent; }
                    ::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.2); border-radius: 10px; }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="header-top">
                        <div class="ai-title">
                            ✨ AI Assistant
                            <span class="status-badge"><div class="status-dot"></div> Online</span>
                            <span id="tokenCount" style="margin-left:auto; font-size:10px; opacity:0.8;">Tokens: 0</span>
                        </div>
                        <div class="header-actions">
                            <button class="icon-btn" id="newChatBtn" title="New Chat">
                                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l2.146 2.147.707-.707L8.707 8l2.147-2.146-.707-.707L8 7.293 5.854 5.146l-.707.707L7.293 8l-2.146 2.146.707.707L8 8.707zM8 1a7 7 0 100 14A7 7 0 008 1zm0 13a6 6 0 110-12 6 6 0 010 12z"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="select-group">
                        <select id="sessionSelect">
                            <option value="">-- New Chat --</option>
                        </select>
                        <select id="modelSelect" style="max-width: 100px;">
                            <option value="gemini-2.5-flash" selected>Gemini Flash</option>
                            <option value="gemini-2.5-pro">Gemini Pro</option>
                            <option value="claude-3-7-sonnet@20250219">Claude 3.7</option>
                            <option value="azure-gpt-4o">GPT-4o</option>
                        </select>
                        <select id="flowSelect" style="max-width: 65px;">
                            <option value="agent" selected>Agent</option>
                            <option value="chat">Chat</option>
                        </select>
                    </div>
                </div>
                <div id="messages" class="messages"></div>
                <div class="input-container" id="inputContainer">
                    <div id="contextArea" class="context-area"></div>
                    <div class="input-row">
                        <button class="attach-btn" id="attachBtn" title="Attach context (Files/Folders)">📎</button>
                        <textarea id="chatInput" placeholder="Ask Codeaira... (Drop files here)" rows="1"></textarea>
                        <button class="send-btn" id="sendBtn">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="white"><path d="M1 8l14-7-3 14-3-6-8-1z"/></svg>
                        </button>
                        <button class="stop-btn" id="stopBtn" title="Stop generating/executing">
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><rect x="2" y="2" width="12" height="12" rx="2" ry="2" /></svg>
                        </button>
                    </div>
                </div>
                <script>
                    (function() {
                        const vscode = acquireVsCodeApi();
                        const messagesDiv = document.getElementById('messages');
                        const input = document.getElementById('chatInput');
                        const sendBtn = document.getElementById('sendBtn');
                        const stopBtn = document.getElementById('stopBtn');
                        const modelSelect = document.getElementById('modelSelect');
                        const flowSelect = document.getElementById('flowSelect');
                        const sessionSelect = document.getElementById('sessionSelect');
                        const newChatBtn = document.getElementById('newChatBtn');
                        const inputContainer = document.getElementById('inputContainer');
                        const contextArea = document.getElementById('contextArea');
                        const attachBtn = document.getElementById('attachBtn');
                        let currentAssistantMessage = null;
                        let attachedContext = [];

                        function renderContextArea() {
                            contextArea.innerHTML = '';
                            attachedContext.forEach((ctx, index) => {
                                const pill = document.createElement('div');
                                pill.className = 'context-pill';
                                pill.innerHTML = \`<span>\${ctx.name}</span><button class="context-pill-remove" data-index="\${index}">✕</button>\`;
                                contextArea.appendChild(pill);
                            });
                            
                            document.querySelectorAll('.context-pill-remove').forEach(btn => {
                                btn.addEventListener('click', (e) => {
                                    const idx = parseInt(e.target.dataset.index);
                                    attachedContext.splice(idx, 1);
                                    renderContextArea();
                                });
                            });
                        }

                        function safeParse(content) {
                            try {
                                return marked.parse(content);
                            } catch (e) {
                                console.error('Marked parse error:', e);
                                return content;
                            }
                        }

                        function sendMessage() {
                            const text = input.value.trim();
                            if (text || attachedContext.length > 0) {
                                vscode.postMessage({ 
                                    type: 'sendMessage', 
                                    value: text,
                                    model: modelSelect.value,
                                    flow: flowSelect.value,
                                    attachedContext: attachedContext
                                });
                                input.value = '';
                                input.style.height = 'auto';
                                attachedContext = [];
                                renderContextArea();
                            }
                        }

                        if (sendBtn) sendBtn.addEventListener('click', sendMessage);
                        if (stopBtn) {
                            stopBtn.addEventListener('click', () => {
                                vscode.postMessage({ type: 'stopGeneration' });
                            });
                        }
                        if (attachBtn) attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'selectContextFiles' }));

                        if (input) {
                            input.addEventListener('keydown', (e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    sendMessage();
                                }
                            });
                            input.addEventListener('input', () => {
                                input.style.height = 'auto';
                                input.style.height = input.scrollHeight + 'px';
                            });
                        }

                        // Drag & Drop
                        const preventDefaults = e => { e.preventDefault(); e.stopPropagation(); };
                        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                            window.addEventListener(eventName, preventDefaults, false);
                        });

                        window.addEventListener('dragover', () => { inputContainer.classList.add('drag-over'); });
                        window.addEventListener('dragleave', (e) => { 
                            if (!inputContainer.contains(e.relatedTarget)) {
                                inputContainer.classList.remove('drag-over'); 
                            }
                        });
                        
                        window.addEventListener('drop', (e) => {
                            inputContainer.classList.remove('drag-over');
                            let files = [];
                            
                            // 1. Try text/uri-list (Common for VS Code Explorer)
                            const uriList = e.dataTransfer.getData('text/uri-list');
                            if (uriList) {
                                const uris = uriList.split(/\r?\n/).filter(Boolean);
                                uris.forEach(uri => {
                                    let path = uri.trim();
                                    // Remove file:// prefix (handles file://, file:///, etc.)
                                    path = decodeURIComponent(path.replace(/^file:\/+/i, ''));
                                    // Windows: /C:/path -> C:/path
                                    path = path.replace(/^\/([a-zA-Z]:)/, '$1');
                                    // Normalize slashes
                                    const name = path.split(/[\\\/]/).pop();
                                    if (path) files.push({ name, path });
                                });
                            } 
                            
                            // 2. Fallback to text/plain (Sometimes contains paths)
                            if (files.length === 0) {
                                const plainText = e.dataTransfer.getData('text/plain');
                                if (plainText && (plainText.includes(':\\') || plainText.includes(':/') || plainText.startsWith('/'))) {
                                    const path = plainText.trim();
                                    const name = path.split(/[\\\/]/).pop();
                                    files.push({ name, path });
                                }
                            }

                            // 3. Fallback to OS files
                            if (files.length === 0 && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                                Array.from(e.dataTransfer.files).forEach(file => {
                                    if (file.path) {
                                        files.push({ name: file.name, path: file.path });
                                    }
                                });
                            }
                            
                            if (files.length > 0) {
                                vscode.postMessage({ type: 'addContextItems', items: files });
                            }
                        });

                        if (newChatBtn) {
                            newChatBtn.addEventListener('click', () => {
                                messagesDiv.innerHTML = '';
                                sessionSelect.value = '';
                                vscode.postMessage({ type: 'newChat' });
                            });
                        }

                        if (sessionSelect) {
                            sessionSelect.addEventListener('change', (e) => {
                                if (e.target.value === '') {
                                    messagesDiv.innerHTML = '';
                                    vscode.postMessage({ type: 'newChat' });
                                } else {
                                    vscode.postMessage({ type: 'switchSession', sessionId: e.target.value });
                                }
                            });
                        }

                        function addCopyButton(pre) {
                            if (pre.querySelector('.copy-btn')) return;
                            const btn = document.createElement('button');
                            btn.className = 'copy-btn';
                            btn.textContent = 'Copy';
                            btn.onclick = () => {
                                const code = pre.querySelector('code').innerText;
                                navigator.clipboard.writeText(code);
                                btn.textContent = 'Copied!';
                                setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
                            };
                            pre.appendChild(btn);
                        }

                        function createAssistantMessageUI() {
                            const container = document.createElement('div');
                            container.className = 'message-container assistant';
                            container.innerHTML = '<div class="avatar assistant">✨</div>' +
                                                  '<div style="flex-grow: 1; display: flex; flex-direction: column;">' +
                                                      '<div class="message"></div>' +
                                                      '<div class="message-footer">' +
                                                          '<span class="feedback-btn" title="Helpful">👍</span>' +
                                                          '<span class="feedback-btn" title="Not helpful">👎</span>' +
                                                      '</div>' +
                                                  '</div>';
                            messagesDiv.appendChild(container);
                            return container;
                        }

                        marked.setOptions({
                            highlight: function(code) {
                                return hljs.highlightAuto(code).value;
                            }
                        });

                        function addMessageUI(role, content) {
                            if (role === 'assistant') {
                                const container = createAssistantMessageUI();
                                const body = container.querySelector('.message');
                                body.innerHTML = safeParse(content);
                                body.querySelectorAll('pre code').forEach(el => {
                                    hljs.highlightElement(el);
                                    addCopyButton(el.parentElement);
                                });
                            } else if (role === 'system') {
                                const container = document.createElement('div');
                                container.className = 'message-container system';
                                container.innerHTML = '<div class="message">' + safeParse(content) + '</div>';
                                messagesDiv.appendChild(container);
                            } else {
                                const container = document.createElement('div');
                                container.className = 'message-container user';
                                container.innerHTML = '<div class="avatar user">👤</div>' +
                                                      '<div class="message">' + safeParse(content) + '</div>';
                                messagesDiv.appendChild(container);
                            }
                            messagesDiv.scrollTop = messagesDiv.scrollHeight;
                        }

                        function renderPlan(plan) {
                            const card = document.createElement('div');
                            card.className = 'plan-card';
                            let html = '<div class="plan-header">⚡ EXECUTION PLAN</div>' +
                                       '<div style="font-size:11px; margin-bottom:10px;">' + plan.description + '</div>' +
                                        '<div class="plan-bulk-actions">' +
                                            '<button class="bulk-btn primary" onclick="runAll(\'' + plan.planId + '\')">Run All</button>' +
                                            '<button class="bulk-btn" onclick="trustAll(\'' + plan.planId + '\')">Trust All</button>' +
                                            '<button class="bulk-btn danger" onclick="cancelAll(\'' + plan.planId + '\')">Cancel All</button>' +
                                            '<button id="rollback-' + plan.planId + '" class="bulk-btn" style="display:none; border-color: var(--vscode-charts-orange);" onclick="rollback(\'' + plan.planId + '\')">↺ Rollback</button>' +
                                        '</div>' +
                                       '<div class="plan-actions">';
                            
                            plan.actions.forEach(action => {
                                const typeClass = 'type-' + action.type.replace('File', '').toLowerCase();
                                const isCommand = action.type === 'command';
                                const statusLabel = action.status ? action.status.toUpperCase() : 'PENDING';
                                const statusClass = 'status-' + (action.status || 'pending');

                                 html += '<div class="plan-action-item" id="item-' + plan.planId + '-' + action.id + '">' +
                                            '<div class="action-header">' +
                                                '<span class="action-type ' + typeClass + '">' + action.type + '</span>' +
                                                '<span class="status-badge ' + statusClass + '" id="status-' + plan.planId + '-' + action.id + '">' + statusLabel + '</span>' +
                                            '</div>' +
                                            '<div class="action-path" onclick="previewAction(\\'' + plan.planId + '\\', \\'' + action.id + '\\')">' + action.path + '</div>' +
                                            (action.description ? '<div class="action-desc">' + action.description + '</div>' : '') +
                                            '<pre class="action-output" id="output-' + plan.planId + '-' + action.id + '"></pre>' +
                                            '<div class="action-btns" id="btns-' + plan.planId + '-' + action.id + '">' +
                                                '<button id="run-' + plan.planId + '-' + action.id + '" class="mini-btn run" onclick="runAction(\\'' + plan.planId + '\\', \\'' + action.id + '\\')">Run</button>' +
                                                (action.type === 'modifyFile' ? '<button class="mini-btn" onclick="toggleDiff(\\'' + plan.planId + '\\', \\'' + action.id + '\\')">Diff</button>' : '') +
                                                '<button id="cancel-' + plan.planId + '-' + action.id + '" class="mini-btn" onclick="cancelAction(\\'' + plan.planId + '\\', \\'' + action.id + '\\')">Cancel</button>' +
                                                '<button id="trust-' + plan.planId + '-' + action.id + '" class="mini-btn trust" onclick="trustAction(\\'' + plan.planId + '\\', \\'' + action.id + '\\')">Trust</button>' +
                                            '</div>' +
                                            '<div class="diff-view" id="diff-' + plan.planId + '-' + action.id + '"></div>' +
                                        '</div>';
                            });
                            html += '</div>';
                            card.innerHTML = html;
                            messagesDiv.appendChild(card);
                            messagesDiv.scrollTop = messagesDiv.scrollHeight;
                        }

                        window.runAction = (planId, actionId) => vscode.postMessage({ type: 'executeAction', planId, actionId });
                        window.cancelAction = (planId, actionId) => vscode.postMessage({ type: 'cancelAction', planId, actionId });
                        window.trustAction = (planId, actionId) => vscode.postMessage({ type: 'trustAction', planId, actionId });
                        window.runAll = (planId) => vscode.postMessage({ type: 'runAllActions', planId });
                        window.cancelAll = (planId) => vscode.postMessage({ type: 'cancelAllActions', planId });
                        window.trustAll = (planId) => vscode.postMessage({ type: 'trustAllActions', planId });
                        window.previewAction = (planId, actionId) => vscode.postMessage({ type: 'previewAction', planId, actionId });
                        
                        let planSnapshots = {};
                        window.rollback = (planId) => {
                            if (planSnapshots[planId]) {
                                vscode.postMessage({ type: 'rollback', planId, snapshotName: planSnapshots[planId] });
                            }
                        };
                        window.toggleDiff = (planId, actionId) => {
                            const dv = document.getElementById('diff-' + planId + '-' + actionId);
                            if (dv.style.display === 'block') {
                                dv.style.display = 'none';
                            } else {
                                dv.style.display = 'block';
                                if (!dv.textContent) {
                                    dv.textContent = 'Loading diff...';
                                    vscode.postMessage({ type: 'getDiff', planId, actionId });
                                }
                            }
                        };

                        window.addEventListener('message', event => {
                            const message = event.data;
                            switch (message.type) {
                                case 'addMessage': addMessageUI(message.role, message.content); break;
                                case 'updateUsage': 
                                    const tc = document.getElementById('tokenCount');
                                    if (tc) tc.textContent = 'Tokens: ' + message.tokens.toLocaleString();
                                    break;
                                case 'startAssistantMessage': currentAssistantMessage = createAssistantMessageUI(); break;
                                case 'updateAssistantMessage':
                                    if (currentAssistantMessage) {
                                        const body = currentAssistantMessage.querySelector('.message');
                                        body.innerHTML = safeParse(message.content);
                                        body.querySelectorAll('pre code').forEach(el => {
                                            hljs.highlightElement(el);
                                            addCopyButton(el.parentElement);
                                        });
                                        messagesDiv.scrollTop = messagesDiv.scrollHeight;
                                    }
                                    break;
                                case 'planGenerated': renderPlan(message); break;
                                case 'actionStatus':
                                    const statusEl = document.getElementById('status-' + message.planId + '-' + message.actionId);
                                    if (statusEl) {
                                        statusEl.className = 'status-badge status-' + message.status;
                                        statusEl.textContent = message.status.toUpperCase();
                                        if (message.error) statusEl.title = message.error;
                                    }
                                    const outEl = document.getElementById('output-' + message.planId + '-' + message.actionId);
                                    if (outEl && message.status === 'running') {
                                        outEl.style.display = 'block';
                                    }
                                    const btnContainer = document.getElementById('btns-' + message.planId + '-' + message.actionId);
                                    if (btnContainer && (message.status === 'success' || message.status === 'cancelled' || message.status === 'failed')) {
                                        btnContainer.querySelectorAll('button').forEach(b => b.disabled = true);
                                    }
                                    break;
                                case 'actionOutput':
                                    const outputEl = document.getElementById('output-' + message.planId + '-' + message.actionId);
                                    if (outputEl) {
                                        outputEl.style.display = 'block';
                                        outputEl.textContent += message.output;
                                        outputEl.scrollTop = outputEl.scrollHeight;
                                    }
                                    break;
                                case 'updateSessions':
                                    sessionSelect.innerHTML = '<option value="">-- New Chat --</option>';
                                    message.sessions.forEach(s => {
                                        const opt = document.createElement('option');
                                        opt.value = s.id; opt.textContent = s.title;
                                        if (s.id === message.activeSessionId) opt.selected = true;
                                        sessionSelect.appendChild(opt);
                                    });
                                    break;
                                case 'loadSession':
                                    messagesDiv.innerHTML = '';
                                    message.messages.forEach(m => addMessageUI(m.role, m.content));
                                    break;
                                case 'setPrompt':
                                    input.value = message.value;
                                    input.style.height = 'auto';
                                    input.style.height = input.scrollHeight + 'px';
                                    sendMessage();
                                    break;
                                case 'updateContextArea':
                                    if (message.items) {
                                        message.items.forEach(newItem => {
                                            if (!attachedContext.find(i => i.path === newItem.path)) {
                                                attachedContext.push(newItem);
                                            }
                                        });
                                        renderContextArea();
                                    }
                                    break;
                                case 'generationState':
                                    if (message.active) {
                                        sendBtn.style.display = 'none';
                                        stopBtn.style.display = 'flex';
                                    } else {
                                        sendBtn.style.display = 'flex';
                                        stopBtn.style.display = 'none';
                                    }
                                    break;
                                case 'planApplied':
                                    const applyBtn = document.getElementById('apply-' + message.planId);
                                    if (applyBtn) {
                                        applyBtn.disabled = false;
                                        applyBtn.textContent = message.success ? '✅ Applied' : '❌ Failed';
                                    }
                                    break;
                                case 'snapshotCreated':
                                    planSnapshots[message.planId] = message.snapshotName;
                                    const rollbackBtn = document.getElementById('rollback-' + message.planId);
                                    if (rollbackBtn) {
                                        rollbackBtn.style.display = 'inline-block';
                                    }
                                    break;
                                case 'actionDiff':
                                    const dv = document.getElementById('diff-' + message.planId + '-' + message.actionId);
                                    if (dv) {
                                        dv.innerHTML = message.diff.split('\n').map(line => {
                                            if (line.startsWith('+')) return \`<div class="diff-add">\${line}</div>\`;
                                            if (line.startsWith('-')) return \`<div class="diff-remove">\${line}</div>\`;
                                            return \`<div>\${line}</div>\`;
                                        }).join('');
                                    }
                                    break;
                            }
                        });

                        vscode.postMessage({ type: 'webviewLoaded' });
                    })();
                </script>
            </body>
            </html>`;
    }
}

