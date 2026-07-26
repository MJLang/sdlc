// The single authority for the `.agents/sdlc.json` key set. `lib/config.mjs`
// validates and resolves against the enums and patterns exported here;
// `scripts/render-config-reference.mjs` (a later step) renders both the
// shipped template and the reference document from `CONFIG_SCHEMA` alone.
// Nothing else may declare the supported key set.

export const CONFIG_VERSION = 1;
export const HOSTS = ['claude', 'codex', 'pi'];
export const TIERS = ['frontier', 'balanced', 'cheap'];
export const EFFORTS = ['low', 'medium', 'high'];
export const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

// `key` is a dotted path; `targets[].xxx` denotes a field of each element of
// the `targets` array. `default` documents the value used when the key is
// omitted — a prose description (e.g. "inherits models.defaults.tier") where
// the effective value depends on sibling configuration rather than a literal.
export const CONFIG_SCHEMA = [
  {
    key: '$schema',
    type: 'string',
    required: false,
    default: null,
    localOverridable: true,
    // Meta keys configure tooling (here: editor validation via the shipped
    // JSON Schema), not the pipeline. Steps 3/4 render meta keys into the
    // template and the JSON Schema but exclude them from `sdlc config`'s
    // effective-settings listing, so they add no noise to any stage's output.
    meta: true,
    description: 'Path to the JSON Schema file, for editor validation; has no effect on pipeline behavior.',
    example: './sdlc.schema.json',
  },
  {
    key: 'version',
    type: 'integer',
    required: true,
    default: undefined,
    localOverridable: true,
    description: 'Schema version for `.agents/sdlc.json`; only `1` is recognized today.',
    example: 1,
  },
  {
    key: 'targets',
    type: 'object[]',
    required: true,
    default: undefined,
    localOverridable: false,
    legacyLabel: 'Targets',
    description: 'Ordered list of named work lanes; declaration order sets precedence when target paths overlap.',
    example: [{ name: 'app', paths: ['src/**', 'test/**'], gates: ['npm run test:app'], reviewers: ['backend-code-reviewer'] }],
  },
  {
    key: 'targets[].name',
    type: 'string',
    required: true,
    default: undefined,
    localOverridable: false,
    pattern: NAME_PATTERN,
    description: `Lane identifier; must match ${NAME_PATTERN} and be unique among targets.`,
    example: 'app',
  },
  {
    key: 'targets[].paths',
    type: 'string[]',
    required: false,
    default: [],
    localOverridable: false,
    itemPattern: /\S/,
    legacyLabel: 'Target paths',
    description: 'Glob patterns whose changed files belong to this target.',
    example: ['src/**', 'test/**'],
  },
  {
    key: 'targets[].gates',
    type: 'string[]',
    required: false,
    default: [],
    localOverridable: false,
    itemPattern: /\S/,
    legacyLabel: 'Target gates',
    description: 'Quality-gate commands run in addition to the top-level gates when this target is selected.',
    example: ['npm run test:app'],
  },
  {
    key: 'targets[].reviewers',
    type: 'string[]',
    required: false,
    default: 'inherits the top-level reviewers',
    localOverridable: false,
    description: 'Reviewer profiles for this target; inherits the top-level reviewers when omitted.',
    example: ['backend-code-reviewer'],
  },
  {
    key: 'gates',
    type: 'string[]',
    required: false,
    default: [],
    localOverridable: false,
    itemPattern: /\S/,
    legacyLabel: 'Quality gates',
    description: 'Quality-gate commands run for every target.',
    example: ['npm test'],
  },
  {
    key: 'reviewers',
    type: 'string[]',
    required: false,
    default: [],
    localOverridable: false,
    legacyLabel: 'Reviewers',
    description: 'Default reviewer profiles for targets that do not declare their own.',
    example: ['backend-code-reviewer'],
  },
  {
    key: 'productDocs',
    type: 'string',
    required: false,
    default: 'thoughts/docs/',
    localOverridable: false,
    legacyLabel: 'Product docs',
    description: 'Repository-relative directory of durable product documentation.',
    example: 'thoughts/docs/',
  },
  {
    key: 'frontendConstraints',
    type: 'string',
    required: false,
    default: 'none',
    localOverridable: false,
    legacyLabel: 'Frontend constraints',
    description: 'Prose constraints frontend reviewers and implementers must honor.',
    example: 'none',
  },
  {
    key: 'beads.mode',
    type: 'enum',
    values: ['embedded', 'server'],
    required: false,
    default: 'embedded',
    localOverridable: false,
    legacyLabel: 'Beads mode',
    description: 'Beads coordination backend: an embedded local store or a shared server.',
    example: 'embedded',
  },
  {
    key: 'beads.mergeSlot',
    type: 'enum',
    values: ['off', 'on'],
    required: false,
    default: 'off',
    localOverridable: false,
    legacyLabel: 'Beads merge slot',
    description: 'Whether the single-writer merge slot is enforced before landing.',
    example: 'off',
  },
  {
    key: 'local.reviewEditor',
    type: 'string',
    required: false,
    default: null,
    localOverridable: true,
    legacyLabel: 'Review editor',
    description: 'Command template that opens a worktree in the developer\'s editor; machine-scoped.',
    example: 'code {worktree}',
  },
  {
    key: 'local.preview.command',
    type: 'string',
    required: false,
    default: null,
    localOverridable: true,
    legacyLabel: 'Local preview',
    description: 'Command template that starts a local preview server; machine-scoped.',
    example: 'npm run dev -- --port {port}',
  },
  {
    key: 'local.preview.url',
    type: 'string',
    required: false,
    default: null,
    localOverridable: true,
    legacyLabel: 'Preview URL',
    description: 'URL template for the local preview server; machine-scoped.',
    example: 'http://localhost:{port}',
  },
  {
    key: 'models.defaults.tier',
    type: 'enum',
    values: TIERS,
    required: false,
    default: 'balanced',
    localOverridable: true,
    description: 'Fallback model tier for roles that do not declare their own.',
    example: 'balanced',
  },
  {
    key: 'models.defaults.effort',
    type: 'enum',
    values: EFFORTS,
    required: false,
    default: 'medium',
    localOverridable: true,
    description: 'Fallback reasoning effort for roles that do not declare their own.',
    example: 'medium',
  },
  {
    key: 'models.roles',
    type: 'object',
    required: false,
    default: {},
    localOverridable: true,
    description: 'Per-role tier/effort overrides; role names are open-ended.',
    example: { 'plan-reviewer': { tier: 'frontier', effort: 'high' } },
  },
  {
    key: 'models.roles.<role>.tier',
    type: 'enum',
    values: TIERS,
    required: false,
    default: 'inherits models.defaults.tier',
    localOverridable: true,
    description: 'Model tier for this role; falls back to models.defaults.tier.',
    example: 'frontier',
  },
  {
    key: 'models.roles.<role>.effort',
    type: 'enum',
    values: EFFORTS,
    required: false,
    default: 'inherits models.defaults.effort',
    localOverridable: true,
    description: 'Reasoning effort for this role; falls back to models.defaults.effort.',
    example: 'high',
  },
  {
    key: 'models.tiers',
    type: 'object',
    required: false,
    default: {},
    localOverridable: true,
    description: 'Per-host model identifiers for each tier.',
    example: { claude: { frontier: 'inherit', balanced: 'sonnet', cheap: 'haiku' } },
  },
  {
    key: 'models.tiers.<host>.<tier>',
    type: 'string',
    required: false,
    default: undefined,
    pattern: /\S/,
    localOverridable: true,
    description: 'Concrete model identifier a host resolves this tier to.',
    example: 'sonnet',
  },
];

