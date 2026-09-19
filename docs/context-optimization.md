# Context optimization

`optimizeContext` is JBrancher's first active token optimization path. It is designed
for a harness that already owns the task state and can represent context as bounded
items before assembling a model prompt.

```js
import { optimizeContext } from 'jbrancher/context';
import { createJevContextEvaluator } from 'jbrancher/jev';

const result = await optimizeContext({
  task,
  state,
  items,
  requiredIds: ['task', 'policy'],
  maxTokens: 4000,
  minimumScore: 0.6,
  evaluate: createJevContextEvaluator({
    apiKey: process.env.TYPESAFE_API_KEY,
    maxItemChars: 512
  })
});
```

The evaluator asks one narrow Noul question per optional item: whether omitting that
item would make the next model step less reliable. Code then ranks the returned
probabilities by score per estimated token and fills the budget. Required context is
never dropped. JBrancher never treats a relevance score as authorization.

Use short `title`/`kind` fields and harness-provided token estimates where possible.
For long items, prefer a precomputed summary or a bounded excerpt; the evaluator's
`maxItemChars` is an input-cost control, not a guarantee that the beginning of a file
contains its important evidence. A 128-character cap won a local smoke hill-climb,
but the package default is 512 to reduce truncation risk.

## Measurement contract

Report both:

- frontier input/output tokens before and after selection;
- Jev input/output tokens;
- net tokens, selection coverage, answer/task success, latency, and fallback rate.

An optimization only counts as a win when net tokens decrease without losing required
context or task success. If Jev's own request costs more than the saved frontier input,
keep the full context or reuse the selection across multiple turns.
