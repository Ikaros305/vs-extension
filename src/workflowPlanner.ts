import * as vscode from 'vscode';

export type ActionType = 'createFile' | 'modifyFile' | 'deleteFile' | 'command' | 'git';

export interface Action {
    id: string;
    type: ActionType;
    path: string;
    content?: string;
    arguments?: string[]; // For commands
    description: string;
    status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
}

export interface Plan {
    id: string;
    description: string;
    actions: Action[];
}

export class WorkflowPlanner {
    /**
     * Parses the AI response to extract a plan.
     * Expected format in the response: A JSON block or specific markers.
     */
    parsePlan(response: string): Plan {
        console.log(`[Codeaira] Attempting to parse plan from response (${response.length} chars)`);
        
        // Try multiple regex patterns for robustness
        const patterns = [
            /```(?:json|typescript)?\s*(\{\s*[\s\S]*?"actions"[\s\S]*?\})\s*```/, // Must contain "actions"
            /(\{[\s\S]*?"actions"[\s\S]*?\})/                                    // Raw JSON-like structure with "actions"
        ];

        for (const pattern of patterns) {
            const match = response.match(pattern);
            if (match) {
                try {
                    const jsonStr = match[1].trim();
                    const data = JSON.parse(jsonStr);
                    if (data.actions && Array.isArray(data.actions)) {
                        console.log(`[Codeaira] Plan parsed successfully using pattern: ${pattern}`);
                        
                        const actions: Action[] = data.actions.map((act: any) => ({
                            id: Math.random().toString(36).substr(2, 9),
                            type: act.type,
                            path: act.path || '',
                            content: act.content,
                            arguments: act.arguments,
                            description: act.description || `Execute ${act.type}`,
                            status: 'pending'
                        }));

                        return {
                            id: Math.random().toString(36).substr(2, 9),
                            description: data.description || 'Generated Plan',
                            actions: actions
                        };
                    }
                } catch (e: any) {
                    console.log(`[Codeaira] Pattern match found but JSON.parse failed for pattern ${pattern}: ${e.message}`);
                }
            }
        }

        console.log('[Codeaira] No structured plan detected in response.');
        return {
            id: 'none',
            description: 'Simple Response',
            actions: []
        };
    }
}
