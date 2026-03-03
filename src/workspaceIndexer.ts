import * as vscode from 'vscode';

export interface SymbolInfo {
    name: string;
    kind: vscode.SymbolKind;
    location: vscode.Location;
    containerName?: string;
}

export class WorkspaceIndexer {
    private symbols: Map<string, SymbolInfo[]> = new Map();
    private isIndexing: boolean = false;
    private recentFiles: string[] = [];

    constructor() {}

    /**
     * Tracks the most recently visited files to provide better context.
     */
    public trackFileVisit(fsPath: string) {
        if (fsPath.includes('node_modules')) return;
        this.recentFiles = [fsPath, ...this.recentFiles.filter(f => f !== fsPath)].slice(0, 5);
    }

    /**
     * Returns the list of recently visited files.
     */
    public getRecentFiles(): string[] {
        return this.recentFiles;
    }

    /**
     * Starts the workspace indexing process.
     */
    async indexWorkspace(): Promise<void> {
        if (this.isIndexing) {
            return;
        }

        this.isIndexing = true;
        console.log('Starting workspace indexing...');

        try {
            const files = await vscode.workspace.findFiles('**/*.{ts,js,py,go}', '**/node_modules/**');
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: "Codeaira: Indexing Workspace...",
                cancellable: false
            }, async () => {
                for (const file of files) {
                    await this.indexFile(file);
                }
            });

            console.log(`Indexing complete. Indexed ${this.symbols.size} files.`);
        } catch (error) {
            console.error('Workspace indexing failed:', error);
        } finally {
            this.isIndexing = false;
        }
    }

    /**
     * Indexes a single file by extracting its symbols.
     */
    async indexFile(uri: vscode.Uri): Promise<void> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[] | vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );

            if (!symbols) {
                return;
            }

            const flattenedSymbols = this.flattenSymbols(symbols, uri);
            this.symbols.set(uri.fsPath, flattenedSymbols);
        } catch (error) {
            // Silently ignore files that don't have symbol providers
        }
    }

    /**
     * Flattens hierarchical DocumentSymbols into a flat array of SymbolInfo.
     */
    private flattenSymbols(symbols: (vscode.SymbolInformation | vscode.DocumentSymbol)[], uri: vscode.Uri): SymbolInfo[] {
        const result: SymbolInfo[] = [];

        const walk = (s: vscode.SymbolInformation | vscode.DocumentSymbol, containerName?: string) => {
            if ('children' in s) {
                // DocumentSymbol
                result.push({
                    name: s.name,
                    kind: s.kind,
                    location: new vscode.Location(uri, s.range),
                    containerName
                });
                for (const child of s.children) {
                    walk(child, s.name);
                }
            } else {
                // SymbolInformation
                result.push({
                    name: s.name,
                    kind: s.kind,
                    location: s.location,
                    containerName: s.containerName
                });
            }
        };

        for (const symbol of symbols) {
            walk(symbol);
        }

        return result;
    }

    /**
     * Searches for a symbol by name across the indexed workspace.
     */
    findSymbol(name: string): SymbolInfo[] {
        const matches: SymbolInfo[] = [];
        for (const [_, fileSymbols] of this.symbols) {
            for (const sym of fileSymbols) {
                if (sym.name.includes(name)) {
                    matches.push(sym);
                }
            }
        }
        return matches;
    }

    /**
     * Returns a summary of available symbols for context.
     */
    getWorkspaceSummary(): string {
        let summary = 'Workspace symbols summary:\n';
        for (const [path, fileSymbols] of this.symbols) {
            const fileName = vscode.workspace.asRelativePath(path);
            const highLevelSymbols = fileSymbols
                .filter(s => s.kind === vscode.SymbolKind.Class || s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Interface)
                .map(s => `${vscode.SymbolKind[s.kind]}: ${s.name}`)
                .join(', ');
            
            if (highLevelSymbols) {
                summary += `- ${fileName}: ${highLevelSymbols}\n`;
            }
        }
        return summary;
    }
    /**
     * Searches for relevant code snippets based on keywords in the prompt.
     */
    public async searchContext(query: string): Promise<string> {
        const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 3);
        let results = "Semantic Search Results:\n";
        let foundCount = 0;

        for (const [filePath, _] of this.symbols) {
            if (foundCount >= 3) break;
            
            const relPath = vscode.workspace.asRelativePath(filePath);
            const content = (await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString().toLowerCase();
            
            const matches = keywords.filter(k => content.includes(k));
            if (matches.length >= 2) {
                const fullContent = (await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))).toString();
                results += `\n--- file: ${relPath} ---\n${fullContent.substring(0, 1000)}${fullContent.length > 1000 ? '...' : ''}\n`;
                foundCount++;
            }
        }
        return foundCount > 0 ? results : "";
    }
}
