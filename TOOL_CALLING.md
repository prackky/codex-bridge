# Client tool calling

The bridge supports function tools through both `/v1/responses` and
`/v1/chat/completions`. It uses Codex app-server's native experimental
`dynamicTools` / `item/tool/call` protocol. Tools run in your IDE or other HTTP
client. The gateway does not read your work machine's files or execute the
function implementations itself. The gateway remains read-only; client edit and
test tools use the permissions and approval flow of the IDE workspace. Host
permission prose is replaced with instructions scoped to those two environments.

```text
IDE sends tools and prompt → Codex requests a function
← bridge returns function name, JSON arguments, and call ID
IDE executes the function locally
IDE sends result with the call ID → same Codex turn resumes
← final answer or another function call
```

## Responses API example

```bash
curl --noproxy '*' -sS http://127.0.0.1:8765/v1/responses \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "codex",
    "input": "Read README.md with read_file and summarize it.",
    "tools": [{
      "type": "function",
      "name": "read_file",
      "description": "Read a file from the IDE workspace on the client machine.",
      "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
        "additionalProperties": false
      }
    }]
  }'
```

The `output` array contains a function item similar to this (possibly alongside
assistant text):

```json
{
  "type": "function_call",
  "call_id": "call_REPLACE_WITH_RETURNED_ID",
  "name": "read_file",
  "arguments": "{\"path\":\"README.md\"}",
  "status": "completed"
}
```

The client reads the file using its own tool execution and approval flow, then
submits the actual content:

```bash
curl --noproxy '*' -sS http://127.0.0.1:8765/v1/responses \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "codex",
    "previous_response_id": "resp_REPLACE_WITH_RETURNED_RESPONSE_ID",
    "input": [{
      "type": "function_call_output",
      "call_id": "call_REPLACE_WITH_RETURNED_ID",
      "output": "Actual content read by the client goes here."
    }]
  }'
```

`previous_response_id` is optional when the tool call IDs identify the waiting
turn. Full input-history replay is also accepted. It is supported only for tool
continuation; the service does not store completed Responses objects for general
conversation chaining.

## Chat Completions

Send definitions as `tools:[{"type":"function","function":{...}}]`, with the
same `name`, `description`, and `parameters` fields inside `function`.

The assistant returns `message.tool_calls` with `id`, `type:"function"`, and
`function:{name,arguments}`. Its `finish_reason` is `tool_calls`. Append that
assistant message and one message per result to your conversation:

```json
{
  "role": "tool",
  "tool_call_id": "call_REPLACE_WITH_RETURNED_ID",
  "content": "Actual output from the client-side tool"
}
```

Submit the updated `messages` array. The gateway matches the IDs and resumes the
waiting Codex turn, preserving its native tool context. Repeat until
`finish_reason` is `stop`.

## Streaming and tool controls

- Both endpoints support `stream:true` through the whole tool loop.
- Chat streams indexed `delta.tool_calls`, including function names and JSON
  argument strings, then `finish_reason:"tool_calls"` and `[DONE]`.
- Responses streams `response.output_item.added`,
  `response.function_call_arguments.delta`,
  `response.function_call_arguments.done`, `response.output_item.done`, and
  `response.completed`. Function arguments arrive from Codex as a complete
  object, so their JSON is sent in one argument delta rather than token by token.
- `tool_choice:"auto"` is the default when tools are provided.
- `tool_choice:"none"` exposes no client functions.
- `tool_choice:"required"` instructs Codex to call a function and rejects a
  completed turn with HTTP 502 if it does not. This is instruction plus validation;
  app-server does not expose the OpenAI API's native forced-choice control.
- Named function choices expose only that function and enforce a call in the
  same way. Responses uses `{"type":"function","name":"read_file"}`; Chat uses
  `{"type":"function","function":{"name":"read_file"}}`.
- `parallel_tool_calls:false` delivers at most one function per HTTP response.
  Otherwise calls arriving together can be returned together. Native calls that
  arrive later are returned in a subsequent response.

## Continuation limits

- Return exactly one result for every tool call in the preceding response, in
  any order. Partial, duplicate, and mixed-session batches return HTTP 400.
- The tool list, model, instructions, reasoning effort, and tool choice stay fixed
  while that Codex turn is waiting. You can omit them in continuation requests.
  Resubmitting changed values returns HTTP 400. Replayed earlier user/assistant
  history supplies client context but is not reapplied to the waiting native turn.
- Waiting sessions expire after 5 minutes by default
  (`BRIDGE_TOOL_TIMEOUT_MS=300000`). Active inference has its own per-request
  deadline. Expired or already-consumed IDs return HTTP 410; tool execution is
  never fabricated or automatically repeated.
- Waiting turns live in memory. Restarting the service loses them. Start a new
  conversation if the client receives `tool_session_expired`.
- By default there are at most 8 active/waiting Codex sessions
  (`BRIDGE_MAX_SESSIONS`) and 2 active requests (`BRIDGE_MAX_CONCURRENT`).
- Only function tools with object JSON Schemas and text results are supported.
  `strict:true`, built-in OpenAI tools, image/audio results, sampling settings,
  and output token caps remain unsupported. Tool results can encode JSON as text.
  Return a textual error result if the client tool fails.
- Original function names are mapped to internal Codex aliases to avoid collisions
  with built-in tools; clients always see their original names.

## Verify

`npm test` uses mock subprocesses and no subscription usage. The optional live
smoke test sends a harmless synthetic tool result through a real Codex turn:

```bash
node scripts/smoke-tools.mjs
node scripts/smoke-tools.mjs chat
```

By default it starts and closes a temporary local HTTP server. To test the
deployed service, set `BRIDGE_URL=http://127.0.0.1:8765` and
`BRIDGE_TOKEN` to your generated gateway token before running it.

Actual IntelliJ Copilot requests still need an IDE-side compatibility test;
function support alone does not establish full Copilot protocol compatibility.

Protocol references: [Codex App Server](https://developers.openai.com/codex/app-server/),
[Chat Completions](https://developers.openai.com/api/reference/cli/resources/chat),
and [Responses](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).
