// Try Slack's unreleased features by overriding its experiments

import {
  type ExperimentAssignment as Assignment,
  type MenuTemplateItem,
  TautPlugin,
} from '$taut'

/** experiment name -> group to read as, or null to read as not assigned */
type Overrides = Record<string, string | null>
type Row = {
  name: string
  groups: readonly string[]
  /** listed only because its name was typed */
  typed?: boolean
}

const PAGE = 100
const COMMON_GROUPS = ['on', 'off', 'control', 'treatment']
// stable identity so it doesn't break memos
const NO_ASSIGNMENTS: Record<string, Assignment> = {}
/** how long typing pauses before the list filters */
const SEARCH_DELAY = 200

export default class Experiments extends TautPlugin<typeof Experiments> {
  static readonly id = 'Experiments'
  static readonly pluginName = 'Experiments'
  static readonly description =
    "Try Slack's unreleased features by overriding its experiments"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: false,
  }

  private overrides = this.api.storage.store<Overrides>('overrides', {})
  /** the overrides at boot, to show when a reload is needed */
  private bootOverrides: Overrides = {}

  /** experiment name -> groups autodetected from slack's code */
  private codeGroups = new Map<string, Set<string>>()
  private scanned = new Set<string>()
  private scanVersion = new this.api.Store(0)
  /** holds Slack's `getAllExperimentAssignments` selector once it loads */
  private allAssignments = new this.api.Store<
    ((state: unknown) => Record<string, Assignment> | undefined) | undefined
  >(undefined)

  async start() {
    // what other plugins force wins over what's picked here
    this.api.experiments.priority = -1
    await this.overrides.ready
    if (this.api.signal.aborted) return
    this.bootOverrides = this.overrides.get()
    this.apply()
    this.overrides.subscribe(() => this.apply())
    this.api
      .waitForExport<(state: unknown) => Record<string, Assignment>>(
        this.api.byMeta('getAllExperimentAssignments')
      )
      .then(this.allAssignments.set)
    this.api.setStyle(`
      .p-prefs_dialog__panel:has(.taut-experiments) { scrollbar-gutter: stable; }
      .taut-experiments__title { margin-bottom: 12px; }
      .taut-experiments__muted {
        margin: 0 0 12px;
        color: var(--dt_color-content-sec);
      }
      .taut-experiments__bar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 12px;
      }
      .taut-experiments__bar .taut-experiments__muted { margin: 0; }
      .taut-experiments__status { min-height: 28px; margin-bottom: 4px; }
      .taut-experiments__status > .taut-experiments__muted { flex: 1; }
      .taut-experiments .c-input_text { margin: 0; }
      .taut-experiments__search { position: relative; }
      .taut-experiments__search .c-input_text { padding-right: 36px; }
      .taut-experiments__clear {
        position: absolute;
        top: 50%;
        right: 8px;
        display: flex;
        transform: translateY(-50%);
        color: var(--dt_color-content-sec);
      }
      .taut-experiments__clear:hover { color: var(--dt_color-content-pry); }
      .taut-experiments__error { margin-top: 8px; }
      .taut-experiments__menus {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin: 8px 0;
      }
      .taut-experiments__menus .c-icon { margin-left: 2px; }
      .taut-experiments__sort {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        color: var(--dt_color-content-sec);
      }
      .taut-experiments__sort:hover { color: var(--dt_color-content-pry); }
      .taut-experiments__rows {
        margin: 0 0 12px;
        padding: 0;
        list-style: none;
      }
      .taut-experiments__row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px 12px;
        padding: 4px 0 4px 8px;
        border-top: 1px solid var(--dt_color-otl-ter);
      }
      .taut-experiments__row--typed .taut-experiments__name {
        color: var(--dt_color-content-ter);
      }
      .taut-experiments__row--overridden {
        box-shadow: inset 3px 0 0 var(--dt_color-content-hig);
      }
      .taut-experiments__row--overridden .taut-experiments__name {
        font-weight: 700;
      }
      .taut-experiments__name {
        overflow-wrap: anywhere;
        font-family: Monaco, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .taut-experiments__assignment,
      .taut-experiments__forced {
        color: var(--dt_color-content-sec);
        font-size: 12px;
      }
      .taut-experiments__forced { grid-column: 1 / -1; }
      .taut-experiments__custom {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .taut-experiments__custom > :first-child { flex: 1 1 auto; min-width: 0; }
    `)
    this.api.preferences.addTab({
      label: 'Experiments',
      icon: 'magic-wand',
      render: () => <this.Panel />,
    })
  }

  private apply() {
    const overrides = this.overrides.get()
    const { experiments } = this.api
    for (const name of [...experiments.keys()])
      if (!(name in overrides)) experiments.delete(name)
    for (const [name, group] of Object.entries(overrides))
      experiments.set(name, group)
  }

  private save(change: (overrides: Overrides) => Overrides) {
    this.overrides
      .update(change)
      .catch((err) => this.log('Could not save overrides', err))
  }

  private readonly setOverride = (
    name: string,
    group: string | null | undefined
  ) =>
    this.save((overrides) => {
      const next = { ...overrides }
      if (group === undefined) delete next[name]
      else next[name] = group
      return next
    })

  /** find `(0,x.getGroupForUser)(state, "name")` calls to the experiment selectors and the groups they're compared to, best effort */
  private async scanCode() {
    const isAll = this.api.byMeta('getAllExperimentAssignments')
    const selectors = await this.api.waitForExport<Record<string, unknown>>(
      (exp: any) =>
        !!exp && typeof exp === 'object' && Object.values(exp).some(isAll)
    )
    const id = this.api.findModuleId(selectors)
    if (id === undefined) return
    const keys = Object.keys(selectors).filter(
      (key) => typeof selectors[key] === 'function'
    )
    const required = /^\d+$/.test(id)
      ? `\\(${id}\\)`
      : `\\("${RegExp.escape(id)}"\\)`
    const importRe = new RegExp(`([\\w$]+)=[\\w$]+${required}`, 'g')
    const needle = /^\d+$/.test(id) ? `(${id})` : `("${id}")`
    const group = String.raw`"([^"\\]{1,80})"`
    let found = false

    for (const [moduleId, source] of this.api.getModuleSources()) {
      if (this.scanned.has(moduleId)) continue
      this.scanned.add(moduleId)
      if (!source.includes(needle)) continue
      const aliases = new Set(
        Array.from(source.matchAll(importRe), (m) => m[1])
      )
      if (!aliases.size) continue
      const call = String.raw`\(0,(?:${[...aliases].map(RegExp.escape).join('|')})\.(?:${keys.map(RegExp.escape).join('|')})\)\([^,()]{1,40},"([\w.-]{1,120})"[^()]{0,20}\)`
      const pattern = new RegExp(
        String.raw`(?:${group}\s*[!=]==?\s*|\[((?:"[^"\\]{1,80}",?){1,8})\]\.includes\()?${call}(?:\s*[!=]==?\s*${group})?`,
        'g'
      )
      for (const [, before, list, name, after] of source.matchAll(pattern)) {
        if (!name) continue
        const groups = this.codeGroups.get(name) ?? new Set()
        this.codeGroups.set(name, groups)
        if (before) groups.add(before)
        if (after) groups.add(after)
        for (const [, item] of list?.matchAll(/"([^"]+)"/g) ?? [])
          groups.add(item)
        found = true
      }
    }
    if (found) this.scanVersion.set(this.scanVersion.get() + 1)
  }

  private readonly Panel = () => {
    const { elements } = this.api
    const overrides = this.overrides.use()
    const scanVersion = this.scanVersion.use()
    const assignments: Record<string, Assignment> =
      this.api.redux.useReduxState(
        // slack's assignments, before other plugins' slice patches
        () => this.api.redux.getRawState()?.experiments
      ) ?? NO_ASSIGNMENTS
    const allAssignments = this.allAssignments.use()
    const effective: Record<string, Assignment> | undefined =
      this.api.redux.useReduxState((state) => allAssignments?.(state))
    const [query, setQuery] = React.useState('')
    const [appliedQuery, setAppliedQuery] = React.useState('')
    const [limit, setLimit] = React.useState(PAGE)
    React.useEffect(() => {
      const timer = setTimeout(() => setAppliedQuery(query), SEARCH_DELAY)
      return () => clearTimeout(timer)
    }, [query])
    const applyQuery = (next: string) => {
      setQuery(next)
      setAppliedQuery(next)
      setLimit(PAGE)
    }

    React.useEffect(() => {
      this.scanCode()
    }, [])

    const searchRef = React.useRef<HTMLInputElement>(null)
    // the preferences dialog focuses its tab after the panel mounts
    React.useEffect(() => {
      const frame = requestAnimationFrame(() =>
        searchRef.current?.focus({ preventScroll: true })
      )
      return () => cancelAnimationFrame(frame)
    }, [])

    const rows = React.useMemo(() => {
      const names = new Set([
        ...Object.keys(assignments),
        ...this.codeGroups.keys(),
        ...Object.keys(overrides),
      ])
      return [...names].sort().map(
        (name): Row => ({
          name,
          groups: [
            ...new Set([
              ...(this.codeGroups.get(name) ?? []),
              ...(assignments[name]?.group ? [assignments[name].group] : []),
              ...COMMON_GROUPS,
            ]),
          ],
        })
      )
    }, [assignments, scanVersion, overrides])

    const { conditions, sort, errors } = React.useMemo(
      () => parseQuery(appliedQuery),
      [appliedQuery]
    )
    const { shown, matches } = React.useMemo(() => {
      const matching = rows.filter(({ name }) =>
        matchesQuery(conditions, {
          name,
          assignment: assignments[name],
          override: overrides[name],
        })
      )
      const matches = matching.length
      const scheduled = (name: string) => assignments[name]?.schedule_ts ?? 0
      if (sort === 'newest')
        matching.sort((a, b) => scheduled(b.name) - scheduled(a.name))
      if (sort === 'oldest')
        // undated ones still go last
        matching.sort(
          (a, b) =>
            (scheduled(a.name) || Infinity) - (scheduled(b.name) || Infinity)
        )
      const words = conditions.filter((condition) => condition.prefix === null)
      const onlyWord =
        words.length === 1 && !words[0].negated ? words[0].value : null
      if (!onlyWord) return { shown: matching, matches }
      if (!sort || sort === 'name')
        matching.sort(
          (a, b) =>
            Number(!a.name.startsWith(onlyWord)) -
            Number(!b.name.startsWith(onlyWord))
        )
      // an experiment in code that hasn't loaded yet can still be set by name
      if (
        conditions.length === 1 &&
        !sort &&
        /^[\w.-]{1,120}$/.test(onlyWord) &&
        !matching.some(({ name }) => name === onlyWord)
      )
        matching.push({ name: onlyWord, groups: COMMON_GROUPS, typed: true })
      return { shown: matching, matches }
    }, [rows, conditions, sort, overrides, assignments])

    const count = Object.keys(overrides).length
    const overridden = isChosen(tokenize(query), 'override', OVERRIDDEN)
    const booted = Object.entries(this.bootOverrides)
    const needsReload =
      booted.length !== count ||
      booted.some(([name, group]) => overrides[name] !== group)

    const resetAll = async () => {
      const ok = await this.api.modal.confirm({
        title: 'Reset all experiments?',
        body: `Removes ${count} override${count === 1 ? '' : 's'}.`,
        confirmText: 'Reset',
      })
      if (ok) this.save(() => ({}))
    }

    return (
      <div className="taut-experiments">
        <h2 className="taut-experiments__title">Experiments</h2>
        <div className="taut-experiments__search">
          <elements.FormTextInput
            placeholder={`Search ${rows.length.toLocaleString()} experiments`}
            inputRef={searchRef}
            value={query}
            onChange={(value) => {
              setQuery(value)
              setLimit(PAGE)
            }}
          />
          {query && (
            // slack's FormTextInput has no clear button
            <button
              type="button"
              className="c-button-unstyled taut-experiments__clear"
              aria-label="Clear search"
              onClick={() => applyQuery('')}
            >
              <elements.SvgIcon name="close" size={20} />
            </button>
          )}
        </div>
        {errors.map((error) => (
          <elements.InlineAlert
            key={error}
            className="taut-experiments__error c-inline_alert--level_error"
          >
            {error}
          </elements.InlineAlert>
        ))}
        <div className="taut-experiments__menus">
          {MENUS.map((menu) => (
            <this.MenuPill
              key={menu.label}
              menu={menu}
              query={query}
              applyQuery={applyQuery}
            />
          ))}
          <elements.FilterPill
            isActive={overridden}
            aria-pressed={overridden}
            onClick={() =>
              applyQuery(
                setField(query, 'override', overridden ? [] : OVERRIDDEN.tokens)
              )
            }
          >
            {count ? `${OVERRIDDEN.label} (${count})` : OVERRIDDEN.label}
          </elements.FilterPill>
        </div>
        <div className="taut-experiments__bar taut-experiments__status">
          <span className="taut-experiments__muted">
            {matches.toLocaleString()} matching
          </span>
          {needsReload && (
            <elements.Button size="small" onClick={() => location.reload()}>
              Reload to apply
            </elements.Button>
          )}
          {count > 0 && (
            <elements.Button type="outline" size="small" onClick={resetAll}>
              Reset all
            </elements.Button>
          )}
          <this.MenuPill
            menu={SORT_MENU}
            query={query}
            applyQuery={applyQuery}
            asText
          />
        </div>
        {shown.length === 0 && (
          <p className="taut-experiments__muted">No experiments match.</p>
        )}
        <ul className="taut-experiments__rows">
          {shown.slice(0, limit).map((row) => (
            <this.Row
              key={row.name}
              row={row}
              assignment={assignments[row.name]}
              override={overrides[row.name]}
              effective={effective && (effective[row.name]?.group ?? null)}
            />
          ))}
        </ul>
        {shown.length > limit && (
          <div className="taut-experiments__bar">
            <elements.Button
              type="outline"
              size="small"
              onClick={() => setLimit(limit + PAGE)}
            >
              Show more
            </elements.Button>
            <span className="taut-experiments__muted">
              {limit.toLocaleString()} of {shown.length.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    )
  }

  /** a field's pill, opening a menu of its choices */
  private readonly MenuPill = ({
    menu,
    query,
    applyQuery,
    asText,
  }: {
    menu: FieldMenu
    query: string
    applyQuery: (query: string) => void
    /** a text button instead of a pill */
    asText?: boolean
  }) => {
    const { Menu } = this.api.menu
    const { FilterPill, SvgIcon } = this.api.elements
    const tokens = tokenize(query)
    const inside = tokens.filter((token) => inField(token, menu.field)).length
    const chosen = menu.choices.find((choice) =>
      isChosen(tokens, menu.field, choice)
    )
    const label = chosen
      ? chosen.label
      : inside
        ? `${menu.label} (${inside})`
        : menu.label
    const template: MenuTemplateItem[] = [
      {
        key: 'any',
        label: menu.any ?? 'Any',
        type: 'radio',
        checked: !inside,
        click: () => applyQuery(setField(query, menu.field)),
      },
      ...menu.choices.map((choice) => ({
        key: choice.label,
        label: choice.label,
        type: 'radio' as const,
        checked: choice === chosen,
        click: () =>
          applyQuery(
            setField(query, menu.field, choice === chosen ? [] : choice.tokens)
          ),
      })),
    ]
    return (
      <Menu
        template={template}
        position={asText ? 'bottom-right' : 'bottom-left'}
      >
        {asText ? (
          <button
            type="button"
            className="c-button-unstyled taut-experiments__sort"
          >
            {menu.label}: {chosen?.label ?? menu.any}
            <SvgIcon name="caret-down" size={16} inline />
          </button>
        ) : (
          <FilterPill isActive={!!inside}>
            {label}
            <SvgIcon name="caret-down" size={16} inline />
          </FilterPill>
        )}
      </Menu>
    )
  }

  private readonly Row = React.memo(
    ({
      row,
      assignment,
      override,
      effective,
    }: {
      row: Row
      assignment: Assignment | undefined
      override: string | null | undefined
      /** the group Slack reads, which another plugin may be forcing, undefined if unknown */
      effective: string | null | undefined
    }) => {
      const { elements } = this.api
      const [custom, setCustom] = React.useState<string | null>(null)
      const assigned = assignment?.group
      const details = assignment && describeAssignment(assignment)

      const options = React.useMemo(() => {
        const groups = new Set(row.groups)
        if (typeof override === 'string') groups.add(override)
        // the leading space keeps these values apart from group names
        return [
          { label: `Default (${assigned ?? 'none'})`, value: ' default' },
          ...[...groups].map((group) => ({ label: group, value: group })),
          ...(assigned || override === null
            ? [{ label: 'Not assigned', value: ' none' }]
            : []),
          { label: 'Custom...', value: ' custom' },
        ]
      }, [row.groups, assigned, override])
      const value =
        custom !== null
          ? ' custom'
          : override === undefined
            ? ' default'
            : override === null
              ? ' none'
              : override
      const current = override === undefined ? (assigned ?? null) : override
      const commit = () => {
        const group = custom?.trim()
        if (group) this.setOverride(row.name, group)
        setCustom(null)
      }

      return (
        <li
          className={`taut-experiments__row${override !== undefined ? ' taut-experiments__row--overridden' : ''}${row.typed ? ' taut-experiments__row--typed' : ''}`}
        >
          <div>
            <div className="taut-experiments__name">
              {/* long names wrap after an underscore rather than in the middle of a word */}
              {row.name.split(/(?<=_)/).map((part, i) => (
                <React.Fragment key={i}>
                  {part}
                  <wbr />
                </React.Fragment>
              ))}
            </div>
            {details && (
              <div className="taut-experiments__assignment">{details}</div>
            )}
          </div>
          <elements.BasicSelect
            selectId={`taut-experiments__${row.name}`}
            ariaLabel={`Group for ${row.name}`}
            options={options}
            selectedOption={options.find((option) => option.value === value)}
            width={180}
            size="small"
            onSelectionChange={(option) => {
              if (option.value === ' custom') return setCustom(override ?? '')
              setCustom(null)
              this.setOverride(
                row.name,
                option.value === ' default'
                  ? undefined
                  : option.value === ' none'
                    ? null
                    : option.value
              )
            }}
          />
          {effective !== undefined && effective !== current && (
            <span className="taut-experiments__forced">
              Forced by a plugin: {effective ?? 'not assigned'}
            </span>
          )}
          {custom !== null && (
            <div className="taut-experiments__custom">
              <elements.FormTextInput
                placeholder="Group"
                value={custom}
                autoFocus
                onChange={setCustom}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit()
                }}
              />
              <elements.Button
                type="outline"
                size="medium"
                disabled={!custom.trim()}
                onClick={commit}
              >
                Set
              </elements.Button>
            </div>
          )}
        </li>
      )
    }
  )
}

