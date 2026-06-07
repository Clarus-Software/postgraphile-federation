// @clarus/postgraphile-federation
//
// Wraps a PostGraphile v4 schema as an Apollo Federation v2 subgraph. It is
// deliberately product-agnostic: the caller passes the Postgres schemas to
// introspect, the PostGraphile options, which fields to mark @shareable, and
// (optionally) which fields to gate with @requiresScopes. Nothing in here is
// specific to any one application.
//
// Why this exists (as of 2026): there is no maintained off-the-shelf package
// that emits Federation v2 directives from a PostGraphile schema. The official
// graphile/federation plugin is unmaintained and Federation v1 only, and v5
// ships no first-class federation. So we own a thin, well-scoped transform.
//
// Implementation note: we do NOT post-hoc `extendSchema`/print-reparse the
// executable schema (that drops PostGraphile's resolver metadata). The
// `_service` field is added via a graphile plugin at build time; the federation
// directives (@shareable, @requiresScopes) are applied to the printed SDL
// string only — the executable schema is untouched, and the directives matter
// solely at compose/route time.

const { createPostGraphileSchema, makeExtendSchemaPlugin, gql } = require("postgraphile");
const { printSchema, lexicographicSortSchema, parse, visit, print } = require("graphql");

const DEFAULT_FEDERATION_URL = "https://specs.apollo.dev/federation/v2.12";
const DEFAULT_FEDERATION_IMPORTS = [
  "@key",
  "@shareable",
  "@inaccessible",
  "@tag",
  "@requiresScopes",
  "@authenticated",
];

// `extend schema @link(...)` — the opt-in that makes composition treat this as a
// Federation v2 subgraph. Without it, composition falls back to Federation v1.
function federationLink(url, imports) {
  const importList = imports.map((name) => `"${name}"`).join(", ");
  return `extend schema\n  @link(url: "${url}", import: [${importList}])`;
}

// graphile plugin that adds `_service { sdl }`. The SDL is filled in lazily via
// the holder once the full schema (including this field) has been printed.
function servicePlugin(sdlHolder) {
  return makeExtendSchemaPlugin(() => ({
    typeDefs: gql`
      type _Service {
        sdl: String!
      }

      extend type Query {
        _service: _Service!
      }
    `,
    resolvers: {
      Query: {
        _service: () => ({ sdl: sdlHolder.current }),
      },
    },
  }));
}

// --- @shareable -----------------------------------------------------------
// Stamp @shareable onto the configured { TypeName: [fields] }. PostGraphile
// emits Relay scaffolding (PageInfo, Query.node/nodeId/query) identically in
// every subgraph; Federation v2 rejects a field resolved by more than one
// subgraph unless every subgraph marks it @shareable. Operates on the SDL AST.
function applyShareable(sdl, shareableFields) {
  const entries = Object.entries(shareableFields);
  if (entries.length === 0) return sdl;

  const fieldsByType = new Map(entries.map(([type, fields]) => [type, new Set(fields)]));
  const shareableDirective = { kind: "Directive", name: { kind: "Name", value: "shareable" } };

  return print(
    visit(parse(sdl), {
      ObjectTypeDefinition(node) {
        const fields = fieldsByType.get(node.name.value);
        if (!fields || !node.fields) return undefined;
        return {
          ...node,
          fields: node.fields.map((field) =>
            fields.has(field.name.value)
              ? { ...field, directives: [...(field.directives || []), shareableDirective] }
              : field,
          ),
        };
      },
    }),
  );
}

// --- @requiresScopes ------------------------------------------------------
// `authBindings` gate fields behind Apollo Router scopes. The annotator is
// domain-agnostic — it walks the printed SDL and applies @requiresScopes
// wherever the container type AND field name match a selector. Each app
// supplies its own bindings; the matching is described below.
//
// Shape — array of entries, one per scope, each with one or more selectors:
//
//   [
//     {
//       scope: "<scope-name>",
//       selectors: [
//         { types: ["<TypeName>", "<TypePattern*>", ...],
//           fields: ["<fieldA>", "<fieldB>", ...] },
//       ],
//     },
//   ]
//
// A selector matches a field line when the current type matches one of `types`
// AND the field name appears in `fields` (both required — no bare-name match).
// Type matching is exact unless the pattern contains `*` (glob, anchored), so
// one pattern can cover a row type plus its aggregate variants. Only object
// types (`type Foo { ... }`) are walked — input/interface/union/enum are
// skipped. Gate a mutation by listing `"Mutation"` in `types`.

