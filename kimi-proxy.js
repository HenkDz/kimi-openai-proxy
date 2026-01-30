/**
 * Kimi K2.5 Proxy Server
 * Fixes VS Code Copilot Chat parameters to match Kimi K2.5 requirements
 *
 * Kimi K2.5 fixed values:
 * - temperature: 1.0
 * - top_p: 0.95
 * - n: 1
 * - presence_penalty: 0.0
 * - frequency_penalty: 0.0
 */

const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3001;
const TARGET_HOST = 'api.moonshot.ai';
let toolIdCounter = 0;

const INVALID_TOOL_ID_CHARS = /[^a-zA-Z0-9_-]/g;

const normalizeToolId = (id) => {
    if (typeof id !== 'string') {
        return null;
    }

    const cleaned = id.replace(INVALID_TOOL_ID_CHARS, '_').replace(/^_+|_+$/g, '');
    if (cleaned) {
        return cleaned;
    }

    toolIdCounter += 1;
    return `tooluse_${toolIdCounter}`;
};

const sanitizeThinkingAndReasoning = (node) => {
    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(sanitizeThinkingAndReasoning);
        return;
    }

    // Some OpenAI-compatible clients include non-standard reasoning fields.
    // Moonshot may *require* reasoning_content on assistant tool-call messages,
    // so we do not delete it here.
    if ('reasoning_content' in node && typeof node.reasoning_content !== 'string') {
        try {
            node.reasoning_content = JSON.stringify(node.reasoning_content);
        } catch {
            node.reasoning_content = String(node.reasoning_content);
        }
    }

    if ('reasoning' in node && typeof node.reasoning === 'string') {
        delete node.reasoning;
    }

    Object.values(node).forEach(sanitizeThinkingAndReasoning);
};

const ensureReasoningContentForToolCalls = (messages, needsReasoningOnAllAssistant = false) => {
    if (!Array.isArray(messages)) {
        return;
    }

    // Always log for now to debug the issue
    const debug = true;

    const summarizeContentTypes = (content) => {
        if (!Array.isArray(content)) {
            return null;
        }
        return content
            .map((b) => (b && typeof b === 'object' ? b.type : typeof b))
            .filter(Boolean)
            .slice(0, 10);
    };

    console.log(`[${new Date().toISOString()}] Processing ${messages.length} messages, needsReasoningOnAllAssistant=${needsReasoningOnAllAssistant}`);

    messages.forEach((msg, idx) => {
        if (!msg || typeof msg !== 'object') {
            return;
        }

        const isAssistantMessage = msg.role === 'assistant';

        // OpenAI-style: assistant message contains tool_calls[]
        const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

        // Legacy OpenAI-style: assistant message contains function_call
        const hasFunctionCall = !!(msg.function_call && typeof msg.function_call === 'object');

        // Anthropic / block-style: msg.content is an array of typed blocks
        const hasToolBlocks =
            Array.isArray(msg.content) &&
            msg.content.some((block) => {
                if (!block || typeof block !== 'object') {
                    return false;
                }
                return block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'function_call';
            });

        // Different clients use different role/type conventions; the Moonshot error text
        // refers to an "assistant tool call message" but we key off tool-call presence.
        const looksLikeToolCallMessage = hasToolCalls || hasFunctionCall || hasToolBlocks;

        if (debug) {
            console.log(
                `  msg[${idx}] role=${msg.role || 'undefined'} hasToolCalls=${hasToolCalls} hasFunctionCall=${hasFunctionCall} hasToolBlocks=${hasToolBlocks} has_reasoning_content=${'reasoning_content' in msg}`
            );
        }

        // Add reasoning_content when:
        // 1. Message has tool calls (Moonshot always requires it for these)
        // 2. OR it's an assistant message and we're using a thinking model (docs say ALL assistant msgs need it)
        const needsReasoningContent = looksLikeToolCallMessage || 
            (needsReasoningOnAllAssistant && isAssistantMessage);

        if (needsReasoningContent) {
            if (!('reasoning_content' in msg) || msg.reasoning_content === undefined || msg.reasoning_content === null) {
                // Use a single space - empty string might be rejected
                msg.reasoning_content = ' ';
                console.log(`    -> Added reasoning_content=' ' to msg[${idx}]`);
            } else if (typeof msg.reasoning_content !== 'string') {
                msg.reasoning_content = String(msg.reasoning_content ?? ' ');
                console.log(`    -> Converted reasoning_content to string for msg[${idx}]`);
            } else if (msg.reasoning_content === '' || msg.reasoning_content === '[undefined]') {
                // Replace empty or "[undefined]" with a space
                msg.reasoning_content = ' ';
                console.log(`    -> Replaced empty/undefined reasoning_content with ' ' for msg[${idx}]`);
            }
        }
    });
};

