# @clarus/postgraphile-federation

Turn a **PostGraphile v4** schema into a valid **Apollo Federation v2** subgraph.

A small, product-agnostic helper for any PostGraphile subgraph you want to federate behind an Apollo Router. The caller supplies the Postgres schemas, the PostGraphile options, the `@shareable` field map, and (optionally) the `@requiresScopes` authorization bindings — nothing in here is specific to any one application.

---

## Why this exists

PostGraphile generates a plain GraphQL schema; Apollo Federation v2 needs that schema to opt in with `extend schema @link(...)`, expose `_service { sdl }`, and mark fields shared across subgraphs as `@shareable`. As of 2026 there is **no maintained off-the-shelf package** that does this for PostGraphile:

- The official [`graphile/federation`](https://github.com/graphile/federation) plugin is **unmaintained** (last release 2021) and **Federation v1 only** — it just exposes the Relay `Node` interface.
- PostGraphile **v5** ships **no first-class federation** support.

So we own this thin, well-scoped transform rather than forking it into every subgraph.

## What it does

1. **`_service { sdl }`** — adds the federation introspection field via a graphile plugin (build time).
2. **`@link` opt-in** — prepends the `extend schema @link(url: "…/federation/v2.x", import: [...])` block that makes composition treat the schema as Federation v2.
3. **`@shareable`** — stamps the directive onto caller-specified `{ TypeName: [fields] }`. PostGraphile emits identical Relay scaffolding (`PageInfo`, `Query.node/nodeId/query`) in every subgraph, and Federation v2 rejects a field resolved by more than one subgraph unless **every** subgraph marks it `@shareable`.
4. **`@requiresScopes`** — gates fields behind Apollo Router scopes, driven by caller-supplied `authBindings` (type + field → scope). Optional; omit it and no authorization directives are emitted.

> The directives are applied to the **printed SDL only**, never the executable schema — so PostGraphile's resolver metadata is untouched (directives matter solely at compose/route time). We deliberately avoid `extendSchema`/print-reparse of the live schema, which would drop PostGraphile's resolve-data planner metadata.

## Install

Consumed as a git dependency (the repo is public, so no credentials are needed):

```jsonc
// package.json
{
  "dependencies": {
    "@clarus/postgraphile-federation": "github:Clarus-Software/postgraphile-federation#main"
  }
}
```

`postgraphile@^4` and `graphql@^16` are **peer dependencies** — provided by the consuming subgraph. Because it's a `github:` dependency, the consumer's image build needs `git` available for `npm ci` (e.g. `apk add --no-cache git` on Alpine); no auth, as the repo is public.

## Usage

```js
const { Pool } = require("pg");
const { createFederatedPostGraphileSchema } = require("@clarus/postgraphile-federation");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const schema = await createFederatedPostGraphileSchema(pool, ["my_schema"], {
  // Owned by the app, not this package — each subgraph declares its own:
  shareableFields: {
    PageInfo: ["endCursor", "hasNextPage", "hasPreviousPage", "startCursor"],
    Query: ["node", "nodeId", "query"],
  },

  // Optional — gate fields behind Apollo Router scopes (see "Field authorization" below):
  authBindings: [
    { scope: "widget/read-secret",
      selectors: [{ types: ["Widget", "Widget*Aggregates"], fields: ["internalCost"] }] },
    { scope: "widget/write",
      selectors: [{ types: ["Mutation"], fields: ["createWidget"] }] },
  ],

  // Passed straight through to createPostGraphileSchema (incl. extra plugins):
  postgraphileOptions: {
    dynamicJson: true,
    ignoreRBAC: false,
    legacyRelations: "omit",
    // appendPlugins: [ConnectionFilterPlugin, PgAggregatesPlugin],
  },

  // Optional overrides (defaults shown):
  // federationUrl: "https://specs.apollo.dev/federation/v2.12",
  // federationImports: ["@key", "@shareable", "@inaccessible", "@tag", "@requiresScopes", "@authenticated"],
});
```

Pass the returned schema to your Apollo Server / `@apollo/server` instance as usual. The published SDL (`_service.sdl`) is what your introspect + `rover subgraph publish` step sends to GraphOS.

### API

`createFederatedPostGraphileSchema(pool, schemas, options) → Promise<GraphQLSchema>`

| arg | type | notes |
|---|---|---|
| `pool` | `pg.Pool` | Postgres connection pool. |
| `schemas` | `string \| string[]` | Postgres schema(s) to introspect. |
| `options.postgraphileOptions` | `object` | Merged into `createPostGraphileSchema` options. |
| `options.shareableFields` | `{ [Type]: string[] }` | Fields to mark `@shareable`. Default `{}`. |
| `options.authBindings` | `Array` | `@requiresScopes` bindings (see below). Default `[]`. |
| `options.federationUrl` | `string` | Federation spec URL for the `@link`. |
| `options.federationImports` | `string[]` | Directives imported in the `@link` (default includes `@requiresScopes`/`@authenticated`). |

## The shared-scaffolding gotcha

Every PostGraphile subgraph emits `PageInfo.{endCursor,hasNextPage,hasPreviousPage,startCursor}` and `Query.{node,nodeId,query}` identically. The supergraph won't compose with `INVALID_FIELD_SHARING` unless **all** subgraphs mark those `@shareable`. So each consuming subgraph must pass the same `shareableFields` (above). These fields are Relay plumbing — they carry no domain data, so "who owns them" is immaterial.

## Field authorization (`@requiresScopes`)

Pass `authBindings` to gate fields behind Apollo Router scopes. The annotator is domain-agnostic — it walks the printed SDL and stamps `@requiresScopes` wherever the container **type** *and* **field name** match a selector. Keep the bindings in your app (e.g. an `auth-bindings.js`) so the package stays generic.

```js
const AUTH_BINDINGS = [
  {
    scope: "widget/read-secret",
    selectors: [
      // exact type, or a glob like "Widget*Aggregates" to also cover aggregate variants
      { types: ["Widget", "Widget*Aggregates"], fields: ["internalCost", "supplierMargin"] },
    ],
  },
  {
    scope: "widget/write",
    selectors: [
      { types: ["Mutation"], fields: ["createWidget", "applyWidgetPatch"] }, // gate a mutation
    ],
  },
];
```

Matching rules:
- A selector matches when the current type matches one of `types` **and** the field name is in `fields` (both required — no bare-name fallback that could hit the same field on an unrelated type).
- `types` are exact unless they contain `*` (anchored glob) — one pattern covers a row type plus its aggregate siblings.
- Only object types (`type Foo { … }`) are walked; `input`/`interface`/`union`/`enum` are skipped. Gate a mutation by listing `"Mutation"` in `types`.
- Omit `authBindings` and no `@requiresScopes` is emitted (the `@link` still imports it, which is harmless).

## Adding more directives

Extend the `sdlTransforms` pipeline in `index.js` (one entry per transform — e.g. `@inaccessible`, `@tag`) rather than nesting calls.

## Versioning

Consumers pin to a branch (`#main`) or tag; their `package-lock.json` records the resolved commit. Tag releases (`v0.1.0`, …) when you want consumers to move deliberately rather than track `main`.
