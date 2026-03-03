import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import { Action, Plan } from './workflowPlanner';
import { GitUtils } from './gitUtils';

export interface ActionResult {
    success: boolean;
    output: string;
    error?: string;
}

export class ActionExecutor {
    private _activeProcesses = new Map<string, cp.ChildProcess>();

    constructor() {}

    /**
     * Executes a plan after seeking user confirmation.
     */
    async executePlan(plan: Plan): Promise<void> {
        console.log(`[Codeaira] Executing plan: ${plan.description} with ${plan.actions.length} actions.`);
        if (plan.actions.length === 0) {
            console.log('[Codeaira] Plan has no actions. Aborting.');
            return;
        }

        let lastActionedFilePath: string | null = null;

        for (const action of plan.actions) {
            try {
                console.log(`[Codeaira] Executing action ${action.type} on ${action.path}...`);
                const result = await this.executeAction(action);
                
                if (result.success) {
                    console.log(`[Codeaira] Action ${action.type} completed: ${result.output}`);
                    if (action.type === 'createFile' || action.type === 'modifyFile') {
                        lastActionedFilePath = this.resolvePath(action.path);
                    }
                } else {
                    throw new Error(result.error || result.output);
                }
            } catch (error: any) {
                console.error(`[Codeaira] Failed to execute action ${action.type} on ${action.path}:`, error);
                vscode.window.showErrorMessage(`Failed to execute action ${action.type} on ${action.path}: ${error.message}`);
                break;
            }
        }

        // Auto-open last file
        if (lastActionedFilePath) {
            try {
                const uri = vscode.Uri.file(lastActionedFilePath);
                const document = await vscode.workspace.openTextDocument(uri);
                await vscode.window.showTextDocument(document, { preview: false });
            } catch (openError: any) {
                console.error(`[Codeaira] Failed to auto-open file ${lastActionedFilePath}:`, openError);
            }
        }
    }

    public async executeAction(action: Action, onOutput?: (data: string) => void): Promise<ActionResult> {
        const fullPath = action.path ? this.resolvePath(action.path) : undefined;
        const uri = fullPath ? vscode.Uri.file(fullPath) : undefined;

        console.log(`[Codeaira] Executing action: ${action.type} ${action.path || ''}`);

        try {
            switch (action.type) {
                case 'createFile':
                    if (!fullPath || !uri) throw new Error('Path is required for createFile');
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(action.content || ''));
                    await this._runLinter(fullPath, onOutput);
                    return { success: true, output: `Created file and linted: ${action.path}` };

                case 'modifyFile':
                    if (!fullPath || !uri) throw new Error('Path is required for modifyFile');
                    const document = await vscode.workspace.openTextDocument(uri);
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(uri, new vscode.Range(0, 0, document.lineCount, 0), action.content || '');
                    const success = await vscode.workspace.applyEdit(edit);
                    if (!success) throw new Error('Failed to apply workspace edit');
                    await document.save(); // Ensure changes are persisted
                    await this._runLinter(fullPath, onOutput);
                    return { success: true, output: `Modified file and linted: ${action.path}` };

                case 'deleteFile':
                    if (!uri) throw new Error('Path is required for deleteFile');
                    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
                    return { success: true, output: `Deleted file: ${action.path}` };

                case 'command':
                    const command = action.path;
                    const args = action.arguments || [];
                    const fullCommand = [command, ...args].join(' ');
                    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

                    console.log(`[Codeaira] Running terminal command: ${fullCommand} in ${cwd}`);

                    return new Promise((resolve) => {
                        let fullOutput = '';
                        const child = cp.exec(fullCommand, { 
                            cwd, 
                            env: { ...process.env, FORCE_COLOR: '1' } 
                        });

                        if (child.stdout) {
                            child.stdout.on('data', (data) => {
                                const str = data.toString();
                                fullOutput += str;
                                if (onOutput) onOutput(str);
                            });
                        }

                        if (child.stderr) {
                            child.stderr.on('data', (data) => {
                                const str = data.toString();
                                fullOutput += str;
                                if (onOutput) onOutput(str);
                            });
                        }

                        if (action.id) {
                            this._activeProcesses.set(action.id, child);
                        }

                        child.on('close', (code) => {
                            if (action.id) this._activeProcesses.delete(action.id);
                            if (code === 0) {
                                resolve({
                                    success: true,
                                    output: fullOutput || 'Command executed successfully (no output).'
                                });
                            } else {
                                resolve({
                                    success: false,
                                    output: fullOutput,
                                    error: `Command failed with exit code ${code}`
                                });
                            }
                        });

                        child.on('error', (err) => {
                            if (action.id) this._activeProcesses.delete(action.id);
                            resolve({
                                success: false,
                                output: fullOutput,
                                error: err.message
                            });
                        });
                    });

                case 'git':
                    const gitCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (!gitCwd) throw new Error('No workspace folder found for git action');
                    const git = new GitUtils(gitCwd);
                    const gitOp = action.path; // e.g., 'commit', 'branch'
                    const gitMsg = action.content || '';
                    const gitArgs = action.arguments || [];

                    switch (gitOp) {
                        case 'commit':
                            await git.commit(gitMsg || 'Agentic commit');
                            return { success: true, output: `Git commit successful: ${gitMsg}` };
                        case 'branch':
                            const branchName = gitArgs[0] || gitMsg;
                            if (!branchName) throw new Error('Branch name is required for git branch action');
                            await git.createBranch(branchName);
                            return { success: true, output: `Git branch created and checked out: ${branchName}` };
                        default:
                            throw new Error(`Unsupported git operation: ${gitOp}`);
                    }

                default:
                    throw new Error(`Unknown action type: ${action.type}`);
            }
        } catch (err: any) {
            return { success: false, output: '', error: err.message };
        }
    }

    public cancelActionProcess(actionId: string) {
        const child = this._activeProcesses.get(actionId);
        if (child) {
            console.log(`[Codeaira] Actively killing process for action ${actionId}`);
            try {
                // If on windows we might need taskkill, but kill() is a good start.
                if (process.platform === 'win32') {
                    cp.spawn('taskkill', ['/pid', child.pid!.toString(), '/f', '/t']);
                } else {
                    child.kill('SIGINT');
                }
            } catch (e) {
                console.error(`[Codeaira] Failed to kill process:`, e);
            }
        }
    }

    private async _runLinter(filePath: string, onOutput?: (data: string) => void): Promise<void> {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) return;

        // Try running eslint --fix on the specific file
        console.log(`[Codeaira] Attempting to lint: ${filePath}`);
        return new Promise((resolve) => {
            // Using npx eslint --fix to avoid needing global install or script mapping
            const command = `npx eslint --fix "${filePath}"`;
            cp.exec(command, { cwd }, (err, stdout, stderr) => {
                if (stdout && onOutput) onOutput(`\n[Lint Output]:\n${stdout}`);
                if (stderr && onOutput) onOutput(`\n[Lint Error]:\n${stderr}`);
                resolve();
            });
        });
    }

    private resolvePath(relativePath: string): string {
        if (path.isAbsolute(relativePath)) return relativePath;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) return path.join(workspaceFolder.uri.fsPath, relativePath);
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) return path.join(path.dirname(activeEditor.document.uri.fsPath), relativePath);
        throw new Error('Cannot resolve path: No workspace or active editor.');
    }
}