/** `for:` values -> Slack's assignment `type`, plus strings */
const FOR_VALUES: Record<
  string,
  { type: string; launched: string; per: string }
> = {
  you: { type: 'user', launched: 'you', per: 'person' },
  workspace: { type: 'team', launched: 'the workspace', per: 'workspace' },
  browser: { type: 'visitor', launched: 'this browser', per: 'browser' },
}

/** why you're in your group, from Slack's `trigger` and `type` */
function describeAssignment(assignment: Assignment) {
  const { type = '', schedule_ts } = assignment
  const scope = Object.values(FOR_VALUES).find((entry) => entry.type === type)
  const how = howOf(assignment)
  const reason =
    how === 'finished'
      ? 'Finished'
      : how === 'forced'
        ? 'Forced by Slack'
        : how === 'abtest'
          ? `A/B test per ${scope?.per ?? type}`
          : how === 'launch'
            ? `Launched for ${scope?.launched ?? type}`
            : how
  if (!reason || !schedule_ts) return reason
  const date = new Date(schedule_ts * 1000)
  const label = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
  return `${reason}, scheduled ${label}`
}

/** a `how:` value for Slack's `trigger`, or the trigger itself when it's new */
function howOf(assignment: Assignment | undefined) {
  if (!assignment) return 'none'
  const { trigger = '' } = assignment
  if (trigger === 'finished') return 'finished'
  if (trigger === 'force_debug') return 'forced'
  if (trigger.startsWith('hash_')) return 'abtest'
  if (trigger.startsWith('launch_')) return 'launch'
  return trigger
}

