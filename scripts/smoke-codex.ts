import { Codex } from "@openai/codex-sdk";
const codex = new Codex();
const thread = codex.startThread({ workingDirectory: "/Users/hepl/harrrghnesss", sandboxMode: "read-only", skipGitRepoCheck: true, modelReasoningEffort: "low" });
const turn = await thread.run("Reply with exactly: HARNESS-OK");
console.log("response:", turn.finalResponse);
console.log("thread:", thread.id);
console.log("usage:", JSON.stringify(turn.usage));
