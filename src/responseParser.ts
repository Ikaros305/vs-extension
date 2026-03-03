export interface Completion {
    text: string;
    score: number;
    metadata?: Record<string, any>;
}

export interface ChatResponse {
    message: string;
    streaming?: boolean;
}

export interface ResponseParser {
    parseCompletion(data: any): Completion;
    validate(data: any, expectedFields: string[]): void;
}

export class CodeairaResponseParser implements ResponseParser {
    /**
     * Parses and validates a completion response.
     */
    parseCompletion(data: any): Completion {
        this.validate(data, ['data']);
        
        // Map the API 'data' field to our 'text' field
        return {
            text: data.data,
            score: typeof data.score === 'number' ? data.score : 1.0,
            metadata: data.metadata
        };
    }

    /**
     * Basic schema validation.
     */
    validate(data: any, expectedFields: string[]): void {
        if (!data || typeof data !== 'object') {
            throw new Error('Invalid response: Expected a JSON object.');
        }

        for (const field of expectedFields) {
            if (!(field in data)) {
                throw new Error(`Invalid response: Missing required field "${field}".`);
            }
        }
    }

    /**
     * Cleans the response by removing markdown code blocks if present.
     */
    cleanResponse(text: string): string {
        const codeBlockMatch = text.match(/```(?:\w+)?\n([\s\S]*?)\n```/) || text.match(/```([\s\S]*?)```/);
        if (codeBlockMatch) {
            return codeBlockMatch[1].trim();
        }
        return text.trim();
    }

    /**
     * Formats an object for logging.
     */
    prettyPrint(data: any): string {
        return JSON.stringify(data, null, 2);
    }
}
