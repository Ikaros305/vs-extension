import axios from 'axios';
import { getModelName, getBaseUrl } from './config';
import { CodeairaResponseParser } from './responseParser';

const responseParser = new CodeairaResponseParser();

export interface ApiResponse {
    response: string;
}

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;

async function retry<T>(fn: () => Promise<T>, retries = MAX_RETRIES, delay = INITIAL_DELAY_MS): Promise<T> {
    try {
        return await fn();
    } catch (error: any) {
        // Do not retry if the request was cancelled
        if (axios.isCancel(error) || error.name === 'AbortError' || error.message === 'Request cancelled') {
            throw error;
        }
        
        if (retries > 0) {
            console.log(`Retrying in ${delay}ms... (${retries} attempts left)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return retry(fn, retries - 1, delay * 2);
        }
        throw error;
    }
}

export async function getCompletion(
    prompt: string, 
    token: string, 
    context?: string, 
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
    modelNameOverride?: string,
    images?: string[]
): Promise<string> {
    const url = `${getBaseUrl()}/application`;

    const payload = {
        api_token: token,
        prompt: prompt,
        context: context,
        model_name: modelNameOverride || getModelName(),
        images: images
    };

    const config: any = {
        headers: {
            'Content-Type': 'application/json'
        },
        timeout: 60000, // Increase to 60s
        signal: signal
    };

    if (onChunk) {
        // Implementation for streaming if API supports it
        const result = await retry(async () => {
            const response = await axios.post(url, payload, config);
            return responseParser.parseCompletion(response.data).text;
        });
        onChunk(result);
        return result;
    }

    return await retry(async () => {
        try {
            const response = await axios.post(url, payload, config);
            return responseParser.parseCompletion(response.data).text;
        } catch (error: any) {
            if (axios.isCancel(error) || error.name === 'AbortError') {
                throw new Error('Request cancelled');
            }
            if (error.response) {
                if (error.response.status === 401) {
                    throw new Error('Authentication failed: Invalid API Token.');
                }
                throw new Error(`API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
            } else if (error.request) {
                throw new Error('Network error: No response received from Codeaira API.');
            } else {
                throw new Error(`Request error: ${error.message}`);
            }
        }
    });
}

/**
 * Validates the API token by sending a minimal ping request.
 * Resolves to true if valid, throws an error if invalid.
 */
export async function validateTokenAPI(token: string): Promise<boolean> {
    const url = `${getBaseUrl()}/application`;

    const payload = {
        api_token: token,
        prompt: "ping", // Minimal prompt
        model_name: getModelName()
    };

    const config = {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000 // Fast timeout for validation
    };

    try {
        await axios.post(url, payload, config);
        return true; // 200 OK means valid
    } catch (error: any) {
        if (error.response && error.response.status === 401) {
            throw new Error('Invalid API Token.');
        }
        // If it fails for another reason (network, 500 error), we still throw but with a different message
        throw new Error(`Connection failed: ${error.message}`);
    }
}


