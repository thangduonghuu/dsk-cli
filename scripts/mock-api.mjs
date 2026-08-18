// Tiny mock DeepSeek API for UI verification: first response asks for a bash
// tool call, subsequent (tool-result) messages get a plain answer.
import { createServer } from "node:http";

const sse = (chunks) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    let last = null;
    try {
      last = JSON.parse(body).messages.at(-1);
    } catch {
      /* ignore */
    }
    if (last && last.role === "tool") {
      res.end(sse([{ choices: [{ delta: { content: "Done! The command ran and the tool output was captured." } }] }]));
    } else {
      res.end(
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "bash", arguments: '{"command": "echo hi from tool"}' } },
                  ],
                },
              },
            ],
          },
        ])
      );
    }
  });
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