const HOW_VALUES = ['abtest', 'launch', 'finished', 'forced', 'none']
const SORT_VALUES = ['name', 'newest', 'oldest']
/** each prefix's field */
const FIELDS = {
  how: 'how',
  for: 'for',
  group: 'group',
  override: 'override',
  since: 'scheduled',
  before: 'scheduled',
  sort: 'sort',
} as const
type Prefix = keyof typeof FIELDS
type Field = (typeof FIELDS)[Prefix]
const PREFIXES = Object.keys(FIELDS) as Prefix[]

type Experiment = {
  name: string
  assignment: Assignment | undefined
  override: string | null | undefined
}
/** a word, or a filter, that passed validation */
type Condition = {
  negated: boolean
  /** null for a word */
  prefix: Prefix | null
  value: string
  test: (experiment: Experiment) => boolean
}

type Choice = { label: string; tokens: string[] }

/** one field's choices, picked from a menu */
type FieldMenu = {
  label: string
  field: Field
  choices: Choice[]
  /** the label for no choice, "Any" by default */
  any?: string
}

const MENUS: FieldMenu[] = [
  {
    label: 'How',
    field: 'how',
    choices: [
      { label: 'A/B tests', tokens: ['how:abtest'] },
      { label: 'Launched', tokens: ['how:launch'] },
      { label: 'Finished', tokens: ['how:finished'] },
      { label: 'Forced', tokens: ['how:forced'] },
      { label: 'Not assigned', tokens: ['how:none'] },
    ],
  },
  {
    label: 'For',
    field: 'for',
    choices: [
      { label: 'Per person', tokens: ['for:you'] },
      { label: 'Per workspace', tokens: ['for:workspace'] },
      { label: 'Per browser', tokens: ['for:browser'] },
    ],
  },
  {
    label: 'Group',
    field: 'group',
    choices: [
      // any group but off's, since groups like treatment_b and enabled are on too
      {
        label: 'Turned on',
        tokens: ['group:*', '-group:off', '-group:control'],
      },
      { label: 'Turned off', tokens: ['group:off', 'group:control'] },
    ],
  },
  {
    label: 'Scheduled',
    field: 'scheduled',
    choices: [
      { label: 'Last 7 days', tokens: ['since:7d'] },
      { label: 'Last 30 days', tokens: ['since:30d'] },
      { label: 'No date', tokens: ['-since:*'] },
    ],
  },
]
const SORT_MENU: FieldMenu = {
  label: 'Sort',
  field: 'sort',
  any: 'Name',
  choices: [
    { label: 'Newest first', tokens: ['sort:newest'] },
    { label: 'Oldest first', tokens: ['sort:oldest'] },
  ],
}
const OVERRIDDEN: Choice = { label: 'Overridden', tokens: ['override:*'] }

