// @clarus/postgraphile-federation
//
// Wraps a PostGraphile v4 schema as an Apollo Federation v2 subgraph. It is
// deliberately product-agnostic: the caller passes the Postgres schemas to
// introspect, the PostGraphile options, and which fields to mark @shareable.
// Nothing in here is messaging- or agents-specific.
//
// Why this exists (as of 2026): there is no maintained off-the-shelf package
// that emits Federation v2 directives from a PostGraphile schema. The official
// graphile/federation plugin is unmaintained and Federation v1 only, and v5
// ships no first-class federation. So we own a thin, well-scoped transform.
//
// Implementation note: we do NOT post-hoc `extendSchema`/print-reparse the
// executable schema (that drops PostGraphile's resolver metadata). The
// `_service` field is added via a graphile plugin at build time; the federation
// directives are applied to the printed SDL string only — the executable schema
// is untouched, and directives matter solely at compose time.

const { createPostGraphileSchema, makeExtendSchemaPlugin, gql } = require("postgraphile");
const { printSchema, lexicographicSortSchema, parse, visit, print } = require("graphql");

const DEFAULT_FEDERATION_URL = "https://specs.apollo.dev/federation/v2.12";
const DEFAULT_FEDERATION_IMPORTS = ["@key", "@shareable", "@inaccessible", "@tag"];

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

// SDL transform: stamp @shareable onto the configured { TypeName: [fields] }.
// PostGraphile emits Relay scaffolding (PageInfo, Query.node/nodeId/query)
// identically in every subgraph; Federation v2 rejects a field resolved by more
// than one subgraph unless every subgraph marks it @shareable. Operates on the
// SDL AST only, so the executable schema's resolvers are unaffected.
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

/**
 * Create a PostGraphile schema wired as an Apollo Federation v2 subgraph.
 *
 * @param {import("pg").Pool} pool
 * @param {string|string[]} schemas                Postgres schema(s) to introspect.
 * @param {object} [options]
 * @param {object} [options.postgraphileOptions={}] Passed through to createPostGraphileSchema.
 * @param {Object<string,string[]>} [options.shareableFields={}] { TypeName: ["field", ...] } to mark @shareable.
 * @param {string} [options.federationUrl]          Federation spec URL for the @link.
 * @param {string[]} [options.federationImports]    Directives imported in the @link.
 * @returns {Promise<import("graphql").GraphQLSchema>}
 */
async function createFederatedPostGraphileSchema(pool, schemas, options = {}) {
  const {
    postgraphileOptions = {},
    shareableFields = {},
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
  const sdlTransforms = [(sdl) => applyShareable(sdl, shareableFields)];

  const printedSdl = printSchema(lexicographicSortSchema(schema));
  const transformedSdl = sdlTransforms.reduce((sdl, transform) => transform(sdl), printedSdl);

  sdlHolder.current = `${federationLink(federationUrl, federationImports)}\n\n${transformedSdl}`;

  return schema;
}

module.exports = { createFederatedPostGraphileSchema };