function topLevelSegment(dottedKey) {
  return dottedKey.split(/[.[]/)[0];
}

// A top-level key is local-overridable only when every field nested under it
// is. This is the one place the boundary is computed; nothing else may
// hand-maintain a parallel list (AC-009).
function topLevelLocalOverridability() {
  const map = new Map();
  for (const field of CONFIG_SCHEMA) {
    const top = topLevelSegment(field.key);
    if (!map.has(top)) map.set(top, true);
    if (!field.localOverridable) map.set(top, false);
  }
  return map;
}

export function localAllowedTopLevelKeys() {
  return [...topLevelLocalOverridability()].filter(([, allowed]) => allowed).map(([key]) => key);
}

export function sharedOnlyTopLevelKeys() {
  return [...topLevelLocalOverridability()].filter(([, allowed]) => !allowed).map(([key]) => key);
}

// Constraints for the open-ended placeholder segments used in dotted keys
// above (`<role>`, `<host>`, `<tier>`), so a JSON Schema renderer — or
// `lib/config.mjs`'s validator — can resolve them without re-declaring
// `NAME_PATTERN`, `HOSTS`, or `TIERS` at the call site.
export const PLACEHOLDERS = {
  '<role>': { pattern: NAME_PATTERN },
  '<host>': { values: HOSTS },
  '<tier>': { values: TIERS },
};