const sanitizeToolIds = (node) => {
    if (!node || typeof node !== 'object') {
        return;
    }

    if (Array.isArray(node)) {
        node.forEach(sanitizeToolIds);
        return;
    }

    if (node.tool_use && typeof node.tool_use === 'object' && node.tool_use.id) {
        const normalized = normalizeToolId(node.tool_use.id);
        if (normalized) {
            node.tool_use.id = normalized;
        }
    }

    if (node.type === 'tool_use' && node.id) {
        const normalized = normalizeToolId(node.id);
        if (normalized) {
            node.id = normalized;
        }
    }

    if (node.type === 'tool_result' && node.tool_use_id) {
        const normalized = normalizeToolId(node.tool_use_id);
        if (normalized) {
            node.tool_use_id = normalized;
        }
    }

    if (node.tool_call_id) {
        const normalized = normalizeToolId(node.tool_call_id);
        if (normalized) {
            node.tool_call_id = normalized;
        }
    }

    if (node.tool_use_id) {
        const normalized = normalizeToolId(node.tool_use_id);
        if (normalized) {
            node.tool_use_id = normalized;
        }
    }

    if (Array.isArray(node.tool_calls)) {
        node.tool_calls.forEach((call) => {
            if (call?.id) {
                const normalized = normalizeToolId(call.id);
                if (normalized) {
                    call.id = normalized;
                }
            }
        });
    }

    Object.values(node).forEach(sanitizeToolIds);
};

const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });
    req.on('end', () => {
        try {
            // Parse and fix the request body
            const data = JSON.parse(body);

            // Fix parameters for Moonshot/Kimi models
            // Some clients use model names that don't include "kimi" (e.g. "moonshot-v1-8k").
            if (typeof data.model === 'string' && /(kimi|moonshot)/i.test(data.model)) {
                // kimi-k2.5 has thinking/reasoning enabled by default
                // The API requires reasoning_content on assistant messages with tool_calls
                // If the client didn't preserve reasoning_content, we need to add a placeholder
                
                console.log(`[${new Date().toISOString()}] Processing request for model: ${data.model}`);
                
                // Remove thinking parameter - Moonshot API doesn't use this format
                delete data.thinking;

                // These are the ONLY values Kimi K2.5 accepts
                data.temperature = 1;
                data.top_p = 0.95;
                data.n = 1;
                data.presence_penalty = 0.0;
                data.frequency_penalty = 0.0;

                // For kimi-k2.5, the model has thinking enabled by default
                // We MUST include reasoning_content on assistant messages with tool_calls
                // If it's missing, add a space (empty string may be rejected)
                ensureReasoningContentForToolCalls(data.messages, true);

                // Sanitize any nested non-standard reasoning fields while preserving reasoning_content.
                if (Array.isArray(data.messages)) {
                    data.messages.forEach((msg) => {
                        if (msg && typeof msg === 'object' && msg.content && typeof msg.content === 'object') {
                            sanitizeThinkingAndReasoning(msg.content);
                        }
                    });
                }

                sanitizeThinkingAndReasoning(data);
                sanitizeToolIds(data);

                // Final verification: log assistant messages with tool_calls to confirm reasoning_content exists
                if (Array.isArray(data.messages)) {
                    data.messages.forEach((msg, idx) => {
                        if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                            console.log(`[VERIFY] msg[${idx}] assistant with tool_calls: reasoning_content=${JSON.stringify(msg.reasoning_content)}`);
                        }
                    });
                }

                console.log(`[${new Date().toISOString()}] Patched request params for ${data.model}`);
            }

            // Forward to Moonshot AI
            const options = {
                hostname: TARGET_HOST,
                port: 443,
                path: req.url,
                method: req.method,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': req.headers.authorization || '',
                }
            };

            const proxyReq = https.request(options, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
                console.error('Proxy error:', err);
                res.writeHead(500);
                res.end(JSON.stringify({ error: err.message }));
            });

            proxyReq.write(JSON.stringify(data));
            proxyReq.end();

        } catch (err) {
            console.error('Request error:', err);
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid request' }));
        }
    });
});

server.listen(PORT, () => {
    console.log(`Kimi K2.5 Proxy running on http://localhost:${PORT}`);
    console.log(`Forward requests to: https://${TARGET_HOST}`);
});