const oneOf = (values: readonly string[]) =>
  `${values.slice(0, -1).join(', ')}, or ${values[values.length - 1]}`

const isPrefix = (prefix: string): prefix is Prefix => prefix in FIELDS

/** a piece of the query, `prefix` is null for a word and kept as typed when it isn't a prefix */
type Token = { negated: boolean; prefix: string | null; value: string }

function tokenize(query: string): Token[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      const negated = text.startsWith('-') && text.length > 1
      const body = negated ? text.slice(1) : text
      const colon = body.indexOf(':')
      if (colon === -1) return { negated, prefix: null, value: body }
      const prefix = body.slice(0, colon).toLowerCase()
      return { negated, prefix, value: body.slice(colon + 1) }
    })
}

const tokenText = ({ negated, prefix, value }: Token) =>
  `${negated ? '-' : ''}${prefix === null ? '' : `${prefix}:`}${value}`

/** filters and sort in `PREFIXES` order, then unknown prefixes, then words, ending in a space to type after */
function serialize(tokens: Token[]): string {
  const rank = ({ prefix }: Token) =>
    prefix === null
      ? PREFIXES.length + 1
      : isPrefix(prefix)
        ? PREFIXES.indexOf(prefix)
        : PREFIXES.length
  const text = tokens
    .toSorted((a, b) => rank(a) - rank(b))
    .map(tokenText)
    .join(' ')
  return text && `${text} `
}

