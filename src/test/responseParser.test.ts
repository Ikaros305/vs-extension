import * as fc from 'fast-check';
import { CodeairaResponseParser } from '../responseParser';

describe('CodeairaResponseParser Property Tests', () => {
    const parser = new CodeairaResponseParser();

    test('Property 51: API Response Round-Trip', () => {
        fc.assert(
            fc.property(fc.string(), fc.float(), (response, score) => {
                const data = { response, score };
                const parsed = parser.parseCompletion(data);
                
                // Verify text match
                expect(parsed.text).toBe(response);
                // Verify score match
                expect(parsed.score).toBe(score);
            })
        );
    });

    test('Property 48: API Response Validation Invariants', () => {
        fc.assert(
            fc.property(fc.string(), (response) => {
                const data = { response };
                // Parsing should succeed if 'response' is present
                expect(() => parser.parseCompletion(data)).not.toThrow();
            })
        );
    });

    test('Parsing invalid objects should always throw', () => {
        fc.assert(
            fc.property(fc.dictionary(fc.string(), fc.anything()), (data) => {
                // If 'response' is missing, it should throw
                if (!('response' in data)) {
                    expect(() => parser.parseCompletion(data)).toThrow();
                }
            })
        );
    });
});
