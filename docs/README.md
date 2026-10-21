# Documentation

Everything written down about the MongoDB Coding Practice Platform, in reading order.

| Document | Read it when you want to… |
|---|---|
| [`../README.md`](../README.md) | Get the overview and the quick start |
| [`SETUP.md`](SETUP.md) | Install, configure and run the stack in detail (Linux/macOS, Windows, Docker) |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Understand how the pieces fit: request flow, query pipeline, grading, workspaces |
| [`API.md`](API.md) | Call the REST API — every endpoint, body, response and error code |
| [`DATA_MODEL.md`](DATA_MODEL.md) | Know what lives in each database and collection, and what the sample data looks like |
| [`SECURITY.md`](SECURITY.md) | Review the threat model and the controls that answer each threat |
| [`TESTING.md`](TESTING.md) | Run, read or extend the test suites |
| [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) | Fix something that will not start |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Change the code: layout conventions, how to add a question, how to submit work |
| [`../backend/README.md`](../backend/README.md) | Work on the API server |
| [`../frontend/README.md`](../frontend/README.md) | Work on the React UI |
| [`../HANDOVER.md`](../HANDOVER.md) | Hand the project to someone else, or demo it in five minutes |

## Conventions used in these docs

* Shell blocks marked `bash` are for Linux/macOS; `powershell` blocks are the Windows equivalent.
  Where no PowerShell block is given, the `npm run …` command is identical on both.
* Paths are relative to `mongodb-practice-platform/` (the repository root) unless stated otherwise.
* `<angle brackets>` mark a value you supply. Nothing in these docs is a real credential.