const inField = ({ prefix }: Token, field: Field) =>
  !!prefix && isPrefix(prefix) && FIELDS[prefix] === field

/** whether the query's tokens in a field are exactly a choice's */
function isChosen(tokens: Token[], field: Field, choice: Choice) {
  const inside = tokens
    .filter((token) => inField(token, field))
    .map((token) => tokenText(token).toLowerCase())
  return (
    inside.length === choice.tokens.length &&
    choice.tokens.every((token) => inside.includes(token))
  )
}

/** the query with `tokens` in place of everything in `field` */
const setField = (query: string, field: Field, tokens: string[] = []) =>
  serialize([
    ...tokenize(query).filter((token) => !inField(token, field)),
    ...tokenize(tokens.join(' ')),
  ])

/** `7d` or `2026-01-01` as a time in ms, undefined if it's neither */
function parseTime(value: string): number | undefined {
  const days = /^(\d+)d$/i.exec(value)
  if (days) return Date.now() - Number(days[1]) * 24 * 60 * 60 * 1000
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const time = new Date(`${value}T00:00`).getTime()
  return Number.isNaN(time) ? undefined : time
}

/** `*` matches anything, and case doesn't matter */
const wildcard = (pattern: string) =>
  new RegExp(`^${RegExp.escape(pattern).replace(/\\\*/g, '.*')}$`, 'i')

