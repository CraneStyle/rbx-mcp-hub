// Tools handled by the bridge itself — never forwarded to a Studio plugin.
export const BRIDGE_TOOL_DEFINITIONS = [
  {
    name: "list_places",
    description:
      "List the Roblox Studio sessions currently connected to the hub, with each one's PlaceId, reported place name, and connection freshness. Use this to discover what bind_place can target.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bind_place",
    description:
      "Bind (or re-bind) this MCP session to a Studio session by PlaceId. All subsequent Studio tools route to that place. Refused when the bridge was started with a fixed RBX_PLACE_ID unless RBX_ALLOW_REBIND=1 is also set.",
    inputSchema: {
      type: "object",
      properties: {
        placeId: {
          type: ["string", "number"],
          description:
            "PlaceId of the target Studio session (find it via list_places, or `print(game.PlaceId)` in Studio).",
        },
      },
      required: ["placeId"],
    },
  },
];

export const TOOL_DEFINITIONS = [
  {
    name: "run_code",
    description:
      "Execute arbitrary Luau code inside the target Roblox Studio session's Edit DataModel. Returns whatever the snippet returns (stringified) or prints.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Luau source to execute. Avoid long-running loops.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "insert_model",
    description:
      "Insert a model from the Creator Store into the target Studio session's workspace. Provide either `query` (free-form marketplace search via InsertService:GetFreeModels; top match is inserted) or `assetId` (direct Creator Store id). Model roots are pivoted to the point under the Studio camera's viewport center so the model lands where the user is looking.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-form marketplace search query. The top InsertService:GetFreeModels result is inserted. Mutually exclusive with assetId.",
        },
        assetId: {
          type: ["string", "number"],
          description:
            "Creator Store asset id. Mutually exclusive with query.",
        },
      },
    },
  },
  {
    name: "get_console_output",
    description:
      "Return recent LogService output from the target Studio session. Default last 200 lines.",
    inputSchema: {
      type: "object",
      properties: {
        lines: {
          type: "number",
          description: "How many of the most recent lines to return.",
          default: 200,
        },
      },
    },
  },
  {
    name: "start_stop_play",
    description:
      "Start or stop a play / run-server session in the target Studio window.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["play", "run", "stop"],
          description:
            "'play' = Play Solo, 'run' = Run (server only), 'stop' = stop the current session.",
        },
      },
      required: ["mode"],
    },
  },
  {
    name: "run_script_in_play_mode",
    description:
      "Start Play or Run mode, inject the provided Luau as a Script into ServerScriptService, pcall it, capture logs + return value, stop, and return the structured result. One-shot test runner.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "Luau to execute during the session." },
        mode: {
          type: "string",
          enum: ["play", "run"],
          default: "play",
          description:
            "'play' = StudioTestService:ExecutePlayModeAsync (Play Solo, client + server + character). 'run' = ExecuteRunModeAsync (server-only, no character spawning).",
        },
        side: {
          type: "string",
          enum: ["client", "server"],
          default: "server",
          description: "Only 'server' is implemented; client-side injection is a TODO.",
        },
        timeoutSeconds: {
          type: "number",
          default: 10,
          description:
            "How long the injected runner waits for your code before force-ending the test. Note: the hub's per-command timeout is 60s, so values above ~50s will be cut off by the bridge.",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "get_studio_mode",
    description:
      "Report the current mode of the target Studio session: 'edit', 'play', 'run', or 'stopped'.",
    inputSchema: { type: "object", properties: {} },
  },
];
