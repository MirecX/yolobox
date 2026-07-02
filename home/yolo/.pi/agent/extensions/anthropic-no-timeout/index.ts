/**
 * Custom "anthropic-no-timeout" api (transport) with disabled body timeout.
 *
 * Registers an api handler (not an endpoint) that speaks the Anthropic Messages
 * protocol (POST /v1/messages) with undici body/headers timeouts disabled, to
 * prevent UND_ERR_BODY_TIMEOUT on slow endpoints (e.g. a big model on slow home
 * hardware). Select it per-provider in models.json with `"api": "anthropic-no-timeout"`.
 * The target server must be Anthropic Messages-compatible — OpenAI-compatible
 * servers should use the built-in `openai-completions` api instead.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import { Agent } from "undici";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type Tool,
	type ToolCall,
	type TextContent,
	type ThinkingContent,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Custom fetch with disabled body timeout
const dispatcher = new Agent({ bodyTimeout: 0, headersTimeout: 0 });
const fetchWithNoBodyTimeout = (input: RequestInfo | URL, init?: RequestInit) => {
	return fetch(input, { ...init, dispatcher } as any);
};

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

function streamAnthropicNoTimeout(
	model: Model,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const client = new Anthropic({
				baseURL: model.baseUrl,
				apiKey: options?.apiKey || (model as any).apiKey || "not-needed",
				dangerouslyAllowBrowser: true,
				fetch: fetchWithNoBodyTimeout,
			});

			const params: MessageCreateParamsStreaming = {
				model: model.id,
				messages: context.messages.map((msg) => {
					if (msg.role === "user") {
						return {
							role: "user",
							content: typeof msg.content === "string"
								? msg.content
								: msg.content.map((c) => c.type === "text" ? { type: "text", text: c.text } : c),
						};
					}
					if (msg.role === "assistant") {
						return {
							role: "assistant",
							content: msg.content.map((c) => {
								if (c.type === "text") return { type: "text", text: c.text };
								if (c.type === "toolCall") return { type: "tool_use", id: c.id, name: c.name, input: c.arguments };
								return c;
							}),
						};
					}
					if (msg.role === "toolResult") {
						return {
							role: "user",
							content: [{
								type: "tool_result",
								tool_use_id: msg.toolCallId,
								content: msg.content.map((c) => c.type === "text" ? { type: "text", text: c.text } : c),
								is_error: msg.isError,
							}],
						};
					}
					return msg as any;
				}),
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};

			if (context.systemPrompt) {
				(params as any).system = context.systemPrompt;
			}

			// Add tools if available
			if (context.tools && context.tools.length > 0) {
				params.tools = context.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					input_schema: {
						type: "object",
						properties: (tool.parameters as any).properties || {},
						required: (tool.parameters as any).required || [],
					},
				}));
			}

			// Use the raw streaming iterator (create) rather than the high-level .stream()
			// helper: this transport targets local/proxy endpoints (e.g. litellm) whose SSE
			// can violate the strict Anthropic event ordering the MessageStream accumulator
			// enforces (litellm emits a duplicate message_start, which .stream() rejects with
			// "Unexpected event order"). Our own event loop below reconstructs the message
			// and tolerates the duplicate, so the raw iterator is the right fit here.
			const anthropicStream = await client.messages.create(params, { signal: options?.signal });

			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson?: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.message.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: "", index: event.index } as any);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: event.content_block.name,
							arguments: {},
							partialJson: "",
							index: event.index,
						} as any);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
						(block as any).partialJson = ((block as any).partialJson || "") + event.delta.partial_json;
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					delete (block as any).index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "toolCall") {
						try {
							block.arguments = JSON.parse((block as any).partialJson || "{}");
						} catch {}
						delete (block as any).partialJson;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if ((event.delta as any).stop_reason) {
						output.stopReason = mapStopReason((event.delta as any).stop_reason);
					}
					output.usage.input = (event.usage as any).input_tokens || 0;
					output.usage.output = (event.usage as any).output_tokens || 0;
					output.usage.cacheRead = (event.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

export default function (pi: ExtensionAPI) {
	// Register a custom *api* (transport), not a concrete endpoint. pi keys the
	// streamSimple handler by the `api` string (see registerApiProvider), so any
	// provider in models.json can opt in per-endpoint via `"api": "anthropic-no-timeout"`
	// while keeping its own baseUrl/apiKey. Example models.json:
	//   "work": { "baseUrl": "http://fast:8001", "api": "openai-completions", "models": [...] }
	//   "home": { "baseUrl": "http://slow:8001", "api": "anthropic-no-timeout", "models": [...] }
	// baseUrl, apiKey and model id are read from the selecting provider's model at stream time
	// (see streamAnthropicNoTimeout); no baseUrl/models are set here on purpose.
	pi.registerProvider("anthropic-no-timeout", {
		api: "anthropic-no-timeout",
		streamSimple: streamAnthropicNoTimeout,
	});
}