const scheduled = ({ assignment }: Experiment) =>
  (assignment?.schedule_ts ?? 0) * 1000

/** a filter's test func, or a string of why it's invalid */
function parseFilter(
  prefix: Exclude<Prefix, 'sort'>,
  value: string
): Condition['test'] | string {
  switch (prefix) {
    case 'how':
      if (!HOW_VALUES.includes(value))
        return `how values must be one of ${oneOf(HOW_VALUES)}`
      return ({ assignment }) => howOf(assignment) === value
    case 'for': {
      const type = FOR_VALUES[value]?.type
      if (!type)
        return `for values must be one of ${oneOf(Object.keys(FOR_VALUES))}`
      return ({ assignment }) => assignment?.type === type
    }
    case 'group':
    case 'override': {
      if (!value)
        return `${prefix} values must be a group name, * matches anything`
      const pattern = wildcard(value)
      if (prefix === 'group')
        return ({ assignment }) =>
          !!assignment?.group && pattern.test(assignment.group)
      // `*` also matches reading as not assigned
      return ({ override }) =>
        value === '*'
          ? override !== undefined
          : typeof override === 'string' && pattern.test(override)
    }
    case 'since':
    case 'before': {
      if (value === '*') return (experiment) => !!scheduled(experiment)
      const time = parseTime(value)
      if (time === undefined)
        return `${prefix} values must be a number of days like 7d, a date like 2026-01-01, or * for any date`
      return prefix === 'since'
        ? (experiment) =>
            !!scheduled(experiment) && scheduled(experiment) >= time
        : (experiment) =>
            !!scheduled(experiment) && scheduled(experiment) < time
    }
  }
}

