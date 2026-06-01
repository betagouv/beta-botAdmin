# CLI — Local client spec

`src/cli.ts`

## Role

Interactive readline client that exercises the `Orchestrator` locally — no Matrix connection required. Useful for development and manual testing.

## Usage

```sh
npm run cli
# or with interleaved debug logs:
npm run cli 2>&1 | cat
```

Prompts `vous > `, sends each line to `orchestrator.handle`, prints the response as `betabot > ...`, then clears history so each question is independent.

## Behaviour

- History is cleared after every question (`orchestrator.clearHistory("cli")`), so there is no multi-turn context in CLI mode.
- `userId` is hardcoded to `"local-user"`, `roomId` to `"cli"`.
- Empty lines are skipped.
- Ctrl+C / EOF exits with code 0.
- Errors are printed to stderr and the prompt continues.

## Entry point

`src/index.ts` starts the Matrix bot; `src/cli.ts` is a separate entry point only for local use.

## npm scripts

| Script        | Command                                        |
| ------------- | ---------------------------------------------- |
| `npm run cli` | `node --env-file=.env --import tsx src/cli.ts` |
