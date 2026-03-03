import * as fs from 'fs';
import * as path from 'path';
import { getCompletion } from '../apiClient';
import { CodeairaResponseParser } from '../responseParser';
import { RateLimiter } from '../rateLimiter';
import { WorkflowPlanner } from '../workflowPlanner';

// Mock vscode
jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn((key: string) => {
                if (key === 'modelName') return 'gemini-2.5-flash';
                if (key === 'baseUrl') return 'https://codeaira.qdatalabs.com/api';
                return undefined;
            })
        }),
        asRelativePath: jest.fn(p => p)
    },
    window: {
        createStatusBarItem: jest.fn(() => ({
            show: jest.fn(),
            text: '',
            dispose: jest.fn()
        })),
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn()
    },
    StatusBarAlignment: { Right: 1 },
    ThemeColor: jest.fn(),
    SymbolKind: { Class: 1, Function: 2, Interface: 3 },
    Location: jest.fn(),
    Range: jest.fn(),
    Position: jest.fn(),
    Uri: {
        file: jest.fn(p => ({ fsPath: p, path: p })),
        parse: jest.fn(p => ({ fsPath: p, path: p }))
    }
}), { virtual: true });

describe('Codeaira Copilot Automation Tests', () => {
    let token: string;
    const tokenPath = path.join(__dirname, '../../token.txt');

    beforeAll(() => {
        if (!fs.existsSync(tokenPath)) {
            throw new Error('token.txt not found. Please create it in the project root with your API token.');
        }
        token = fs.readFileSync(tokenPath, 'utf8').trim();
        if (token === 'YOUR_TOKEN_HERE') {
            throw new Error('Please put a valid token in token.txt');
        }
    });

    test('1. API Connectivity & Response Parsing', async () => {
        const prompt = 'Hello, this is a test query. Please respond with "Test Success".';
        const response = await getCompletion(prompt, token);
        
        expect(response).toBeDefined();
        expect(typeof response).toBe('string');
        console.log('✓ API Connectivity verified. Response prefix:', response.substring(0, 50));
    }, 30000);

    test('2. Response Parser Validation', () => {
        const parser = new CodeairaResponseParser();
        const validData = { success: true, data: 'Sample completion', score: 0.9 };
        const parsed = parser.parseCompletion(validData);
        
        expect(parsed.text).toBe('Sample completion');
        expect(parsed.score).toBe(0.9);
        
        expect(() => parser.parseCompletion({ success: true, missing: 'data' })).toThrow();
        console.log('✓ Response Parser validated.');
    });

    test('3. Rate Limiter Windowing', async () => {
        const limiter = new RateLimiter(5, 2000); // 5 requests per 2 seconds
        
        for (let i = 0; i < 5; i++) {
            const result = await limiter.checkAndRecord();
            expect(result).toBe(true);
        }
        
        const failedResult = await limiter.checkAndRecord();
        expect(failedResult).toBe(false);
        console.log('✓ Rate Limiter windowing verified.');
    });

    test('4. Workflow Planner - Plan Extraction', () => {
        const planner = new WorkflowPlanner();
        const aiResponse = `I will help you.
Here is the plan:
\`\`\`json
{
  "description": "Create a new utility",
  "actions": [
    {
      "type": "createFile",
      "path": "test.ts",
      "content": "export const a = 1;",
      "description": "Create test file"
    }
  ]
}
\`\`\`
Done.`;

        const plan = planner.parsePlan(aiResponse);
        expect(plan.actions.length).toBe(1);
        expect(plan.actions[0].type).toBe('createFile');
        expect(plan.actions[0].path).toBe('test.ts');
        console.log('✓ Workflow Planner extraction verified.');
    });
});