function parseQuery(query: string) {
  const conditions: Condition[] = []
  const errors = new Set<string>()
  let sort: string | undefined
  for (const { negated, prefix, value } of tokenize(query)) {
    const lower = value.toLowerCase()
    if (prefix === null) {
      const text = lower.replace(/-/g, '_')
      conditions.push({
        negated,
        prefix,
        value: text,
        test: ({ name }) => name.includes(text),
      })
    } else if (!isPrefix(prefix)) {
      errors.add(`Filter prefixes must be one of ${oneOf(PREFIXES)}`)
    } else if (prefix === 'sort') {
      if (negated) errors.add("sort can't be negated")
      else if (!SORT_VALUES.includes(lower))
        errors.add(`sort values must be one of ${oneOf(SORT_VALUES)}`)
      else sort = lower
    } else {
      const test = parseFilter(prefix, lower)
      if (typeof test === 'string') errors.add(test)
      else conditions.push({ negated, prefix, value: lower, test })
    }
  }
  return { conditions, sort, errors: [...errors] }
}

function matchesQuery(conditions: Condition[], experiment: Experiment) {
  return [...Map.groupBy(conditions, (condition) => condition.prefix)].every(
    ([prefix, samePrefix]) => {
      if (prefix === null)
        return samePrefix.every(
          (word) => word.test(experiment) !== word.negated
        )
      const wanted = samePrefix.filter((filter) => !filter.negated)
      return (
        (!wanted.length || wanted.some((filter) => filter.test(experiment))) &&
        !samePrefix.some((filter) => filter.negated && filter.test(experiment))
      )
    }
  )
}