// Returns true if `typeName` matches any pattern; `*` is a glob (anchored).
function typeMatches(typeName, patterns) {
  for (const pattern of patterns) {
    if (!pattern.includes("*")) {
      if (pattern === typeName) return true;
      continue;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(typeName)) return true;
  }
  return false;
}

// Walks the printed SDL line-by-line, tracking the current type block, and
// annotates field definitions with @requiresScopes per the bindings table.
function applyRequiresScopes(sdl, authBindings) {
  if (!authBindings || authBindings.length === 0) return sdl;

  const lines = sdl.split("\n");
  let currentType = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track type-block boundaries — object types only.
    const typeOpen = line.match(/^(?:extend )?type (\w+)/);
    if (typeOpen) {
      currentType = typeOpen[1];
      continue;
    }
    if (line === "}") {
      currentType = null;
      continue;
    }
    if (!currentType) continue;

    // Field line: `  fieldName: ReturnType` or `  fieldName(args…): …`.
    const m = line.match(/^(\s+)(\w+)(\s*[:(])(.*)$/);
    if (!m) continue;
    const fieldName = m[2];

    let scope = null;
    for (const binding of authBindings) {
      for (const selector of binding.selectors) {
        if (!selector.fields.includes(fieldName)) continue;
        if (!typeMatches(currentType, selector.types)) continue;
        scope = binding.scope;
        break;
      }
      if (scope) break;
    }

    if (scope) {
      lines[i] = `${m[1]}${m[2]}${m[3]}${m[4]} @requiresScopes(scopes: [[${JSON.stringify(scope)}]])`;
    }
  }

  return lines.join("\n");
}

/**
 * Create a PostGraphile schema wired as an Apollo Federation v2 subgraph.
 *
 * @param {import("pg").Pool} pool
 * @param {string|string[]} schemas                Postgres schema(s) to introspect.
 * @param {object} [options]
 * @param {object} [options.postgraphileOptions={}] Passed through to createPostGraphileSchema (incl. appendPlugins).
 * @param {Object<string,string[]>} [options.shareableFields={}] { TypeName: ["field", ...] } to mark @shareable.
 * @param {Array} [options.authBindings=[]]         @requiresScopes bindings (see shape spec above).
 * @param {string} [options.federationUrl]          Federation spec URL for the @link.
 * @param {string[]} [options.federationImports]    Directives imported in the @link.
 * @returns {Promise<import("graphql").GraphQLSchema>}
 */
async function createFederatedPostGraphileSchema(pool, schemas, options = {}) {
  const {
    postgraphileOptions = {},
    shareableFields = {},
    authBindings = [],
    federationUrl = DEFAULT_FEDERATION_URL,
    federationImports = DEFAULT_FEDERATION_IMPORTS,
  } = options;

  const sdlHolder = { current: "" };

  const schema = await createPostGraphileSchema(pool, schemas, {
    ...postgraphileOptions,
    appendPlugins: [...(postgraphileOptions.appendPlugins || []), servicePlugin(sdlHolder)],
  });

  // SDL assembly — an explicit, ordered pipeline. Add future directive
  // transforms (e.g. @inaccessible, @tag) to this list rather than nesting calls.
  const sdlTransforms = [
    (sdl) => applyShareable(sdl, shareableFields),
    (sdl) => applyRequiresScopes(sdl, authBindings),
  ];

  const printedSdl = printSchema(lexicographicSortSchema(schema));
  const transformedSdl = sdlTransforms.reduce((sdl, transform) => transform(sdl), printedSdl);

  sdlHolder.current = `${federationLink(federationUrl, federationImports)}\n\n${transformedSdl}`;

  return schema;
}

module.exports = { createFederatedPostGraphileSchema };
