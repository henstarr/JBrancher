# Contributing to JBrancher

Start with an issue for substantial changes. Keep pull requests focused, include tests for runtime behavior, and document changes that affect the public API.

Before opening a pull request:

```sh
npm test
npm run demo
```

Do not include API keys, private traces, provider responses, or generated result directories. Keep deterministic rules separate from probabilistic evaluation, and preserve the actor fallback when an evaluator is unavailable or uncertain.
