import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';

export class GitUtils {
    private _cwd: string;

    constructor(workspacePath: string) {
        this._cwd = workspacePath;
    }

    private exec(command: string): Promise<{ stdout: string, stderr: string }> {
        return new Promise((resolve, reject) => {
            cp.exec(command, { cwd: this._cwd }, (error, stdout, stderr) => {
                if (error) {
                    reject({ error, stdout, stderr });
                } else {
                    resolve({ stdout, stderr });
                }
            });
        });
    }

    async isGitRepo(): Promise<boolean> {
        try {
            await this.exec('git rev-parse --is-inside-work-tree');
            return true;
        } catch {
            return false;
        }
    }

    async createSnapshot(label: string): Promise<string | null> {
        if (!(await this.isGitRepo())) return null;
        try {
            // Use stash to create a snapshot of uncommitted changes
            const stashName = `codeaira-snapshot-${label}-${Date.now()}`;
            await this.exec(`git stash push -u -m "${stashName}"`);
            
            // Re-apply it immediately so the workspace remains in the same state, 
            // but we now have a named stash record we can restore from.
            await this.exec('git stash apply stash@{0}');
            return stashName;
        } catch (e) {
            console.error('Failed to create git snapshot:', e);
            return null;
        }
    }

    async rollback(stashName: string): Promise<boolean> {
        try {
            // Find the stash index by name
            const { stdout } = await this.exec('git stash list');
            const lines = stdout.split('\n');
            const stashIndex = lines.findIndex(l => l.includes(stashName));
            
            if (stashIndex !== -1) {
                // Hard reset to clear current changes
                await this.exec('git reset --hard HEAD');
                // Pop the specific stash
                await this.exec(`git stash pop stash@{${stashIndex}}`);
                return true;
            }
            return false;
        } catch (e) {
            console.error('Rollback failed:', e);
            return false;
        }
    }

    async commit(message: string): Promise<void> {
        await this.exec('git add .');
        await this.exec(`git commit -m "${message}"`);
    }

    async createBranch(name: string): Promise<void> {
        await this.exec(`git checkout -b ${name}`);
    }
}
