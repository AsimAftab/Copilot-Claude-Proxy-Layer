# Models

## Why discovery instead of a hardcoded list

Copilot's Claude model IDs are not internally consistent:

- `claude-opus-4.8` and `claude-haiku-4.5` use a **dot** before the minor version
- `claude-opus-5` and `claude-sonnet-5` have **no minor version at all**
- Claude Code sends canonical Anthropic names such as `claude-opus-4-5-20250514`, using
  **hyphens** and a date suffix

Public sources disagree on which form the API accepts, and the answer has changed between
releases. Hardcoding a mapping table is therefore a coin flip that also rots with every new
model.

Instead the proxy reads the live catalog from `GET {base}/models` at runtime. New models
become available with no code change, and models your plan is not entitled to simply never
appear.

## Resolution order

`resolveModel()` tries progressively looser matches:

1. **Exact** — the requested name is already a catalog ID.
2. **Normalised** — lowercase, drop a trailing `-YYYYMMDD` date stamp, and fold `.` and `-`
   together. This makes `claude-opus-4-5`, `claude-opus-4.5` and
   `claude-opus-4-5-20250514` all resolve to whichever form the catalog actually uses.
3. **Family alias** — a bare `opus` / `sonnet` / `haiku`, or an unrecognised Claude version,
   resolves to the **newest** model in that family (version-scored, so 5 beats 4.8).
4. **Pass-through** — anything else is forwarded untouched, so Copilot's GPT and Gemini
   models keep working.

If the live catalog contains no member of a requested family (e.g. your plan has no Haiku),
resolution falls back to `DEFAULT_MODEL` rather than guessing an ID the account cannot reach —
which would otherwise surface as a confusing upstream 404 for a model you never asked for.

If the catalog is unreachable entirely, a static fallback list in `src/config/index.ts` is
used, with `FAMILY_ALIAS_PREFERENCE` supplying the alias ordering.

## Caching

The catalog is cached in memory for `MODEL_CACHE_TTL_MS` (default 1 hour). Concurrent
refreshes collapse into a single upstream call. On failure the previous catalog is reused
before falling back to the static list, and the fallback is cached briefly (30s) so a broken
catalog isn't refetched on every request.

## Using a specific model in Claude Code

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:3000",
    "ANTHROPIC_AUTH_TOKEN": "sk-dummy",
    "ANTHROPIC_MODEL": "claude-opus-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4.5"
  }
}
```

Aliases work too — `"ANTHROPIC_MODEL": "opus"` always selects the newest Opus your account
can reach.

Run `curl http://localhost:3000/v1/models` to see exactly what your subscription exposes.

## Plan entitlement

Opus-class models require Copilot **Pro+**, **Max**, **Business**, or **Enterprise**. Sonnet
is available from **Pro** upward. If `claude-opus-5` is missing from `/v1/models`, the account
lacks entitlement — this is the expected, diagnosable signal rather than an opaque upstream 400.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DEFAULT_MODEL` | `claude-opus-5` | Used when a request omits a model |
| `EXPOSE_ALL_MODELS` | unset | `1` also lists non-Anthropic Copilot models on `/v1/models` |
| `MODEL_CACHE_TTL_MS` | `3600000` | Catalog cache lifetime |
| `COPILOT_API_BASE` | unset | Override the discovered API host |

## Cost

Since June 2026 Copilot bills usage-based at provider list price. Opus 5 is the most
expensive option in the fleet — keep `claude-sonnet-5` or `claude-haiku-4.5` configured as
the small/fast model to control spend.
